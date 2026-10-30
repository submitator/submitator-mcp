import * as z from 'zod';
import { projectRow, projectView } from '../projections.js';
import { failure, refusal, success } from '../result.js';
import type { components } from '../v1.js';
import { cursor, limit, projectFields, projectId } from './schemas.js';
import { defineTool } from './types.js';

type S = components['schemas'];

export const listProjects = defineTool({
  name: 'list_projects',
  title: 'List client projects',
  description: 'Lists the agency projects, newest first. Find one by name or URL with q, or by your own external_id.',
  operations: ['listProjects'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    q: z.string().min(2).max(100).optional().describe('Part of the name or URL'),
    status: z.enum(['draft', 'in_progress', 'action_required', 'on_hold', 'completed']).optional(),
    external_id: z.string().max(100).optional(),
    cursor: cursor.optional(),
    limit: limit(50, 20),
  }),
  async run(args, { api }) {
    const result = await api.request<S['ProjectList']>({
      method: 'GET',
      path: '/projects',
      query: { q: args.q, status: args.status, external_id: args.external_id, cursor: args.cursor, limit: args.limit ?? 20 },
    });
    if (!result.ok) return failure(result.error);
    return success({
      projects: result.data.data.map(projectRow),
      has_more: result.data.has_more,
      next_cursor: result.data.next_cursor ?? undefined,
    });
  },
});

export const getProject = defineTool({
  name: 'get_project',
  title: 'Read a project',
  description:
    'One project in full: status, what it waits for, progress counts, allowance, readiness, texts, images and the image candidates found on its site.',
  operations: ['getProject'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({ project_id: projectId }),
  async run(args, { api }) {
    const result = await api.request<S['Project']>({ method: 'GET', path: `/projects/${args.project_id}` });
    if (!result.ok) return failure(result.error);
    return success({ project: projectView(result.data) });
  },
});

export const createProject = defineTool({
  name: 'create_project',
  title: 'Create a client project',
  description:
    "Creates a project for a client's product from its URL. Name, tagline and description are filled from the site in the background when left out. Costs nothing: a launch is spent only by launch_project.",
  operations: ['createProject'],
  // The API reads the site and fetches image URLs: it reaches out.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  input: z.object({
    url: z.string().max(2048).describe("The client product's public URL"),
    ...projectFields,
    logo_url: z.string().max(2048).optional().describe('Public image URL for the logo (PNG, JPEG, GIF or WebP, 5 MB at most)'),
    screenshot_urls: z.array(z.string().max(2048)).min(1).max(5).optional().describe('1 to 5 public image URLs'),
  }),
  async run(args, { api, mode }) {
    const result = await api.request<S['Project']>({ method: 'POST', path: '/projects', json: args, idempotent: true });
    if (!result.ok) return failure(result.error);
    return success({
      project: projectView(result.data),
      next:
        mode === 'test'
          ? 'Test mode reads nothing from the site: set any https image URLs for the logo and screenshots (they become placeholders), add contact_email, then call preview_launch.'
          : 'Autofill reads the site for a few seconds: call get_project, check the texts, set a logo and screenshots (image_candidates holds URLs from the site), add contact_email, then call preview_launch.',
    });
  },
});

export const updateProject = defineTool({
  name: 'update_project',
  title: 'Update a project',
  description:
    'Changes project fields. Send only what changes; null clears a field, and a list replaces the whole list. contact_email cannot change after launch, and after launch an edit reaches only the listings not yet sent to their directory.',
  operations: ['updateProject'],
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: z.object({
    project_id: projectId,
    url: z.string().max(2048).optional(),
    ...projectFields,
  }),
  async run(args, { api }) {
    const { project_id, ...fields } = args;
    if (Object.keys(fields).length === 0) return refusal('Nothing to change: send at least one field.');
    const result = await api.request<S['Project']>({ method: 'PATCH', path: `/projects/${project_id}`, json: fields });
    if (!result.ok) return failure(result.error);
    return success({ project: projectView(result.data) });
  },
});

export const deleteDraft = defineTool({
  name: 'delete_draft',
  title: 'Delete a draft project',
  description: 'Deletes a project that was never launched. A launched project cannot be deleted.',
  operations: ['deleteProject'],
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({ project_id: projectId }),
  async run(args, { api }) {
    const result = await api.request<S['Deleted']>({ method: 'DELETE', path: `/projects/${args.project_id}` });
    if (!result.ok) return failure(result.error);
    return success({ deleted: true, id: args.project_id });
  },
});
