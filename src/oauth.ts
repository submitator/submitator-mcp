// OAuth on the remote server, for clients that connect only through it. The
// authorization server is Submitator's API: the person signs in and agrees in
// the agency console, and the access token it issues carries the agency key,
// encrypted (compact JWE, alg dir, enc A256GCM) with keys this deployment
// shares (MCP_OAUTH_KEYS). The token is opened here and never sent on; the API
// gets the key, as it does from a client that sends one itself.
import { createDecipheriv, createHash } from 'node:crypto';
import { parseKey, type ParsedKey } from './key.js';

export const ISSUER = 'https://api.submitator.com';
export const RESOURCE = 'https://mcp.submitator.com/mcp';
export const RESOURCE_METADATA_URL = 'https://mcp.submitator.com/.well-known/oauth-protected-resource/mcp';
export const SCOPE = 'mcp';

const ACCESS_TYP = 'mcp-at';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

// RFC 9728: where clients learn which authorization server to ask, and for
// which resource and scope.
export function protectedResourceMetadata() {
  return {
    resource: RESOURCE,
    authorization_servers: [ISSUER],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Submitator',
    resource_documentation: 'https://submitator.com/docs/mcp',
  };
}

// The keys that open access tokens: base64url 32-byte keys, comma separated,
// picked by the token's kid (the key's SHA-256 in base64url, cut to 8
// characters), so a new key can take over while old tokens drain.
export class AccessKeyRing {
  private readonly keys = new Map<string, Buffer>();

  constructor(keys: Buffer[]) {
    if (keys.length === 0) throw new Error('No OAuth key.');
    for (const key of keys) this.keys.set(kidOf(key), key);
  }

  // null when unset or empty: OAuth stays off. A malformed key throws, so a
  // typo in the environment fails at start instead of refusing every token.
  static fromEnv(value: string | undefined): AccessKeyRing | null {
    const parts = (value ?? '').split(',').map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    return new AccessKeyRing(
      parts.map((part) => {
        const key = decode(part);
        if (!key || key.length !== KEY_BYTES) throw new Error('An OAuth key is 32 bytes of base64url.');
        return key;
      }),
    );
  }

  // The payload, or null for anything that is not one of our access tokens.
  open(token: string): Record<string, unknown> | null {
    const parts = token.split('.');
    if (parts.length !== 5 || parts[1] !== '') return null;
    const [protectedHeader, , ivText, cipherText, tagText] = parts as [string, string, string, string, string];
    const header = parseObject(decode(protectedHeader));
    if (!header || header.alg !== 'dir' || header.enc !== 'A256GCM' || header.typ !== ACCESS_TYP) return null;
    const key = typeof header.kid === 'string' ? this.keys.get(header.kid) : undefined;
    const iv = decode(ivText);
    const ciphertext = decode(cipherText);
    const tag = decode(tagText);
    if (!key || !iv || !ciphertext || !tag || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(protectedHeader, 'ascii'));
      decipher.setAuthTag(tag);
      return parseObject(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
    } catch {
      return null;
    }
  }
}

export type AccessTokenCheck = { ok: true; key: Extract<ParsedKey, { ok: true }> } | { ok: false; reason: 'invalid' | 'expired' };

// An access token is ours, for this server, from our issuer, unexpired, and
// holds a whole agency key.
export function readAccessToken(token: string, ring: AccessKeyRing, nowSeconds: number): AccessTokenCheck {
  const payload = ring.open(token);
  if (!payload || payload.iss !== ISSUER || payload.aud !== RESOURCE) return { ok: false, reason: 'invalid' };
  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) return { ok: false, reason: 'expired' };
  const key = parseKey(typeof payload.key === 'string' ? payload.key : null);
  return key.ok ? { ok: true, key } : { ok: false, reason: 'invalid' };
}

// RFC 6750 and the MCP spec: where to find the metadata, the scope to ask for,
// and, for a token we refused, why.
export function challenge(reason?: 'invalid' | 'expired'): string {
  const params = [`Bearer resource_metadata="${RESOURCE_METADATA_URL}"`, `scope="${SCOPE}"`];
  if (reason) {
    params.push('error="invalid_token"', `error_description="${reason === 'expired' ? 'The access token expired' : 'The access token is not valid'}"`);
  }
  return params.join(', ');
}

function kidOf(key: Buffer): string {
  return createHash('sha256').update(key).digest('base64url').slice(0, 8);
}

// Strict base64url: Buffer.from would skip characters it does not know.
function decode(text: string): Buffer | null {
  return BASE64URL.test(text) ? Buffer.from(text, 'base64url') : null;
}

function parseObject(bytes: Buffer | null): Record<string, unknown> | null {
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
