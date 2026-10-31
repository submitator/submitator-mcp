// What a client reads in tools/list, on each transport and with each kind of
// key: the hints clients such as Claude use to decide whether to ask before a
// call, and descriptions that offer only what the transport does. stdio goes
// through the SDK's in-memory pair, HTTP through the remote handler, each
// with the SDK's own client.
import { Client, InMemoryTransport, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { createRemoteHandler } from '../src/http.js';
import { parseKey } from '../src/key.js';
import { createServer } from '../src/server.js';
import { TOOLS } from '../src/tools/index.js';
import type { Transport } from '../src/tools/types.js';
import { LIVE_KEY, TEST_KEY } from './helpers.js';

// The tools that change or delete data, or submit what cannot be called back,
// so clients ask before each call. Changing this list is a decision: the
// directory review reads these hints.
const DESTRUCTIVE = [
  'update_project',
  'delete_draft',
  'set_logo',
  'remove_image',
  'launch_project',
  'add_directories',
  'create_share_link',
  'delete_share_link',
  'advance_test_listing',
  'set_test_launches',
];

const HINTS = ['readOnlyHint', 'destructiveHint', 'openWorldHint'] as const;

const KEYS = { live: LIVE_KEY, test: TEST_KEY, none: undefined } as const;
type KeyKind = keyof typeof KEYS;

async function listTools(transport: Transport, kind: KeyKind): Promise<Tool[]> {
  const key = KEYS[kind];
  const client = new Client({ name: 'vitest', version: '1.0.0' });
  if (transport === 'stdio') {
    const server = createServer({ transport, key: parseKey(key), apiUrl: 'https://api.submitator.com/v1' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    await client.connect(clientSide);
  } else {
    const remote = createRemoteHandler({ allowedHosts: ['mcp.submitator.com'] });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('https://mcp.submitator.com/mcp'), {
        fetch: (url, init) => remote(new Request(url, init)),
        requestInit: { headers: key ? { Authorization: `Bearer ${key}` } : {} },
      }),
    );
  }
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

const COMBINATIONS = (['stdio', 'http'] as const).flatMap((transport) =>
  (['live', 'test', 'none'] as const).map((key) => ({ transport, key })),
);

describe.each(COMBINATIONS)('tools/list on $transport with key: $key', ({ transport, key }) => {
  let tools: Tool[];
  beforeAll(async () => {
    tools = await listTools(transport, key);
  });

  it('gives every tool a title and all three hints as booleans', () => {
    expect(tools.length).toBeGreaterThan(15);
    for (const tool of tools) {
      expect(tool.title?.length, tool.name).toBeGreaterThan(3);
      expect(tool.annotations?.title, tool.name).toBe(tool.title);
      for (const hint of HINTS) expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe('boolean');
    }
  });

  it('never calls a read-only tool destructive', () => {
    const both = tools.filter((tool) => tool.annotations?.readOnlyHint && tool.annotations?.destructiveHint);
    expect(both.map((tool) => tool.name)).toEqual([]);
  });

  it('marks as destructive exactly the pinned tools it lists', () => {
    const names = tools.map((tool) => tool.name);
    const destructive = tools.filter((tool) => tool.annotations?.destructiveHint).map((tool) => tool.name);
    expect(destructive.sort()).toEqual(DESTRUCTIVE.filter((name) => names.includes(name)).sort());
  });
});

describe('the pinned destructive tools', () => {
  it('are all real tools, and each is listed on some transport and key', async () => {
    expect(DESTRUCTIVE.filter((name) => !TOOLS.some((tool) => tool.name === name))).toEqual([]);
    const seen = new Set<string>();
    for (const { transport, key } of COMBINATIONS) for (const tool of await listTools(transport, key)) seen.add(tool.name);
    expect(DESTRUCTIVE.filter((name) => !seen.has(name))).toEqual([]);
  });
});

// The remote server reads and saves no files, so on HTTP no tool may offer them.
const LOCAL_FILES = /\bnpx\b|SUBMITATOR_FILES_DIR|\blocal (?:file|folder|image)|\bfile_path\b/i;

describe('descriptions follow the transport', () => {
  it('on HTTP, no tool offers local files, SUBMITATOR_FILES_DIR or the npx package', async () => {
    for (const key of ['live', 'test', 'none'] as const) {
      for (const tool of await listTools('http', key)) {
        expect(JSON.stringify([tool.description, tool.inputSchema]), `${tool.name} (key: ${key})`).not.toMatch(LOCAL_FILES);
      }
    }
  });

  it('on stdio, set_logo and add_screenshot keep their local file', async () => {
    const tools = await listTools('stdio', 'test');
    for (const name of ['set_logo', 'add_screenshot']) {
      expect(tools.find((tool) => tool.name === name)?.description, name).toMatch(LOCAL_FILES);
    }
  });
});
