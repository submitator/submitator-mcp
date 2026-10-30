// OAuth on the remote server: access tokens from Submitator's API (compact JWE,
// dir + A256GCM), the 401 that starts sign-in, the token swapped for the key
// it carries, and a revoked key turned back into a 401.
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createMetadataHandler, createRemoteHandler } from '../src/http.js';
import { AccessKeyRing, ISSUER, RESOURCE, RESOURCE_METADATA_URL, readAccessToken, ringFromEnv } from '../src/oauth.js';
import { example, json, TEST_KEY } from './helpers.js';

const ENDPOINT = 'https://mcp.submitator.com/mcp';
const KEY = Buffer.alloc(32, 'k');
const OTHER = Buffer.alloc(32, 'o');
const NOW = 1_900_000_000;

// Made by the API's own encoder (its test holds the same string): both sides
// read the same bytes.
const VECTOR =
  'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIiwia2lkIjoiWGpHUGpQbkwiLCJ0eXAiOiJtY3AtYXQifQ..-XcrABx65Cn6x3jM.' +
  '9kVwoUD2pTMCm6Lfs_3sQ0gwaygJCv9xX_oH5UF387w5T44JPfuc2kLcU6clt3t9pAtQS7wRkZTtoiH50xkldClB4sYCDaOaE9SDBMD4ORp3nXUGbukzuA-_' +
  'YskvWEmtjcoxxGZE6y4iIOyFeU3ugoM47lWUAzy8mKodD6lXTLacSgiqylC9FigyQTV8icFsq-kmXGhwTs1o8nsIJCvNP5mW.j5A8Zp6cL9d3JDQWJr0XPg';

// The API's side, for tests only: the server here never makes a token.
function seal(payload: Record<string, unknown>, key = KEY, typ = 'mcp-at'): string {
  const kid = createHash('sha256').update(key).digest('base64url').slice(0, 8);
  const header = Buffer.from(JSON.stringify({ alg: 'dir', enc: 'A256GCM', kid, typ })).toString('base64url');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(header, 'ascii'));
  const body = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return [header, '', iv.toString('base64url'), body.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

function accessToken(changes: Record<string, unknown> = {}): string {
  return seal({ iss: ISSUER, aud: RESOURCE, key: TEST_KEY, exp: NOW + 3600, ...changes });
}

const ring = new AccessKeyRing([KEY]);

describe('access tokens', () => {
  it('open the API-made vector', () => {
    expect(ring.open(VECTOR)).toEqual({
      iss: 'https://api.submitator.com',
      aud: 'https://mcp.submitator.com/mcp',
      key: `sbm_test_AbCdEfGh_${'x'.repeat(43)}`,
      exp: 4_102_444_800,
    });
  });

  it('refuse a changed byte, another typ, an unknown key or a cut tag', () => {
    const token = accessToken();
    const parts = token.split('.');
    for (const index of [0, 2, 3, 4]) {
      const changed = [...parts];
      // The first character: the last one of a base64url part may carry only unused bits.
      changed[index] = (changed[index]!.startsWith('A') ? 'B' : 'A') + changed[index]!.slice(1);
      expect(ring.open(changed.join('.'))).toBeNull();
    }
    expect(ring.open(seal({ key: TEST_KEY }, KEY, 'mcp-rt'))).toBeNull();
    expect(ring.open(seal({ key: TEST_KEY }, OTHER))).toBeNull();
    expect(ring.open(`${parts.slice(0, 4).join('.')}.${parts[4]!.slice(0, 10)}`)).toBeNull();
    expect(ring.open('a.b.c')).toBeNull();
    expect(ring.open(`${token}=`)).toBeNull();
  });

  it('come from a ring that reads old keys too', () => {
    expect(new AccessKeyRing([OTHER, KEY]).open(accessToken())).not.toBeNull();
  });

  it('are checked for issuer, audience, expiry and a whole key', () => {
    expect(readAccessToken(accessToken(), ring, NOW)).toMatchObject({ ok: true, key: { key: TEST_KEY, mode: 'test' } });
    expect(readAccessToken(accessToken({ exp: NOW }), ring, NOW)).toEqual({ ok: false, reason: 'expired' });
    expect(readAccessToken(accessToken({ iss: 'https://evil.example' }), ring, NOW)).toEqual({ ok: false, reason: 'invalid' });
    expect(readAccessToken(accessToken({ aud: 'https://other.example/mcp' }), ring, NOW)).toEqual({ ok: false, reason: 'invalid' });
    expect(readAccessToken(accessToken({ key: 'sbm_test_short' }), ring, NOW)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('a key that does not parse switches OAuth off, and says so once', () => {
    const errors: unknown[] = [];
    expect(ringFromEnv(`${KEY.toString('base64url')}=`, (error) => errors.push(error))).toBeNull();
    expect(errors).toHaveLength(1);
    expect(ringFromEnv(KEY.toString('base64url'))).toBeInstanceOf(AccessKeyRing);
    expect(ringFromEnv(undefined)).toBeNull();
  });

  it('keys come from the environment, and a bad one fails at start', () => {
    expect(AccessKeyRing.fromEnv(undefined)).toBeNull();
    expect(AccessKeyRing.fromEnv(' , ')).toBeNull();
    expect(AccessKeyRing.fromEnv(`${KEY.toString('base64url')}, ${OTHER.toString('base64url')}`)).toBeInstanceOf(AccessKeyRing);
    expect(() => AccessKeyRing.fromEnv('c2hvcnQ')).toThrow();
    expect(() => AccessKeyRing.fromEnv('not base64!')).toThrow();
  });
});

describe('the remote server with OAuth on', () => {
  function upstream(answer?: (request: Request) => Response) {
    const calls: Request[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push(request);
      if (answer) return answer(request);
      const path = new URL(request.url).pathname;
      if (path === '/v1/ping') return json(example('getPing'));
      if (path === '/v1/account') return json(example('getAccount'));
      return json({ error: { code: 'route_not_found', message: path } }, 404);
    }) as typeof fetch;
    return { fetch: fetchImpl, calls };
  }

  function remoteWith(api = upstream()) {
    return { api, remote: createRemoteHandler({ allowedHosts: ['mcp.submitator.com'], fetch: api.fetch, oauth: ring, now: () => NOW }) };
  }

  const call = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } };
  const post = (remote: (request: Request) => Promise<Response>, body: unknown, headers: Record<string, string> = {}) =>
    remote(
      new Request(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...headers },
        body: JSON.stringify(body),
      }),
    );

  it('asks a tool call without credentials to sign in, before anything runs', async () => {
    const { api, remote } = remoteWith();
    const response = await post(remote, call);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${RESOURCE_METADATA_URL}", scope="mcp"`);
    expect(api.calls).toHaveLength(0);
  });

  it('still lists without credentials', async () => {
    const { remote } = remoteWith();
    const list = await post(remote, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.status).toBe(200);
  });

  it('runs a tool with the key the token carries, and never sends the token on', async () => {
    const { api, remote } = remoteWith();
    const token = accessToken();
    const response = await post(remote, call, { authorization: `Bearer ${token}` });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('"isError":true');
    expect(api.calls[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_KEY}`);
    const sent: string[] = [];
    for (const request of api.calls) request.headers.forEach((value) => sent.push(value));
    expect(sent.some((value) => value.includes(token))).toBe(false);
  });

  it('refuses an expired, foreign or broken token with invalid_token', async () => {
    const { api, remote } = remoteWith();
    for (const [token, description] of [
      [accessToken({ exp: NOW - 1 }), 'expired'],
      [accessToken({ aud: 'https://other.example/mcp' }), 'not valid'],
      ['garbage.token', 'not valid'],
    ] as const) {
      const response = await post(remote, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { authorization: `Bearer ${token}` });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
      expect(response.headers.get('www-authenticate')).toContain(description);
    }
    expect(api.calls).toHaveLength(0);
  });

  it('turns a revoked key behind a token into a 401, but not a revoked key sent as is', async () => {
    const revoked = () => json({ error: { code: 'api_key_invalid', message: 'The key is revoked.' } }, 401);
    const { remote } = remoteWith(upstream(revoked));
    const viaToken = await post(remote, call, { authorization: `Bearer ${accessToken()}` });
    expect(viaToken.status).toBe(401);
    expect(viaToken.headers.get('www-authenticate')).toContain('error="invalid_token"');

    const viaKey = await post(remote, call, { authorization: `Bearer ${TEST_KEY}` });
    expect(viaKey.status).toBe(200);
    expect(await viaKey.text()).toContain('api_key_invalid');
  });

  it('keeps the key path for any X-API-Key, next to a gateway\'s own Authorization', async () => {
    const { api, remote } = remoteWith();
    const response = await post(remote, call, { authorization: 'Bearer gateway-credential', 'x-api-key': TEST_KEY });
    expect(response.status).toBe(200);
    expect(api.calls[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_KEY}`);
    const malformed = await post(remote, call, { authorization: 'Bearer gateway-credential', 'x-api-key': 'sbm_test_short' });
    expect(malformed.status).toBe(200);
  });

  it('keeps the key path for agency keys and malformed ones', async () => {
    const { api, remote } = remoteWith();
    expect((await post(remote, call, { authorization: `Bearer ${TEST_KEY}` })).status).toBe(200);
    expect(api.calls[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_KEY}`);
    const malformed = await post(remote, call, { authorization: 'Bearer sbm_test_short' });
    expect(malformed.status).toBe(200);
    expect(await malformed.text()).toContain('not a whole Submitator agency key');
  });

  it('without a ring, a tool call without credentials explains how to get a key, as before', async () => {
    const remote = createRemoteHandler({ allowedHosts: ['mcp.submitator.com'], fetch: upstream().fetch });
    const response = await post(remote, call);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('agency console');
  });
});

describe('protected resource metadata', () => {
  const metadata = createMetadataHandler({ allowedHosts: ['mcp.submitator.com'] });

  it('names the resource, our authorization server and the scope, readable from anywhere', async () => {
    const response = await metadata(new Request('https://mcp.submitator.com/.well-known/oauth-protected-resource/mcp'));
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(await response.json()).toMatchObject({
      resource: 'https://mcp.submitator.com/mcp',
      authorization_servers: ['https://api.submitator.com'],
      scopes_supported: ['mcp'],
    });
  });

  it('serves only its own host, and only GET', async () => {
    expect((await metadata(new Request('https://evil.example/.well-known/oauth-protected-resource'))).status).toBe(421);
    expect((await metadata(new Request('https://mcp.submitator.com/.well-known/oauth-protected-resource', { method: 'POST' }))).status).toBe(405);
  });
});
