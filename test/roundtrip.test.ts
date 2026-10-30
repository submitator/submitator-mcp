// The whole protocol path, through the SDK's own client: a 2026 client over
// Streamable HTTP, a 2025 client with raw JSON-RPC, and the remote guards.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { createRemoteHandler } from '../src/http.js';
import { example, json, LIVE_KEY, TEST_KEY } from './helpers.js';

const ENDPOINT = 'https://mcp.submitator.com/mcp';

function upstream() {
  const calls: Request[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(request);
    const path = new URL(request.url).pathname;
    if (path === '/v1/ping') return json(example('getPing'));
    if (path === '/v1/account') return json(example('getAccount'));
    return json({ error: { code: 'route_not_found', message: path } }, 404);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

async function connect(headers: Record<string, string> = {}, options: { modern?: boolean; name?: string } = {}) {
  const api = upstream();
  const remote = createRemoteHandler({ allowedHosts: ['mcp.submitator.com'], fetch: api.fetch });
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: (url, init) => remote(new Request(url, init)),
    requestInit: { headers },
  });
  const client = new Client(
    { name: options.name ?? 'Claude Code', version: '9.9.9' },
    options.modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  await client.connect(transport);
  return { client, api };
}

describe('a 2026 client over HTTP', () => {
  it('negotiates 2026-07-28, lists the live tools without a key and explains how to get one', async () => {
    const { client } = await connect({}, { modern: true });
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('launch_project');
    expect(names).toContain('create_share_link');
    expect(names).not.toContain('save_report_file');
    expect(names).not.toContain('advance_test_listing');
    expect(client.getInstructions()).toContain('preview_launch');
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('agency console');
    await client.close();
  });

  it('forwards the key as a Bearer token and tags the request with the client name it sends', async () => {
    const { client, api } = await connect({ Authorization: `Bearer ${TEST_KEY}`, 'User-Agent': 'ua-only/1.0' }, { modern: true, name: 'Envelope Name' });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('advance_test_listing');
    expect(names).not.toContain('create_share_link');
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ mode: 'test' });
    expect(api.calls[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_KEY}`);
    expect(api.calls[0]?.headers.get('x-request-id')).toMatch(/^mcp-h-envelope-name-/);
    await client.close();
  });

  it('rejects bad arguments before any API call', async () => {
    const { client, api } = await connect({ Authorization: `Bearer ${TEST_KEY}` }, { modern: true });
    const result = await client.callTool({ name: 'get_project', arguments: { project_id: 'not-an-id' } });
    expect(result.isError).toBe(true);
    expect(api.calls).toHaveLength(0);
    await client.close();
  });
});

describe('a 2025 client over HTTP', () => {
  it('works statelessly, and is named by its User-Agent', async () => {
    const { client, api } = await connect({ Authorization: `Bearer ${TEST_KEY}`, 'User-Agent': 'ua-only/1.0' });
    expect(client.getNegotiatedProtocolVersion()).not.toBe('2026-07-28');
    expect((await client.callTool({ name: 'whoami', arguments: {} })).isError).toBeFalsy();
    expect(api.calls[0]?.headers.get('x-request-id')).toMatch(/^mcp-h-ua-only-/);
    await client.close();
  });

  it('does not take an HTTP library for the client', async () => {
    const { client, api } = await connect({ Authorization: `Bearer ${TEST_KEY}`, 'User-Agent': 'node' });
    await client.callTool({ name: 'whoami', arguments: {} });
    expect(api.calls[0]?.headers.get('x-request-id')).toMatch(/^mcp-h-unknown-/);
    await client.close();
  });

  it('accepts the key as X-API-Key, for gateways that keep Authorization', async () => {
    const { client, api } = await connect({ 'X-API-Key': LIVE_KEY });
    expect((await client.callTool({ name: 'whoami', arguments: {} })).isError).toBeFalsy();
    expect(api.calls[0]?.headers.get('authorization')).toBe(`Bearer ${LIVE_KEY}`);
    await client.close();
  });
});

describe('a 2025 client with raw JSON-RPC', () => {
  const remote = createRemoteHandler({ allowedHosts: ['mcp.submitator.com'], fetch: upstream().fetch });
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    remote(
      new Request(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify(body),
      }),
    );

  it('answers initialize and tools/list without a key, as registries probe', async () => {
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } });
    expect(init.status).toBe(200);
    expect((await message(init)).result.serverInfo.name).toBe('submitator');
    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-protocol-version': '2025-06-18' });
    expect(list.status).toBe(200);
    expect((await message(list)).result.tools.length).toBeGreaterThan(15);
  });
});

// A stateless 2025 exchange answers as an event stream with one message.
async function message(response: Response): Promise<any> {
  const text = await response.text();
  if (text.trimStart().startsWith('{')) return JSON.parse(text);
  const data = text.split('\n').find((line) => line.startsWith('data:'));
  return JSON.parse((data ?? '').slice(5));
}

describe('remote guards', () => {
  const remote = createRemoteHandler({ allowedHosts: ['mcp.submitator.com'] });

  it('serves only its own host', async () => {
    expect((await remote(new Request('https://evil.example/mcp', { method: 'POST' }))).status).toBe(421);
  });

  it('refuses requests from web pages', async () => {
    const response = await remote(new Request(ENDPOINT, { method: 'POST', headers: { origin: 'https://evil.example' } }));
    expect(response.status).toBe(403);
  });

  it('knows only /mcp (and /api/mcp, the path behind the rewrite)', async () => {
    expect((await remote(new Request('https://mcp.submitator.com/'))).status).toBe(404);
    expect((await remote(new Request('https://mcp.submitator.com/health'))).status).toBe(404);
  });

  it('refuses a JSON-RPC batch, which would multiply API calls', async () => {
    const one = { jsonrpc: '2.0', method: 'tools/call', params: { name: 'whoami', arguments: {} } };
    const batch = Array.from({ length: 100 }, (_, index) => ({ ...one, id: index }));
    const response = await remote(
      new Request(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TEST_KEY}` },
        body: JSON.stringify(batch),
      }),
    );
    expect(response.status).toBe(400);
  });

  it('refuses a body over 256 KB', async () => {
    const response = await remote(
      new Request(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(300 * 1024) }),
    );
    expect(response.status).toBe(413);
  });

  it('keeps no sessions: GET on /mcp is not allowed', async () => {
    expect((await remote(new Request(ENDPOINT, { method: 'GET', headers: { accept: 'text/event-stream' } }))).status).toBe(405);
  });
});
