// Asks the person, not the model, before an action that submits to real
// directories. A model can fill any argument itself, including a guard
// number, so where the client can show a question to its user (MCP
// elicitation) the answer comes from there and never passes through the model.
import {
  acceptedContent,
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  type CallToolResult,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server';
import * as z from 'zod';

export type Consent =
  | { kind: 'confirmed' }
  | { kind: 'declined' }
  // 2026 clients: return this result; the client asks its user and calls again.
  | { kind: 'ask'; result: InputRequiredResult }
  // The client cannot ask its user: the guard and the client's own approval stay.
  | { kind: 'unavailable' };

export type Confirm = (key: string, message: string) => Promise<Consent>;

const ANSWER = z.object({ confirm: z.boolean().describe('Go ahead') });
// The same question in the 2025 wire shape, which takes a plain JSON schema.
const ANSWER_JSON = {
  type: 'object' as const,
  properties: { confirm: { type: 'boolean' as const, title: 'Go ahead' } },
  required: ['confirm'],
};

export function confirmer(server: McpServer, ctx: ServerContext): Confirm {
  return async (key, message) => {
    const responses = ctx.mcpReq.inputResponses;
    if (responses && key in responses) {
      return acceptedContent(responses, key, ANSWER)?.confirm === true ? { kind: 'confirmed' } : { kind: 'declined' };
    }
    const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
    const modern = envelope?.[CLIENT_CAPABILITIES_META_KEY] as { elicitation?: unknown } | undefined;
    if (modern?.elicitation) {
      return { kind: 'ask', result: inputRequired({ inputRequests: { [key]: inputRequired.elicit({ message, requestedSchema: ANSWER }) } }) };
    }
    // A 2025 client on the same connection (stdio).
    if (server.server.getClientCapabilities()?.elicitation) {
      try {
        const answer = await ctx.mcpReq.elicitInput({ message, requestedSchema: ANSWER_JSON });
        return answer.action === 'accept' && answer.content?.confirm === true ? { kind: 'confirmed' } : { kind: 'declined' };
      } catch {
        return { kind: 'unavailable' };
      }
    }
    return { kind: 'unavailable' };
  };
}

export const neverAsk: Confirm = async () => ({ kind: 'unavailable' });

export function declined(): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: 'Not done: the user did not confirm it. Nothing was submitted and nothing was spent.' }],
  };
}
