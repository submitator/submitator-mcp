// Vercel function behind https://mcp.submitator.com/mcp (rewritten here by
// vercel.json). The build step compiles src/ to dist/ first.
import { createRemoteHandler } from '../dist/http.js';
import { ringFromEnv } from '../dist/oauth.js';

const hosts = ['mcp.submitator.com'];
// Preview deployments answer on their own generated hosts as well.
if (process.env.VERCEL_ENV !== 'production') {
  for (const host of [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]) if (host) hosts.push(host);
}

const handle = createRemoteHandler({
  allowedHosts: hosts,
  // OAuth for clients that connect only through it: on when MCP_OAUTH_KEYS is
  // set (the access keys Submitator's API encrypts its tokens with), off again
  // with MCP_OAUTH=0, and off when a key does not parse.
  oauth:
    process.env.MCP_OAUTH === '0'
      ? null
      : ringFromEnv(process.env.MCP_OAUTH_KEYS, () => console.error('submitator-mcp: MCP_OAUTH_KEYS does not parse; OAuth is off')),
  // Only the error class: messages can carry URLs, never log headers.
  onError: (error) => console.error(`submitator-mcp: ${error instanceof Error ? error.name : 'error'}`),
});

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
