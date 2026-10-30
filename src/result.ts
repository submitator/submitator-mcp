// Every tool answers through these helpers: compact JSON for the model, the
// same object as structured content, and errors the model can act on.
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ApiFailure } from './client.js';
import { CONSOLE_URL } from './config.js';

export function success(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

// A refusal made here, before or instead of an API call.
export function refusal(message: string, details?: Record<string, unknown>): CallToolResult {
  const text = details ? `${message}\n${JSON.stringify(details)}` : message;
  return { isError: true, content: [{ type: 'text', text }] };
}

export function failure(error: ApiFailure): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: describeFailure(error) }] };
}

const HINTS: Record<string, string> = {
  api_key_missing: `Add the agency API key to the MCP client's config. Keys are created in the agency console: ${CONSOLE_URL}/developers`,
  api_key_invalid: `The key is unknown, revoked or expired. Create a new one in the agency console: ${CONSOLE_URL}/developers`,
  permission_denied: 'This key cannot do that. A read-only key only reads, and a report with logins needs a key with full permissions.',
  account_suspended: 'The agency is suspended: reading works, changes do not. Contact support from the agency console.',
  no_launches_left: `No launches left. Launches are bought in the agency console: ${CONSOLE_URL}/billing`,
  not_ready: 'Call preview_launch to see what the project still needs.',
  already_launched: 'The project is already launched: it cannot be launched or deleted again. add_directories reaches more directories.',
  rate_limited:
    'The API allows a fixed number of requests an hour per agency and mode, shared by every key. Some actions have their own limits too: badge checks, image imports and report builds.',
  idempotency_key_in_use: 'The same request is still running. Check the result with a read tool before trying again.',
  test_mode_only: 'This works only with a sbm_test_ key.',
  cursor_expired: 'The cursor is too old. Start again without a cursor.',
};

export function describeFailure(error: ApiFailure): string {
  const lines = [`${error.code}${error.status ? ` (HTTP ${error.status})` : ''}: ${error.message}`];
  if (error.param) lines.push(`Parameter: ${error.param}`);
  for (const issue of error.errors ?? []) lines.push(`* ${issue.param}: ${issue.code}: ${issue.message}`);
  if (error.existing) {
    const { id, name, status, url } = error.existing;
    lines.push(`Existing project: ${[id, name, status, url].filter(Boolean).join(', ')}`);
  }
  if (error.retry_after !== undefined) lines.push(`Retry after ${error.retry_after} seconds.`);
  const hint = HINTS[error.code];
  if (hint) lines.push(hint);
  if (error.doc_url) lines.push(`Docs: ${error.doc_url}`);
  if (error.request_id) lines.push(`Request id: ${error.request_id}`);
  return lines.join('\n');
}

export function missingKey(reason: 'missing' | 'malformed'): CallToolResult {
  const start = `${CONSOLE_URL}/developers`;
  return refusal(
    reason === 'missing'
      ? `No Submitator API key. Put an agency key in this MCP server's config (SUBMITATOR_API_KEY for the npx package, the Authorization header for the remote server). Keys are created in the agency console: ${start}. A sbm_test_ key is free and runs in test mode, where nothing is submitted.`
      : 'The configured API key is not a whole Submitator agency key: sbm_live_ or sbm_test_, then 8 letters or digits, an underscore and 43 more. Check that it is complete, with no quotes or spaces.',
  );
}
