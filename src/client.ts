// Every call to the Submitator API goes through here. It adds the key, tags every
// request so an agency can tell MCP calls apart in its request log, retries
// only what is safe to repeat, and turns any failure into one ApiFailure.
import { VERSION } from './version.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

// s = stdio, h = remote HTTP. Part of the request id, so the channel survives
// in the one column the API's request log keeps.
export type Channel = 's' | 'h';

export interface FieldIssue {
  param: string;
  code: string;
  message: string;
}

export interface ApiFailure {
  status: number;
  code: string;
  message: string;
  param?: string;
  errors?: FieldIssue[];
  existing?: { id?: string; name?: string; status?: string; url?: string };
  doc_url?: string;
  request_id?: string;
  retry_after?: number;
}

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; error: ApiFailure };

export type Download =
  | { ok: true; bytes: Uint8Array; contentType: string; fileName?: string }
  | { ok: false; error: ApiFailure };

export interface ApiRequest {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  json?: unknown;
  form?: FormData;
  // Sends an Idempotency-Key and makes the request safe to retry.
  idempotent?: boolean;
}

export interface ApiClientOptions {
  baseUrl: string;
  key: string;
  channel: Channel;
  clientName?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  uuid?: () => string;
  timeoutMs?: number;
  // An end time for every request of this client (epoch ms): one tool call
  // on the remote server must finish inside the host's own time limit.
  deadlineAt?: number;
}

const MAX_ATTEMPTS = 3;
const RETRY_STATUSES = new Set([502, 503, 504]);
const MAX_RETRY_AFTER_SECONDS = 10;
const MIN_ATTEMPT_MS = 2000;
const OUT_OF_TIME: ApiFailure = {
  status: 0,
  code: 'timeout',
  message: 'The Submitator API did not answer in time. Try again in a minute.',
};

// The client's own name, cut to what the API keeps in a request id.
export function clientTag(name: string | undefined): string {
  const tag = (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 16)
    .replace(/-+$/, '');
  return tag || 'unknown';
}

export class ApiClient {
  private readonly options: ApiClientOptions;
  private readonly baseUrl: string;
  private readonly key: string;
  private readonly prefix: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly uuid: () => string;
  private readonly timeoutMs: number;
  private readonly deadlineAt: number;

  constructor(options: ApiClientOptions) {
    this.options = options;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.key = options.key;
    this.prefix = `mcp-${options.channel}-${clientTag(options.clientName)}`;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.deadlineAt = options.deadlineAt ?? Number.POSITIVE_INFINITY;
  }

  // The client's name is known only once a request arrives (2026 clients send
  // it with every request), so each call gets a copy tagged with it.
  forClient(clientName: string | undefined): ApiClient {
    return clientName === this.options.clientName ? this : new ApiClient({ ...this.options, clientName });
  }

  // A copy whose requests all end by `ms` from now, retries included.
  within(ms: number): ApiClient {
    return new ApiClient({ ...this.options, deadlineAt: Date.now() + ms });
  }

  get keyMode(): 'live' | 'test' {
    return this.key.startsWith('sbm_test_') ? 'test' : 'live';
  }

  async request<T>(request: ApiRequest): Promise<ApiResult<T>> {
    // One Idempotency-Key for every attempt: a retry after a lost answer
    // replays the earlier result instead of doing the work twice.
    const idempotencyKey = request.idempotent ? this.uuid() : undefined;
    const retryable = request.method === 'GET' || request.idempotent === true;
    let failure: ApiFailure = OUT_OF_TIME;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const left = this.deadlineAt - Date.now();
      if (left < MIN_ATTEMPT_MS) break;
      const outcome = await this.once<T>(request, idempotencyKey, Math.min(this.timeoutMs, left));
      if (outcome.ok) return outcome;
      failure = outcome.error;
      if (!retryable || attempt === MAX_ATTEMPTS || !worthRetrying(failure)) break;
      const delay = retryDelayMs(failure, attempt);
      if (Date.now() + delay + MIN_ATTEMPT_MS > this.deadlineAt) break;
      await this.sleep(delay);
    }
    return { ok: false, error: failure };
  }

  async download(path: string): Promise<Download> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), {
        method: 'GET',
        headers: this.headers('*/*'),
        signal: AbortSignal.timeout(this.timeoutMs * 2),
      });
    } catch (error) {
      return { ok: false, error: transportFailure(error) };
    }
    if (!response.ok) return { ok: false, error: await failureFrom(response) };
    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    const fileName = fileNameFrom(response.headers.get('content-disposition'));
    return fileName ? { ok: true, bytes, contentType, fileName } : { ok: true, bytes, contentType };
  }

  private async once<T>(request: ApiRequest, idempotencyKey: string | undefined, timeoutMs: number): Promise<ApiResult<T>> {
    const headers = this.headers('application/json');
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let body: string | FormData | undefined;
    if (request.form) {
      body = request.form;
    } else if (request.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(request.json);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.url(request.path, request.query), {
        method: request.method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return { ok: false, error: transportFailure(error) };
    }

    if (!response.ok) return { ok: false, error: await failureFrom(response) };
    const text = await response.text();
    if (text.trim() === '') return { ok: true, status: response.status, data: {} as T };
    try {
      return { ok: true, status: response.status, data: JSON.parse(text) as T };
    } catch {
      return {
        ok: false,
        error: { status: response.status, code: 'unavailable', message: 'The Submitator API sent an answer that is not JSON. Try again in a minute.' },
      };
    }
  }

  private headers(accept: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.key}`,
      Accept: accept,
      'User-Agent': `submitator-mcp/${VERSION}`,
      // A new id for every attempt; Rails keeps a client id as the request id.
      'X-Request-Id': `${this.prefix}-${this.uuid()}`,
    };
  }

  private url(path: string, query?: ApiRequest['query']): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
    }
    return url.toString();
  }
}

function worthRetrying(failure: ApiFailure): boolean {
  if (failure.retry_after !== undefined && failure.retry_after > MAX_RETRY_AFTER_SECONDS) return false;
  if (failure.code === 'network_error' || failure.code === 'timeout') return true;
  if (RETRY_STATUSES.has(failure.status)) return true;
  return failure.status === 409 && failure.code === 'idempotency_key_in_use';
}

function retryDelayMs(failure: ApiFailure, attempt: number): number {
  if (failure.retry_after !== undefined && failure.retry_after <= MAX_RETRY_AFTER_SECONDS) {
    return failure.retry_after * 1000;
  }
  if (failure.code === 'idempotency_key_in_use') return 1000;
  return 500 * attempt;
}

// Never echo the error itself: it can carry the URL, and a future runtime
// might put headers in it.
function transportFailure(error: unknown): ApiFailure {
  const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
  return timedOut
    ? { status: 0, code: 'timeout', message: 'The Submitator API did not answer in time. Try again in a minute.' }
    : { status: 0, code: 'network_error', message: 'Could not reach the Submitator API. Check the connection and try again.' };
}

async function failureFrom(response: Response): Promise<ApiFailure> {
  const retryAfter = seconds(response.headers.get('retry-after'));
  const requestId = response.headers.get('x-request-id') ?? undefined;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const envelope = (body as { error?: Record<string, unknown> } | undefined)?.error;
  if (envelope && typeof envelope.code === 'string') {
    return compact({
      status: response.status,
      code: envelope.code,
      message: typeof envelope.message === 'string' ? envelope.message : '',
      param: typeof envelope.param === 'string' ? envelope.param : undefined,
      errors: fieldIssues(envelope.errors),
      existing: existingProject(envelope.existing),
      doc_url: typeof envelope.doc_url === 'string' ? envelope.doc_url : undefined,
      request_id: typeof envelope.request_id === 'string' ? envelope.request_id : requestId,
      retry_after: retryAfter,
    });
  }
  if (response.status >= 500) {
    return compact({
      status: response.status,
      code: 'unavailable',
      message: 'The Submitator API is unavailable. Try again in a minute.',
      request_id: requestId,
      retry_after: retryAfter,
    });
  }
  return compact({
    status: response.status,
    code: `http_${response.status}`,
    message: `The Submitator API answered HTTP ${response.status}.`,
    request_id: requestId,
  });
}

function fieldIssues(value: unknown): FieldIssue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      param: String(item.param ?? ''),
      code: String(item.code ?? ''),
      message: String(item.message ?? ''),
    }));
}

// The API sends the whole conflicting project; the model needs only enough to find it.
function existingProject(value: unknown): ApiFailure['existing'] {
  if (typeof value !== 'object' || value === null) return undefined;
  const project = value as Record<string, unknown>;
  return compact({
    id: typeof project.id === 'string' ? project.id : undefined,
    name: typeof project.name === 'string' ? project.name : undefined,
    status: typeof project.status === 'string' ? project.status : undefined,
    url: typeof project.url === 'string' ? project.url : undefined,
  });
}

function seconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.ceil(parsed) : undefined;
}

function fileNameFrom(disposition: string | null): string | undefined {
  if (!disposition) return undefined;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      return undefined;
    }
  }
  return /filename="?([^";]+)"?/i.exec(disposition)?.[1];
}

function compact<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}
