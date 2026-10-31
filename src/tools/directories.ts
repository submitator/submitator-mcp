import * as z from 'zod';
import { directoryView, projectDirectoryRow } from '../projections.js';
import { failure, success } from '../result.js';
import type { components } from '../v1.js';
import { cursor, directoryId, limit, projectId } from './schemas.js';
import { defineTool } from './types.js';

type S = components['schemas'];

export const findDirectories = defineTool({
  name: 'find_directories',
  title: 'Search the directory catalog',
  description:
    'Searches the directories Submitator submits to, highest Domain Rating first, or reads one by id. Before the agency first buys launches, only the top 20 are shown.',
  operations: ['listDirectories', 'getDirectory'],
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  input: z.object({
    directory_id: directoryId.optional().describe('Read this one directory; other filters are ignored'),
    q: z.string().min(2).max(100).optional().describe('Part of the name'),
    kind: z.enum(['directory', 'article']).optional().describe('article = article platforms, open only through include'),
    topic: z.enum(['startups', 'ai_tools', 'saas', 'dev_tools', 'b2b', 'software', 'other']).optional(),
    min_dr: z.number().int().min(0).max(100).optional().describe('Lowest Domain Rating'),
    requires: z.enum(['badge', 'competitors', 'promo_code', 'none']).optional().describe('What the directory asks for'),
    audience: z.enum(['b2b', 'ai', 'directory', 'any']).optional(),
    cursor: cursor.optional(),
    limit: limit(50, 25),
  }),
  async run(args, { api }) {
    if (args.directory_id) {
      const one = await api.request<S['Directory']>({ method: 'GET', path: `/directories/${args.directory_id}` });
      if (!one.ok) return failure(one.error);
      return success({ directory: directoryView(one.data) });
    }
    const result = await api.request<S['DirectoryList']>({
      method: 'GET',
      path: '/directories',
      query: {
        q: args.q,
        kind: args.kind,
        topic: args.topic,
        min_dr: args.min_dr,
        requires: args.requires,
        audience: args.audience,
        cursor: args.cursor,
        limit: args.limit ?? 25,
      },
    });
    if (!result.ok) return failure(result.error);
    return success({
      directories: result.data.data.map(directoryView),
      has_more: result.data.has_more,
      next_cursor: result.data.next_cursor ?? undefined,
    });
  },
});

const STATES = ['listed', 'locked', 'excluded', 'suggested', 'open'] as const;

export const projectDirectories = defineTool({
  name: 'project_directories',
  title: "A project's directory choices",
  description:
    "Every catalog directory as seen by one project: suggested (the auto pick), open, locked (with what unlocks it), excluded or listed. Shows suggested, open and locked by default; the counts cover all.",
  operations: ['listProjectDirectories'],
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  input: z.object({
    project_id: projectId,
    states: z.array(z.enum(STATES)).min(1).optional().describe('Which states to list; suggested, open and locked by default'),
    offset: z.number().int().min(0).optional().describe('Rows to skip, for the next page'),
    limit: limit(100, 50),
  }),
  async run(args, { api }) {
    const result = await api.request<S['ProjectDirectories']>({ method: 'GET', path: `/projects/${args.project_id}/directories` });
    if (!result.ok) return failure(result.error);
    const wanted = new Set<string>(args.states ?? ['suggested', 'open', 'locked']);
    const counts: Record<string, number> = {};
    for (const entry of result.data.directories) counts[entry.state] = (counts[entry.state] ?? 0) + 1;
    const matching = result.data.directories.filter((entry) => wanted.has(entry.state));
    const offset = args.offset ?? 0;
    const size = args.limit ?? 50;
    const page = matching.slice(offset, offset + size);
    return success({
      project: result.data.project,
      // How many the auto pick takes: 100 before launch, the free allowance after.
      pick_limit: result.data.limit,
      counts,
      directories: page.map(projectDirectoryRow),
      next_offset: offset + size < matching.length ? offset + size : undefined,
    });
  },
});
