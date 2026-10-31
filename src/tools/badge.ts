import * as z from 'zod';
import { badgeView } from '../projections.js';
import { failure, success } from '../result.js';
import type { components } from '../v1.js';
import { projectId } from './schemas.js';
import { defineTool } from './types.js';

type S = components['schemas'];

export const getBadge = defineTool({
  name: 'get_badge',
  title: 'Get the badge install kit',
  description:
    "The agency-branded badge some directories require on the client's site: its status, a message to forward to the client, and install code for one platform. Call without platform to see the platforms.",
  operations: ['getProjectBadge'],
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  input: z.object({
    project_id: projectId,
    platform: z.string().max(40).optional().describe('Platform name from the list, for its install code'),
  }),
  async run(args, { api }) {
    const result = await api.request<S['Badge']>({ method: 'GET', path: `/projects/${args.project_id}/badge` });
    if (!result.ok) return failure(result.error);
    return success({ badge: badgeView(result.data, args.platform) });
  },
});

export const verifyBadge = defineTool({
  name: 'verify_badge',
  title: 'Check the badge on the site',
  description:
    "Checks the client's site for the badge now. Up to 10 checks an hour per project, so check once after the client says it is installed.",
  operations: ['verifyProjectBadge'],
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  input: z.object({ project_id: projectId }),
  async run(args, { api }) {
    const result = await api.request<S['Badge']>({ method: 'POST', path: `/projects/${args.project_id}/badge/verify` });
    if (!result.ok) return failure(result.error);
    const view = badgeView(result.data);
    return success({ badge: { project: view.project, status: view.status, checked_at: view.checked_at } });
  },
});
