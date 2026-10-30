// One factory for both entries: stdio (the npx package) and remote HTTP.
import { McpServer } from '@modelcontextprotocol/server';
import { ApiClient } from './client.js';
import { INSTRUCTIONS } from './instructions.js';
import type { ParsedKey } from './key.js';
import { registerPrompts } from './prompts.js';
import { registerTools } from './tools/index.js';
import type { LocalFiles, Transport } from './tools/types.js';
import { VERSION } from './version.js';

export interface ServerSetup {
  transport: Transport;
  key: ParsedKey;
  apiUrl: string;
  files?: LocalFiles;
  fetch?: typeof fetch;
  // The calling app's name when the protocol does not carry it on every
  // request (a stateless 2025 HTTP client): the product token of its User-Agent.
  clientHint?: string;
  onError?: (error: unknown) => void;
}

export function createServer(setup: ServerSetup): McpServer {
  const server = new McpServer(
    { name: 'submitator', title: 'Submitator', version: VERSION },
    {
      instructions: INSTRUCTIONS,
      // The tool list never changes within a connection: no change streams.
      capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
    },
  );
  const api = setup.key.ok
    ? new ApiClient({
        baseUrl: setup.apiUrl,
        key: setup.key.key,
        channel: setup.transport === 'stdio' ? 's' : 'h',
        ...(setup.fetch ? { fetch: setup.fetch } : {}),
      })
    : null;
  registerTools(server, {
    api,
    mode: setup.key.ok ? setup.key.mode : null,
    ...(setup.key.ok ? {} : { keyProblem: setup.key.reason }),
    transport: setup.transport,
    ...(setup.files ? { files: setup.files } : {}),
    clientName: () => server.server.getClientVersion()?.name ?? setup.clientHint,
    ...(setup.onError ? { onError: setup.onError } : {}),
  });
  registerPrompts(server);
  return server;
}
