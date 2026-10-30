#!/usr/bin/env node
// The npx entry: `npx -y submitator-mcp` with SUBMITATOR_API_KEY in the env.
// stdout is the protocol channel, so everything else goes to stderr.
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { apiUrlFrom } from './config.js';
import { localFiles } from './files.js';
import { parseKey } from './key.js';
import { createServer } from './server.js';

function fail(message: string): never {
  console.error(`submitator-mcp: ${message}`);
  process.exit(1);
}

let apiUrl: string;
try {
  apiUrl = apiUrlFrom(process.env.SUBMITATOR_API_URL);
} catch (error) {
  fail(error instanceof Error ? error.message : 'SUBMITATOR_API_URL is not usable.');
}

const key = parseKey(process.env.SUBMITATOR_API_KEY);
if (!key.ok) {
  console.error(
    key.reason === 'missing'
      ? 'submitator-mcp: SUBMITATOR_API_KEY is not set; every tool will answer with the setup steps.'
      : 'submitator-mcp: SUBMITATOR_API_KEY does not look like an agency key (sbm_live_ or sbm_test_).',
  );
}

const report = (error: unknown) => console.error(`submitator-mcp: ${error instanceof Error ? error.name : 'error'}`);

const files = localFiles();
serveStdio(() => createServer({ transport: 'stdio', key, apiUrl, files, onError: report }), { onerror: report });
