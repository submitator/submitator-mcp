export const DEFAULT_API_URL = 'https://api.submitator.com/v1';
export const CONSOLE_URL = 'https://app.submitator.com/agency';
export const DOCS_URL = 'https://submitator.com/docs';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// The key goes wherever this URL points, so only our API host or a local
// development server is accepted. Anything else stops the process at start.
export function apiUrlFrom(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') return DEFAULT_API_URL;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('SUBMITATOR_API_URL is not a valid URL.');
  }
  const ours = url.protocol === 'https:' && url.hostname === 'api.submitator.com';
  const local = (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK.has(url.hostname);
  if (!ours && !local) {
    throw new Error('SUBMITATOR_API_URL may only point to https://api.submitator.com or to localhost.');
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error('SUBMITATOR_API_URL must be a plain base URL.');
  }
  return url.toString().replace(/\/+$/, '');
}
