// Agency API keys: sbm_live_ or sbm_test_, 8 characters, an underscore, 43 more.
// The format is checked here so a malformed value never reaches the API.

export const KEY_PATTERN = /^sbm_(live|test)_[0-9A-Za-z]{8}_[0-9A-Za-z]{43}$/;

export type KeyMode = 'live' | 'test';

export type ParsedKey =
  | { ok: true; key: string; mode: KeyMode }
  | { ok: false; reason: 'missing' | 'malformed' };

export function parseKey(raw: string | null | undefined): ParsedKey {
  const value = raw?.trim();
  if (!value) return { ok: false, reason: 'missing' };
  const match = KEY_PATTERN.exec(value);
  if (!match) return { ok: false, reason: 'malformed' };
  return { ok: true, key: value, mode: match[1] as KeyMode };
}

// Remote clients send the key as "Authorization: Bearer <key>", as a bare
// "Authorization: <key>" (some clients send header values verbatim), or as
// "X-API-Key: <key>" (Smithery keeps Authorization for itself).
export function keyFromHeaders(headers: Headers): ParsedKey {
  const authorization = headers.get('authorization')?.trim();
  const fromAuthorization = authorization ? parseKey(/^bearer\s+(.+)$/i.exec(authorization)?.[1] ?? authorization) : undefined;
  if (fromAuthorization?.ok) return fromAuthorization;
  // A gateway may put its own credential in Authorization and ours in X-API-Key.
  const fromHeader = parseKey(headers.get('x-api-key'));
  if (fromHeader.ok || !fromAuthorization) return fromHeader;
  return fromAuthorization;
}
