import * as z from 'zod';
import type { ApiClient } from '../client.js';
import { CONSOLE_URL } from '../config.js';
import type { KeyMode } from '../key.js';
import { pick, projectRow, readinessView } from '../projections.js';
import { failure, refusal, success } from '../result.js';
import type { components } from '../v1.js';
import { declined } from './consent.js';
import { directoryId, directorySelection, projectId } from './schemas.js';
import { defineTool, type ToolResult } from './types.js';

type S = components['schemas'];
type Selection = z.infer<typeof directorySelection>;
type Kind = 'launch' | 'add';

const ALLOWANCE = ['total', 'used', 'reserved', 'available'] as const;

interface Request {
  project_id: string;
  directories?: Selection | undefined;
  excluded_directories?: string[] | undefined;
  auto_replace?: boolean | undefined;
}

interface Plan {
  kind: Kind;
  project: S['Project'];
  readiness: S['Readiness'];
  // How many directories this request submits to (with auto_replace, the
  // count it grows to within a day).
  count: number;
  // Why it cannot go ahead, in words the model can act on.
  blocked?: string;
}

const includes = (selection: Selection | undefined): selection is { include: string[] } =>
  typeof selection === 'object' && selection !== null && 'include' in selection;
const excludes = (selection: Selection | undefined): selection is { exclude: string[] } =>
  typeof selection === 'object' && selection !== null && 'exclude' in selection;

// What a launch (or, on a launched project, an add) of this request would
// take, counted the way the API picks: the auto pick is the readiness count;
// any other form is worked out from the project's directory choices.
async function plan(api: ApiClient, request: Request, mode: KeyMode): Promise<{ ok: true; plan: Plan } | { ok: false; result: ToolResult }> {
  const id = request.project_id;
  const [project, readiness] = await Promise.all([
    api.request<S['Project']>({ method: 'GET', path: `/projects/${id}` }),
    api.request<S['Readiness']>({ method: 'GET', path: `/projects/${id}/readiness` }),
  ]);
  if (!project.ok) return { ok: false, result: failure(project.error) };
  if (!readiness.ok) return { ok: false, result: failure(readiness.error) };
  const r = readiness.data;
  const kind: Kind = r.cost.launches === 0 ? 'add' : 'launch';

  let count = r.directories.selected;
  const include = includes(request.directories) ? request.directories.include : undefined;
  const plain = (request.directories === undefined || request.directories === 'auto') && request.excluded_directories === undefined;
  if (include && request.auto_replace !== true) {
    count = include.length;
  } else if (!plain || (include && request.auto_replace === true)) {
    const choices = await api.request<S['ProjectDirectories']>({ method: 'GET', path: `/projects/${id}/directories` });
    if (!choices.ok) return { ok: false, result: failure(choices.error) };
    const replaced = request.excluded_directories !== undefined;
    const never = new Set(
      replaced
        ? request.excluded_directories
        : choices.data.directories.filter((entry) => entry.state === 'excluded').map((entry) => entry.directory.id),
    );
    const without = new Set(excludes(request.directories) ? request.directories.exclude : []);
    const fitting = choices.data.directories
      .filter((entry) => entry.state === 'suggested' || entry.state === 'open' || (replaced && entry.state === 'excluded'))
      .filter((entry) => entry.directory.kind !== 'article')
      .map((entry) => entry.directory.id)
      .filter((directory) => !never.has(directory) && !without.has(directory));
    if (include) {
      const chosen = new Set(include);
      count = Math.min(choices.data.limit, include.length + fitting.filter((directory) => !chosen.has(directory)).length);
    } else {
      count = Math.min(choices.data.limit, fitting.length);
    }
  }

  const blocked = blockedBecause(kind, r, count, mode);
  const result: Plan = { kind, project: project.data, readiness: r, count };
  if (blocked) result.blocked = blocked;
  return { ok: true, plan: result };
}

function blockedBecause(kind: Kind, r: S['Readiness'], count: number, mode: KeyMode): string | undefined {
  if (kind === 'launch') {
    if (r.missing.length > 0) return `Fill these first: ${r.missing.join(', ')} (update_project, set_logo, add_screenshot).`;
    if (r.cost.available === 0) {
      return mode === 'test'
        ? 'No test launches left: set_test_launches sets more.'
        : `No launches left. Launches are bought in the agency console: ${CONSOLE_URL}/billing`;
    }
  } else if (r.directories.limit === 0) {
    return 'The project is launched and its free allowance is used up.';
  }
  if (count === 0) return 'No directory fits this request. unlocks and not_matching in the preview say what would change that.';
  return undefined;
}

function projectBasics(project: S['Project']) {
  return {
    id: project.id,
    name: project.name,
    url: project.url,
    contact_email: project.contact_email ?? undefined,
    status: project.status,
    auto_replace: project.auto_replace,
  };
}

const requestFields = {
  project_id: projectId,
  directories: directorySelection.optional(),
  excluded_directories: z
    .array(directoryId)
    .optional()
    .describe("Replaces the project's whole exclusion list for this request; [] clears it. To leave some out once, use directories: {exclude}"),
  auto_replace: z
    .boolean()
    .optional()
    .describe('true: within a day the free allowance fills up to 100 with fitting directories, replacing declined ones too. include turns it off unless you send true'),
};

export const previewLaunch = defineTool({
  name: 'preview_launch',
  title: 'Preview a launch',
  description:
    'Free dry run of launch_project (or of add_directories on a launched project) with the same arguments: how many directories it would submit to, top and median DR, what is missing, what would unlock more, and what it costs. Show the numbers to the user before launching.',
  operations: ['getProjectReadiness', 'getProject', 'listProjectDirectories'],
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  input: z.object(requestFields),
  async run(args, { api, mode }) {
    const outcome = await plan(api, args, mode);
    if (!outcome.ok) return outcome.result;
    const { kind, project, readiness, count, blocked } = outcome.plan;
    const tool = kind === 'launch' ? 'launch_project' : 'add_directories';
    return success({
      project: projectBasics(project),
      readiness: readinessView(readiness),
      allowance: pick(project.allowance, ALLOWANCE),
      for: tool,
      would_submit: blocked ? undefined : count,
      blocked,
      next: blocked
        ? undefined
        : `Show the user: ${count} directories for ${project.name} (${project.url}), mail to ${project.contact_email ?? 'no contact email yet'}${
            kind === 'launch' ? `, one launch of ${readiness.cost.available} left` : ', no launch spent'
          }. If they agree, call ${tool} with the same arguments and confirm_selected: ${count}.`,
    });
  },
});

const MISMATCH =
  'Not done: confirm_selected does not match what this request would submit now. Call preview_launch with the same arguments, show the user the numbers, and call again with the count they agreed to.';

export const launchProject = defineTool({
  name: 'launch_project',
  title: 'Launch a project',
  description:
    'Starts submissions and spends one launch of the agency (a test launch with a sbm_test_ key). Call preview_launch with the same arguments first and get the user to agree; confirm_selected is the count they agreed to. With a live key, clients that can ask their user get a confirmation question too.',
  operations: ['launchProject', 'getProjectReadiness', 'getProject', 'listProjectDirectories'],
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    ...requestFields,
    confirm_selected: z.number().int().min(0).describe('The directory count from preview_launch that the user agreed to'),
  }),
  async run(args, { api, mode, confirm }) {
    const outcome = await plan(api, args, mode);
    if (!outcome.ok) return outcome.result;
    const { kind, project, readiness, count, blocked } = outcome.plan;
    if (kind === 'add') return refusal('This project is already launched. add_directories reaches more directories within its allowance.');
    if (blocked) return refusal(`Not launched. ${blocked}`);
    if (args.confirm_selected !== count) return refusal(MISMATCH);

    if (mode === 'live') {
      const growing = args.auto_replace === true || (args.auto_replace === undefined && !includes(args.directories) && project.auto_replace);
      const consent = await confirm(
        `launch_${project.id}_${count}`,
        `Launch ${project.name} (${project.url}) on ${count} directories? This spends one of your ${readiness.cost.available} launches, and the directories write to ${project.contact_email}.${
          growing ? ' Auto-replace is on: within a day the free allowance fills up to 100.' : ''
        }`,
      );
      if (consent.kind === 'ask') return consent.result;
      if (consent.kind === 'declined') return declined();
    }

    const result = await api.request<S['Project']>({
      method: 'POST',
      path: `/projects/${args.project_id}/launch`,
      json: body(args),
      idempotent: true,
    });
    if (!result.ok) return failure(result.error);
    return success({
      project: projectRow(result.data),
      allowance: pick(result.data.allowance, ALLOWANCE),
      spent:
        mode === 'live' ? 'one launch' : 'one test launch: test listings settle within about 15 minutes, and nothing is submitted',
      next: 'Track it with get_project (progress counts) and list_listings; list_events with since shows what changed.',
    });
  },
});

export const addDirectories = defineTool({
  name: 'add_directories',
  title: 'Add directories to a launched project',
  description:
    'Submits a launched project to more directories from its free allowance (no launch is spent). Call preview_launch with the same arguments first and get the user to agree. An include longer than the free allowance answers allowance_exhausted; a directory already listed answers invalid_directories.',
  operations: ['addProjectListings', 'getProjectReadiness', 'getProject', 'listProjectDirectories'],
  // It submits to third-party directories, and the API has no call that withdraws a submission.
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  input: z.object({
    project_id: projectId,
    directories: directorySelection,
    excluded_directories: requestFields.excluded_directories,
    confirm_selected: z.number().int().min(0).describe('The directory count from preview_launch that the user agreed to'),
  }),
  async run(args, { api, mode, confirm }) {
    const outcome = await plan(api, args, mode);
    if (!outcome.ok) return outcome.result;
    const { kind, project, count, blocked } = outcome.plan;
    if (kind === 'launch') return refusal('This project is not launched yet: launch_project starts it.');
    if (blocked) return refusal(`Nothing added. ${blocked}`);
    if (args.confirm_selected !== count) return refusal(MISMATCH);

    if (mode === 'live') {
      const consent = await confirm(
        `add_${project.id}_${count}`,
        `Submit ${project.name} (${project.url}) to ${count} more directories from its free allowance? No launch is spent.`,
      );
      if (consent.kind === 'ask') return consent.result;
      if (consent.kind === 'declined') return declined();
    }

    const result = await api.request<S['Project']>({
      method: 'POST',
      path: `/projects/${args.project_id}/listings`,
      json: body(args),
      idempotent: true,
    });
    if (!result.ok) return failure(result.error);
    return success({ project: projectRow(result.data), allowance: pick(result.data.allowance, ALLOWANCE) });
  },
});

// Only what was sent, with an empty list kept: [] clears the exclusions.
function body(args: Request): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (args.directories !== undefined) out.directories = args.directories;
  if (args.excluded_directories !== undefined) out.excluded_directories = args.excluded_directories;
  if (args.auto_replace !== undefined) out.auto_replace = args.auto_replace;
  return out;
}
