// The remote entry: stateless Streamable HTTP. Every request builds a fresh
// server from its own key; nothing is stored between requests, and the key
// only ever travels on to our API.
import { createMcpHandler, readRequestBody } from '@modelcontextprotocol/server';
import { DEFAULT_API_URL } from './config.js';
import { keyFromHeaders } from './key.js';
import { type AccessKeyRing, challenge, protectedResourceMetadata, readAccessToken } from './oauth.js';
import { createServer } from './server.js';

export interface RemoteOptions {
  // Hosts this deployment answers for: mcp.submitator.com in production.
  allowedHosts: readonly string[];
  fetch?: typeof fetch;
  onError?: (error: unknown) => void;
  // OAuth for clients that connect only through it (src/oauth.ts); without
  // a ring the server takes agency keys only.
  oauth?: AccessKeyRing | null;
  // Seconds since the epoch, for token expiry; tests set it.
  now?: () => number;
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

  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

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

    const gate = options.oauth ? oauthGate(request.headers, parsedBody, options.oauth, now()) : { kind: 'key' as const };
    if (gate.kind === 'challenge') return unauthorized(gate.reason);
    if (gate.kind === 'key') return handler.fetch(new Request(request, { body: body.text }), { parsedBody });

    // An OAuth client: the server below sees the key the token carries, as
    // if the client had sent it, and the token goes no further.
    const headers = new Headers(request.headers);
    headers.set('authorization', `Bearer ${gate.key}`);
    headers.delete('x-api-key');
    const response = await handler.fetch(new Request(request, { headers, body: body.text }), { parsedBody });
    return isToolCall(parsedBody) ? revokedKeyAsUnauthorized(response) : response;
  };
}

// GET /.well-known/oauth-protected-resource and .../mcp (RFC 9728), behind
// their own Vercel function: public metadata, readable from anywhere.
export function createMetadataHandler(options: Pick<RemoteOptions, 'allowedHosts'>): (request: Request) => Promise<Response> {
  const hosts = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
  return async (request) => {
    const url = new URL(request.url);
    const host = (request.headers.get('host') ?? url.host).toLowerCase();
    if (!hosts.has(host)) return plain(421, 'This host is not served here.');
    if (request.method !== 'GET') return plain(405, 'Only GET.');
    return new Response(JSON.stringify(protectedResourceMetadata()), {
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' },
    });
  };
}

type Gate = { kind: 'key' } | { kind: 'token'; key: string } | { kind: 'challenge'; reason?: 'invalid' | 'expired' };

// An agency key keeps the key path. A Bearer value that is not a key must be
// one of our access tokens. With no credential at all, listing still works
// (registries and clients probe it) and a tool call asks the client to sign
// in: an HTTP 401 with WWW-Authenticate, which is what starts sign-in.
function oauthGate(headers: Headers, body: unknown, ring: AccessKeyRing, nowSeconds: number): Gate {
  if (keyFromHeaders(headers).ok) return { kind: 'key' };
  const authorization = headers.get('authorization')?.trim() ?? '';
  const bearer = /^bearer\s+(\S+)$/i.exec(authorization)?.[1];
  if (bearer && !bearer.startsWith('sbm_')) {
    const check = readAccessToken(bearer, ring, nowSeconds);
    return check.ok ? { kind: 'token', key: check.key.key } : { kind: 'challenge', reason: check.reason };
  }
  if (!authorization && !headers.get('x-api-key') && isToolCall(body)) return { kind: 'challenge' };
  return { kind: 'key' };
}

function isToolCall(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as { method?: unknown }).method === 'tools/call';
}

// The key behind a token was revoked in the console: the client hears 401 and
// signs in again, instead of a tool error the person would have to read.
async function revokedKeyAsUnauthorized(response: Response): Promise<Response> {
  const text = await response.text();
  const message = messageOf(text) as { result?: { isError?: boolean; content?: Array<{ text?: unknown }> } } | null;
  const first = message?.result?.isError ? message.result.content?.[0]?.text : undefined;
  if (typeof first === 'string' && first.startsWith('api_key_invalid')) return unauthorized('invalid');
  return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
}

// A JSON body, or the one message of a stateless event stream.
function messageOf(text: string): unknown {
  const trimmed = text.trimStart();
  const data = trimmed.startsWith('{') ? trimmed : text.split('\n').find((line) => line.startsWith('data:'))?.slice(5);
  try {
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}

function unauthorized(reason?: 'invalid' | 'expired'): Response {
  const body = reason
    ? { error: 'invalid_token', error_description: reason === 'expired' ? 'The access token expired.' : 'The access token is not valid.' }
    : { error: 'unauthorized', error_description: 'Sign in to Submitator to use this tool.' };
  return new Response(JSON.stringify(body), {
    status: 401,
    headers: { 'content-type': 'application/json', 'www-authenticate': challenge(reason) },
  });
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
