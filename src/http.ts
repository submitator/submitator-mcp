// The remote entry: stateless Streamable HTTP. Every request builds a fresh
// server from its own key; nothing is stored between requests, and the key
// only ever travels on to our API.
import { createMcpHandler, readRequestBody } from '@modelcontextprotocol/server';
import { DEFAULT_API_URL } from './config.js';
import { keyFromHeaders } from './key.js';
import { createServer } from './server.js';

export interface RemoteOptions {
  // Hosts this deployment answers for: mcp.submitator.com in production.
  allowedHosts: readonly string[];
  fetch?: typeof fetch;
  onError?: (error: unknown) => void;
}

// A tool call is a few hundred bytes; the largest is a project with its texts.
const MAX_BODY_BYTES = 256 * 1024;

export function createRemoteHandler(options: RemoteOptions): (request: Request) => Promise<Response> {
  const hosts = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
  const handler = createMcpHandler(
    ({ requestInfo }) =>
      createServer({
        transport: 'http',
        key: requestInfo ? keyFromHeaders(requestInfo.headers) : { ok: false, reason: 'missing' },
        ...productOf(requestInfo?.headers.get('user-agent')),
        // Never from the request or the environment: the key goes nowhere else.
        apiUrl: DEFAULT_API_URL,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.onError ? { onError: options.onError } : {}),
      }),
    {
      maxRequestBodySize: MAX_BODY_BYTES,
      ...(options.onError ? { onerror: options.onError } : {}),
    },
  );

  return async (request) => {
    const url = new URL(request.url);
    const host = (request.headers.get('host') ?? url.host).toLowerCase();
    // Guards against DNS rebinding: only our own host names are served.
    if (!hosts.has(host)) return plain(421, 'This host is not served here.');
    // MCP clients call from servers and desktops, never from a web page.
    if (request.headers.get('origin')) return plain(403, 'Requests from web pages are not accepted.');
    // On Vercel the rewrite may show the function's own path.
    if (url.pathname !== '/mcp' && url.pathname !== '/api/mcp') return plain(404, 'Not found. The MCP endpoint is /mcp.');
    if (request.method !== 'POST') return handler.fetch(request);

    // One message per request: a 2025 batch would turn one request into a
    // hundred API calls, and batching left the protocol in 2025-06-18.
    const body = await readRequestBody(request, MAX_BODY_BYTES);
    if (body.tooLarge) return plain(413, 'The request body is too large.');
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(body.text);
    } catch {
      return handler.fetch(new Request(request, { body: body.text }));
    }
    if (Array.isArray(parsedBody)) return plain(400, 'Batched JSON-RPC messages are not accepted: send one message per request.');
    return handler.fetch(new Request(request, { body: body.text }), { parsedBody });
  };
}

// HTTP libraries name themselves, not the app: no use as a client name.
const LIBRARIES = new Set(['node', 'undici', 'node-fetch', 'bun', 'deno', 'python-httpx', 'python-requests', 'axios', 'go-http-client', 'okhttp', 'curl', 'mozilla']);

// "claude-code/2.1.0 (darwin)" names the app as claude-code.
function productOf(userAgent: string | null | undefined): { clientHint?: string } {
  const product = userAgent?.trim().split(/[\s/]/)[0];
  return product && !LIBRARIES.has(product.toLowerCase()) ? { clientHint: product } : {};
}

function plain(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
