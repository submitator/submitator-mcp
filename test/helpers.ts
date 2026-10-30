import { readFileSync } from 'node:fs';
import { ApiClient } from '../src/client.js';
import type { KeyMode } from '../src/key.js';
import { type Confirm, neverAsk } from '../src/tools/consent.js';
import type { ToolContext, Transport } from '../src/tools/types.js';

export const contract = JSON.parse(readFileSync(new URL('../openapi/v1.json', import.meta.url), 'utf8'));

export const TEST_KEY = `sbm_test_${'a'.repeat(8)}_${'b'.repeat(43)}`;
export const LIVE_KEY = `sbm_live_${'c'.repeat(8)}_${'d'.repeat(43)}`;

type Operation = { operationId: string; responses: Record<string, any>; parameters?: any[]; requestBody?: any };

export function operations(): Array<{ method: string; path: string; op: Operation }> {
  const list: Array<{ method: string; path: string; op: Operation }> = [];
  for (const [path, item] of Object.entries<any>(contract.paths)) {
    for (const [method, op] of Object.entries<any>(item)) {
      if (op && typeof op === 'object' && op.operationId) list.push({ method: method.toUpperCase(), path, op });
    }
  }
  return list;
}

export function operation(operationId: string) {
  const found = operations().find((entry) => entry.op.operationId === operationId);
  if (!found) throw new Error(`no operation ${operationId}`);
  return found;
}

// The example response of an operation, deep-copied so tests can change it.
export function example(operationId: string, status?: string): any {
  const { op } = operation(operationId);
  const code = status ?? Object.keys(op.responses).find((key) => key.startsWith('2'));
  const media = op.responses[code as string]?.content?.['application/json'];
  const value = media?.example ?? Object.values<any>(media?.examples ?? {})[0]?.value;
  if (value === undefined) throw new Error(`no example for ${operationId} ${code}`);
  return structuredClone(value);
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export interface Route {
  method: string;
  path: RegExp;
  respond: (request: Request) => Response | Promise<Response>;
}

export function fakeFetch(routes: Route[]) {
  const calls: Request[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(request.clone());
    const url = new URL(request.url);
    const route = routes.find((item) => item.method === request.method && item.path.test(url.pathname));
    if (!route) return json({ error: { code: 'route_not_found', message: `no fake for ${request.method} ${url.pathname}` } }, 404);
    return route.respond(request);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

export function context(
  routes: Route[],
  options: { mode?: KeyMode; transport?: Transport; files?: ToolContext['files']; confirm?: Confirm } = {},
) {
  const mode = options.mode ?? 'test';
  const fake = fakeFetch(routes);
  const api = new ApiClient({
    baseUrl: 'https://api.submitator.com/v1',
    key: mode === 'test' ? TEST_KEY : LIVE_KEY,
    channel: (options.transport ?? 'stdio') === 'stdio' ? 's' : 'h',
    clientName: 'vitest',
    fetch: fake.fetch,
    sleep: async () => {},
  });
  const ctx: ToolContext = {
    api,
    mode,
    transport: options.transport ?? 'stdio',
    files: options.files,
    confirm: options.confirm ?? neverAsk,
  };
  return { ctx, calls: fake.calls };
}

// Tool results as tests read them (an input-required result has no content).
export type Out = { content?: Array<{ type: string; text?: string }>; structuredContent?: any; isError?: boolean };

export function out(result: unknown): Out {
  return result as Out;
}

export function textOf(result: unknown): string {
  return (out(result).content ?? []).map((block) => block.text ?? '').join('\n');
}
