import { describe, expect, it } from 'vitest';
import { ApiClient, clientTag } from '../src/client.js';
import { describeFailure } from '../src/result.js';
import { contract, json, operations, TEST_KEY } from './helpers.js';

function client(respond: (request: Request, attempt: number) => Response | Promise<Response>) {
  const calls: Request[] = [];
  const sleeps: number[] = [];
  let attempt = 0;
  const api = new ApiClient({
    baseUrl: 'https://api.submitator.com/v1',
    key: TEST_KEY,
    channel: 's',
    clientName: 'Claude Code',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push(request);
      attempt += 1;
      return respond(request, attempt);
    }) as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { api, calls, sleeps };
}

describe('ApiClient headers', () => {
  it('sends the key, a tagged request id and our user agent', async () => {
    const { api, calls } = client(() => json({ ok: true }));
    await api.request({ method: 'GET', path: '/ping' });
    const [call] = calls;
    expect(call?.headers.get('authorization')).toBe(`Bearer ${TEST_KEY}`);
    expect(call?.headers.get('user-agent')).toMatch(/^submitator-mcp\/\d+\.\d+\.\d+$/);
    expect(call?.headers.get('x-request-id')).toMatch(/^mcp-s-claude-code-[0-9a-f-]{36}$/);
    expect(call?.headers.get('idempotency-key')).toBeNull();
  });

  it('keeps request ids within what the API stores', () => {
    expect(clientTag('Claude Code')).toBe('claude-code');
    expect(clientTag('Visual Studio Code - Insiders')).toBe('visual-studio-co');
    expect(clientTag(undefined)).toBe('unknown');
    expect(clientTag('///')).toBe('unknown');
  });

  it('sends JSON bodies and an Idempotency-Key only when asked', async () => {
    const { api, calls } = client(() => json({ id: 'x' }, 201));
    await api.request({ method: 'POST', path: '/projects', json: { url: 'https://a.test' }, idempotent: true });
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
    expect(calls[0]?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await calls[0]?.json()).toEqual({ url: 'https://a.test' });
  });

  it('drops empty query values', async () => {
    const { api, calls } = client(() => json({ data: [] }));
    await api.request({ method: 'GET', path: '/projects', query: { q: undefined, status: null, limit: 20, cursor: '' } });
    expect(new URL(calls[0]?.url ?? '').search).toBe('?limit=20');
  });
});

describe('ApiClient retries', () => {
  it('retries a GET after 503 with a new request id', async () => {
    const { api, calls } = client((_request, attempt) => (attempt === 1 ? json({}, 503) : json({ ok: true })));
    const result = await api.request({ method: 'GET', path: '/ping' });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers.get('x-request-id')).not.toBe(calls[1]?.headers.get('x-request-id'));
  });

  it('retries an idempotent write with the same Idempotency-Key', async () => {
    const { api, calls } = client((_request, attempt) => {
      if (attempt === 1) throw new TypeError('fetch failed');
      return json({ id: 'prj' }, 201);
    });
    const result = await api.request({ method: 'POST', path: '/projects', json: {}, idempotent: true });
    expect(result.ok).toBe(true);
    expect(calls[0]?.headers.get('idempotency-key')).toBe(calls[1]?.headers.get('idempotency-key'));
  });

  it('never retries a write without an Idempotency-Key', async () => {
    const { api, calls } = client(() => json({}, 503));
    const result = await api.request({ method: 'POST', path: '/projects/x/screenshots', json: { url: 'https://a.test/x.png' } });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('waits a second when the same request is still running', async () => {
    const busy = { error: { code: 'idempotency_key_in_use', message: 'Retry in 1 second.' } };
    const { api, sleeps } = client((_request, attempt) => (attempt === 1 ? json(busy, 409) : json({ ok: true }, 202)));
    const result = await api.request({ method: 'POST', path: '/projects/x/launch', json: {}, idempotent: true });
    expect(result.ok).toBe(true);
    expect(sleeps).toEqual([1000]);
  });

  it('follows a short Retry-After and gives up after three attempts', async () => {
    const { api, calls, sleeps } = client(() => json({}, 503, { 'retry-after': '2' }));
    const result = await api.request({ method: 'GET', path: '/ping' });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it('does not retry a rate limit', async () => {
    const limited = { error: { code: 'rate_limited', message: 'Too many requests.' } };
    const { api, calls } = client(() => json(limited, 429, { 'retry-after': '120' }));
    const result = await api.request({ method: 'GET', path: '/ping' });
    expect(calls).toHaveLength(1);
    expect(result.ok ? undefined : result.error.retry_after).toBe(120);
  });
});

describe('ApiClient failures', () => {
  it('keeps everything the model needs from the error envelope', async () => {
    const envelope = {
      error: {
        code: 'project_exists',
        message: 'A project with this URL exists.',
        param: 'url',
        errors: [{ param: 'url', code: 'invalid', message: 'Taken.' }],
        existing: { id: 'prj_1', name: 'Acme', status: 'draft', url: 'https://acme.test', tagline: 'dropped', screenshots: [] },
        doc_url: 'https://submitator.com/docs/errors#project_exists',
        request_id: 'mcp-s-x-1',
      },
    };
    const { api } = client(() => json(envelope, 409));
    const result = await api.request({ method: 'POST', path: '/projects', json: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      status: 409,
      code: 'project_exists',
      message: 'A project with this URL exists.',
      param: 'url',
      errors: [{ param: 'url', code: 'invalid', message: 'Taken.' }],
      existing: { id: 'prj_1', name: 'Acme', status: 'draft', url: 'https://acme.test' },
      doc_url: 'https://submitator.com/docs/errors#project_exists',
      request_id: 'mcp-s-x-1',
    });
  });

  it('turns an edge error page into unavailable', async () => {
    const { api } = client(() => new Response('<html>Bad gateway</html>', { status: 502, headers: { 'x-request-id': 'edge-1' } }));
    const result = await api.request({ method: 'POST', path: '/projects/x/screenshots', json: {} });
    expect(result.ok ? undefined : result.error).toMatchObject({ status: 502, code: 'unavailable', request_id: 'edge-1' });
  });

  it('never echoes a network error, which can carry the URL', async () => {
    const { api } = client(() => {
      throw new TypeError(`fetch failed: https://api.submitator.com/v1/ping?key=${TEST_KEY}`);
    });
    const result = await api.request({ method: 'GET', path: '/ping' });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('sbm_');
    expect(JSON.stringify(result)).not.toContain('api.submitator.com');
  });

  it('reads the file name of a download', async () => {
    const { api } = client(
      () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="acme-report.pdf"' } }),
    );
    const result = await api.download('/reports/rep_1/file');
    expect(result).toMatchObject({ ok: true, contentType: 'application/pdf', fileName: 'acme-report.pdf' });
  });
});

// Every error example in the contract, as the API sends it, must reach the
// model with its code, message, field errors and conflicting project.
describe('every error example in the contract', () => {
  const cases: Array<{ name: string; status: number; body: any }> = [];
  for (const { op } of operations()) {
    for (const [status, response] of Object.entries<any>(op.responses)) {
      if (!/^[45]/.test(status)) continue;
      const media = response.content?.['application/json'] ?? resolveResponse(response)?.content?.['application/json'];
      const examples = media?.examples ? Object.values<any>(media.examples).map((item) => item.value) : media?.example ? [media.example] : [];
      for (const body of examples) cases.push({ name: `${op.operationId} ${status} ${body?.error?.code}`, status: Number(status), body });
    }
  }

  it('covers the error examples', () => {
    expect(cases.length).toBeGreaterThan(40);
  });

  it.each(cases)('$name', async ({ status, body }) => {
    const { api } = client(() => json(body, status));
    const result = await api.request({ method: 'GET', path: '/x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = describeFailure(result.error);
    expect(text).toContain(body.error.code);
    expect(text).toContain(body.error.message);
    for (const issue of body.error.errors ?? []) expect(text).toContain(issue.param);
    if (body.error.existing) expect(text).toContain(body.error.existing.id);
    if (body.error.request_id) expect(text).toContain(body.error.request_id);
  });
});

function resolveResponse(response: any): any {
  const ref: string | undefined = response?.$ref;
  if (!ref) return undefined;
  return contract.components.responses[ref.split('/').pop() as string];
}
