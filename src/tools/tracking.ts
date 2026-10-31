import * as z from 'zod';
import { eventRow, listingRow, listingView } from '../projections.js';
import { failure, refusal, success } from '../result.js';
import type { components } from '../v1.js';
import { cursor, directoryId, limit, listingId, projectId } from './schemas.js';
import { defineTool } from './types.js';

type S = components['schemas'];

export const listListings = defineTool({
  name: 'list_listings',
  title: "List a project's listings",
  description:
    "A project's listings, one per directory, highest DR first, with status and the live link once published. Or one listing in full by its id.",
  operations: ['listProjectListings', 'getListing'],
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  input: z.object({
    project_id: projectId.optional(),
    listing_id: listingId.optional().describe('Read this one listing instead'),
    status: z.enum(['pending', 'in_progress', 'action_required', 'submitted', 'live', 'not_accepted', 'cancelled']).optional(),
    directory: directoryId.optional().describe('Only the listing on this directory'),
    cursor: cursor.optional(),
    limit: limit(50, 25),
  }),
  async run(args, { api }) {
    if (args.listing_id) {
      const one = await api.request<S['Listing']>({ method: 'GET', path: `/listings/${args.listing_id}` });
      if (!one.ok) return failure(one.error);
      return success({ listing: listingView(one.data) });
    }
    if (!args.project_id) return refusal('Send project_id, or listing_id for one listing.');
    const result = await api.request<S['ListingList']>({
      method: 'GET',
      path: `/projects/${args.project_id}/listings`,
      query: { status: args.status, directory: args.directory, cursor: args.cursor, limit: args.limit ?? 25 },
    });
    if (!result.ok) return failure(result.error);
    return success({
      listings: result.data.data.map(listingRow),
      has_more: result.data.has_more,
      next_cursor: result.data.next_cursor ?? undefined,
    });
  },
});


const PAGE = 100;
const MAX_PAGES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export const listEvents = defineTool({
  name: 'list_events',
  title: 'What changed',
  description:
    'Changes to projects and listings. The feed keeps 90 days and reads oldest first, so one call scans up to 1,000 events from the cursor (or from the start) and returns the newest ones since `since` (7 days ago by default). Passed back in a later call, its next_cursor reads only what came after. For the current state of a project, get_project and list_listings are cheaper.',
  operations: ['listEvents'],
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  input: z.object({
    project_id: projectId.optional().describe('Only this project'),
    type: z.string().max(40).optional().describe('A type such as listing.live, or a group: listing.*, project.*, report.*'),
    since: z.string().datetime({ offset: true }).optional().describe('ISO time; 7 days ago by default, none when a cursor is given'),
    cursor: cursor.optional().describe('next_cursor from an earlier call: continues from there'),
    limit: limit(100, 25),
  }),
  async run(args, { api }) {
    const size = args.limit ?? 25;
    const filters = { type: args.type, project: args.project_id };
    const since = args.since ? Date.parse(args.since) : args.cursor ? undefined : Date.now() - 7 * DAY_MS;

    // The walk is bounded; next_cursor lets a later call resume where it stopped.
    const rows: ReturnType<typeof eventRow>[] = [];
    let next = args.cursor;
    let scannedUntil: string | undefined;
    let complete = false;
    for (let pages = 0; pages < MAX_PAGES; pages += 1) {
      const page = await api.request<S['EventList']>({ method: 'GET', path: '/events', query: { ...filters, cursor: next, limit: PAGE } });
      if (!page.ok) return expired(page.error) ?? failure(page.error);
      for (const event of page.data.data) {
        scannedUntil = event.created_at;
        if (since === undefined || Date.parse(event.created_at) >= since) rows.push(eventRow(event));
      }
      next = page.data.next_cursor;
      if (!page.data.has_more) {
        complete = true;
        break;
      }
    }
    const kept = rows.slice(-size);
    return success({
      since: since === undefined ? undefined : new Date(since).toISOString(),
      events: kept,
      older_left_out: rows.length > kept.length ? rows.length - kept.length : undefined,
      scanned_until: scannedUntil,
      next_cursor: next,
      complete,
      note: complete
        ? undefined
        : 'More events follow: call again with next_cursor (and the same since), or narrow it with project_id or type.',
    });
  },
});

function expired(error: { code: string }) {
  return error.code === 'cursor_expired'
    ? refusal('The cursor is too old (events are kept 90 days). Call again without a cursor, with since.')
    : undefined;
}
