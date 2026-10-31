import type { CallToolResult, InputRequiredResult, ToolAnnotations } from '@modelcontextprotocol/server';
import type * as z from 'zod';
import type { ApiClient } from '../client.js';
import type { KeyMode } from '../key.js';
import type { Confirm } from './consent.js';

export type Transport = 'stdio' | 'http';

// Local disk access, given to tools only on stdio (the user's own machine).
export interface LocalFiles {
  read(path: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string; extension: string }>;
  write(directory: string | undefined, fileName: string, bytes: Uint8Array): Promise<{ path: string; size: number }>;
}

export interface ToolContext {
  api: ApiClient;
  mode: KeyMode;
  transport: Transport;
  files: LocalFiles | undefined;
  // Asks the client's user directly, where the client can (consent.ts).
  confirm: Confirm;
}

export type ToolResult = CallToolResult | InputRequiredResult;

type InputFor<T extends z.ZodObject> = T | ((transport: Transport) => T);

// A description that differs by transport says only what that transport does:
// the remote server reads and saves no files.
type DescriptionFor = string | ((transport: Transport) => string);

// Every tool states these three, so no client falls back to the protocol's
// defaults (destructive, open world). Clients such as Claude decide on them
// whether to ask before a call: a read-only tool runs without asking, a
// destructive one (it overwrites or deletes data, or submits to directories)
// asks. A tool that only adds or checks is neither read-only nor destructive.
export type ToolHints = Omit<ToolAnnotations, 'title'> & {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
};

export interface ToolSpec {
  name: string;
  title: string;
  description: DescriptionFor;
  // The /v1 operations the tool calls: test/contract.test.ts holds this list
  // equal to the contract, together with EXCLUDED.
  operations: readonly string[];
  annotations: ToolHints;
  input: InputFor<z.ZodObject>;
  // Where the tool is listed. No modes: every key, and a missing key.
  // ['live']: live keys and a missing key. ['test']: test keys only.
  modes?: readonly KeyMode[];
  transports?: readonly Transport[];
  run(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export function defineTool<T extends z.ZodObject>(spec: Omit<ToolSpec, 'input' | 'run'> & {
  input: InputFor<T>;
  run(args: z.infer<T>, context: ToolContext): Promise<ToolResult>;
}): ToolSpec {
  return spec as unknown as ToolSpec;
}
