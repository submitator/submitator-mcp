import * as z from 'zod';
import { shareLinkView } from '../projections.js';
import { failure, success } from '../result.js';
import type { components } from '../v1.js';
import { projectId } from './schemas.js';
import { defineTool } from './types.js';

type S = components['schemas'];

// Share links exist only for live projects, so these tools are hidden from
// test keys (in test mode the API answers them with 422 or 404).

export const getShareLink = defineTool({
  name: 'get_share_link',
  title: 'Read the client page link',
  description: "The project's client page link (a read-only progress page in the agency's brand), with its views.",
  operations: ['getShareLink'],
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  modes: ['live'],
  input: z.object({ project_id: projectId }),
  async run(args, { api }) {
    const result = await api.request<S['ShareLink']>({ method: 'GET', path: `/projects/${args.project_id}/share_link` });
    if (!result.ok) return failure(result.error);
    return success({ share_link: shareLinkView(result.data) });
  },
});

export const createShareLink = defineTool({
  name: 'create_share_link',
  title: 'Create the client page link',
  description:
    "Gives the project's client page link. Returns the current link when there is one; replace: true issues a new link and turns the old one off.",
  operations: ['createShareLink', 'getShareLink'],
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  modes: ['live'],
  input: z.object({
    project_id: projectId,
    replace: z.boolean().optional().describe('Issue a new link even if one exists; the old one stops working'),
    expires_at: z.string().datetime({ offset: true }).optional().describe('When the new link stops working'),
  }),
  async run(args, { api }) {
    if (!args.replace) {
      const current = await api.request<S['ShareLink']>({ method: 'GET', path: `/projects/${args.project_id}/share_link` });
      if (current.ok && !current.data.revoked_at) {
        return success({ share_link: shareLinkView(current.data), existing: true });
      }
    }
    const result = await api.request<S['ShareLink']>({
      method: 'POST',
      path: `/projects/${args.project_id}/share_link`,
      json: args.expires_at ? { expires_at: args.expires_at } : {},
    });
    if (!result.ok) return failure(result.error);
    return success({ share_link: shareLinkView(result.data), existing: false });
  },
});

export const deleteShareLink = defineTool({
  name: 'delete_share_link',
  title: 'Turn the client page off',
  description: "Turns the project's client page link off. Anyone holding it sees nothing afterwards.",
  operations: ['deleteShareLink'],
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  modes: ['live'],
  input: z.object({ project_id: projectId }),
  async run(args, { api }) {
    const result = await api.request<S['ShareLink']>({ method: 'DELETE', path: `/projects/${args.project_id}/share_link` });
    if (!result.ok) return failure(result.error);
    return success({ share_link: shareLinkView(result.data) });
  },
});
