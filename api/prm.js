// Vercel function behind https://mcp.submitator.com/.well-known/oauth-protected-resource
// and its /mcp twin (rewritten here by vercel.json): where OAuth clients learn
// which authorization server to ask. Answers only while OAuth is on.
import { createMetadataHandler } from '../dist/http.js';
import { ringFromEnv } from '../dist/oauth.js';

const hosts = ['mcp.submitator.com'];
if (process.env.VERCEL_ENV !== 'production') {
  for (const host of [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]) if (host) hosts.push(host);
}

// The same test as api/mcp.js: never advertise OAuth the endpoint does not do.
const on = process.env.MCP_OAUTH !== '0' && ringFromEnv(process.env.MCP_OAUTH_KEYS) !== null;
const metadata = createMetadataHandler({ allowedHosts: hosts });

export const GET = (request) => (on ? metadata(request) : new Response('Not found.', { status: 404 }));
