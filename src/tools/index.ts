import { CLIENT_INFO_META_KEY, type McpServer, type ServerContext } from '@modelcontextprotocol/server';
import type { ApiClient } from '../client.js';
import type { KeyMode } from '../key.js';
import { missingKey, refusal } from '../result.js';
import { confirmer } from './consent.js';
import { whoami } from './account.js';
import { getBadge, verifyBadge } from './badge.js';
import { findDirectories, projectDirectories } from './directories.js';
import { addScreenshot, removeImage, setLogo } from './images.js';
import { addDirectories, launchProject, previewLaunch } from './launch.js';
import { createProject, deleteDraft, getProject, listProjects, updateProject } from './projects.js';
import { createReport, getReport, saveReportFile } from './reports.js';
import { createShareLink, deleteShareLink, getShareLink } from './shareLinks.js';
import { advanceTestListing, setTestLaunches } from './testHelpers.js';
import { listEvents, listListings } from './tracking.js';
import type { LocalFiles, ToolSpec, Transport } from './types.js';

// The order is the order of tools/list.
export const TOOLS: readonly ToolSpec[] = [
  whoami,
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteDraft,
  setLogo,
  addScreenshot,
  removeImage,
  previewLaunch,
  findDirectories,
  projectDirectories,
  launchProject,
  addDirectories,
  listListings,
  listEvents,
  getBadge,
  verifyBadge,
  createReport,
  getReport,
  saveReportFile,
  getShareLink,
  createShareLink,
  deleteShareLink,
  advanceTestListing,
  setTestLaunches,
];

// /v1 operations with no tool, and why. Every operation of the contract is
// either here or in a tool's `operations` (test/contract.test.ts).
export const EXCLUDED: Readonly<Record<string, string>> = {
  getOpenApiDocument: 'the contract itself, not an action',
  getEvent: 'list_events already returns each event',
  createWebhookEndpoint: 'webhooks are set up once by a developer, in the console or the API',
  listWebhookEndpoints: 'webhook setup',
  getWebhookEndpoint: 'webhook setup',
  updateWebhookEndpoint: 'webhook setup',
  deleteWebhookEndpoint: 'webhook setup',
  rotateWebhookEndpointSecret: 'webhook setup',
  testWebhookEndpoint: 'webhook setup',
  listWebhookDeliveries: 'webhook setup',
  retryWebhookDelivery: 'webhook setup',
  listProjectLogins: 'logins hold passwords, which should not pass through a model',
  listLoginEmails: 'login emails, same reason as logins',
};

export function listed(tool: ToolSpec, mode: KeyMode | null, transport: Transport): boolean {
  if (tool.transports && !tool.transports.includes(transport)) return false;
  if (!tool.modes) return true;
  // With no key the live set is shown, so a registry sees the real tools.
  return tool.modes.includes(mode ?? 'live');
}

// The description a client on this transport reads.
export function descriptionOf(tool: ToolSpec, transport: Transport): string {
  return typeof tool.description === 'function' ? tool.description(transport) : tool.description;
}

export interface ToolDeps {
  api: ApiClient | null;
  mode: KeyMode | null;
  keyProblem?: 'missing' | 'malformed';
  transport: Transport;
  files?: LocalFiles;
  clientName?: () => string | undefined;
  onError?: (error: unknown) => void;
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  for (const tool of TOOLS) {
    if (!listed(tool, deps.mode, deps.transport)) continue;
    const inputSchema = typeof tool.input === 'function' ? tool.input(deps.transport) : tool.input;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: descriptionOf(tool, deps.transport),
        inputSchema,
        annotations: { title: tool.title, ...tool.annotations },
      },
      async (args: Record<string, unknown>, ctx: ServerContext) => {
        if (!deps.api || !deps.mode) return missingKey(deps.keyProblem ?? 'missing');
        const tagged = deps.api.forClient(clientNameOf(ctx) ?? deps.clientName?.());
        // On the remote server the host stops a call at 60 s: the API calls
        // of one tool call share 50 s, retries included.
        const api = deps.transport === 'http' ? tagged.within(50_000) : tagged;
        try {
          const confirm = confirmer(server, ctx);
          return await tool.run(args, { api, mode: deps.mode, transport: deps.transport, files: deps.files, confirm });
        } catch (error) {
          // Never echo the error: it is not ours to show and may carry a URL.
          deps.onError?.(error);
          return refusal(`${tool.name} failed inside the MCP server. Try again; if it repeats, report it with the time of the call.`);
        }
      },
    );
  }
}

function clientNameOf(ctx: ServerContext): string | undefined {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const info = envelope?.[CLIENT_INFO_META_KEY] as { name?: unknown } | undefined;
  return typeof info?.name === 'string' ? info.name : undefined;
}
