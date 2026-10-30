import { describe, expect, it } from 'vitest';
import { apiUrlFrom, DEFAULT_API_URL } from '../src/config.js';
import { keyFromHeaders, parseKey } from '../src/key.js';
import { LIVE_KEY, TEST_KEY } from './helpers.js';

describe('parseKey', () => {
  it('reads the mode from the prefix', () => {
    expect(parseKey(TEST_KEY)).toEqual({ ok: true, key: TEST_KEY, mode: 'test' });
    expect(parseKey(` ${LIVE_KEY} `)).toEqual({ ok: true, key: LIVE_KEY, mode: 'live' });
  });

  it('tells a missing key from a malformed one', () => {
    expect(parseKey(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(parseKey('  ')).toEqual({ ok: false, reason: 'missing' });
    expect(parseKey('sk_live_123')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseKey(`${TEST_KEY}x`)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('keyFromHeaders', () => {
  it('accepts a Bearer token, a bare Authorization value and X-API-Key', () => {
    expect(keyFromHeaders(new Headers({ Authorization: `Bearer ${TEST_KEY}` }))).toMatchObject({ ok: true, mode: 'test' });
    expect(keyFromHeaders(new Headers({ Authorization: `bearer   ${LIVE_KEY}` }))).toMatchObject({ ok: true, mode: 'live' });
    expect(keyFromHeaders(new Headers({ Authorization: LIVE_KEY }))).toMatchObject({ ok: true, mode: 'live' });
    expect(keyFromHeaders(new Headers({ 'X-API-Key': TEST_KEY }))).toMatchObject({ ok: true, mode: 'test' });
  });

  it('takes X-API-Key when Authorization carries a gateway credential, and reports what is wrong', () => {
    expect(keyFromHeaders(new Headers({ Authorization: 'Bearer gateway-token', 'X-API-Key': TEST_KEY }))).toMatchObject({ ok: true, mode: 'test' });
    expect(keyFromHeaders(new Headers({ Authorization: `Bearer ${LIVE_KEY}`, 'X-API-Key': TEST_KEY }))).toMatchObject({ ok: true, mode: 'live' });
    expect(keyFromHeaders(new Headers({ Authorization: 'Bearer nope' }))).toEqual({ ok: false, reason: 'malformed' });
    expect(keyFromHeaders(new Headers())).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('apiUrlFrom', () => {
  it('defaults to the public API', () => {
    expect(apiUrlFrom(undefined)).toBe(DEFAULT_API_URL);
    expect(apiUrlFrom('')).toBe(DEFAULT_API_URL);
  });

  it('accepts our API host and localhost only', () => {
    expect(apiUrlFrom('https://api.submitator.com/v1/')).toBe('https://api.submitator.com/v1');
    expect(apiUrlFrom('http://localhost:3001/v1')).toBe('http://localhost:3001/v1');
    expect(apiUrlFrom('http://127.0.0.1:3001/v1')).toBe('http://127.0.0.1:3001/v1');
    expect(() => apiUrlFrom('https://evil.example/v1')).toThrow(/api\.submitator\.com/);
    expect(() => apiUrlFrom('http://api.submitator.com/v1')).toThrow();
    expect(() => apiUrlFrom('https://api.submitator.com.evil.example/v1')).toThrow();
    expect(() => apiUrlFrom('https://api.submitator.com/v1?x=1')).toThrow(/plain base URL/);
    expect(() => apiUrlFrom('not a url')).toThrow(/not a valid URL/);
  });
});
