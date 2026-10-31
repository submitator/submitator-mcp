import * as z from 'zod';
import { listingView, pick } from '../projections.js';
import { failure, success } from '../result.js';
import type { components } from '../v1.js';
import { listingId } from './schemas.js';
import { defineTool } from './types.js';

type S = components['schemas'];

// Listed only with a sbm_test_ key.

export const advanceTestListing = defineTool({
  name: 'advance_test_listing',
  title: 'Move a test listing forward',
  description: 'Test mode only: moves a test listing to its next status, or to `to`, without waiting.',
  operations: ['advanceTestListing'],
  // Overwrites the listing's status, and from then on it no longer moves on its own.
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  modes: ['test'],
  input: z.object({
    listing_id: listingId,
    to: z.enum(['in_progress', 'action_required', 'submitted', 'live', 'not_accepted', 'cancelled']).optional(),
  }),
  async run(args, { api }) {
    const result = await api.request<S['Listing']>({
      method: 'POST',
      path: `/test_helpers/listings/${args.listing_id}/advance`,
      json: args.to ? { to: args.to } : {},
    });
    if (!result.ok) return failure(result.error);
    return success({ listing: listingView(result.data) });
  },
});

export const setTestLaunches = defineTool({
  name: 'set_test_launches',
  title: 'Set test launches',
  description: 'Test mode only: sets how many test launches the agency has (0 to 1000), for example to try running out.',
  operations: ['setTestLaunches'],
  // Overwrites the agency's count of test launches.
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  modes: ['test'],
  input: z.object({ available: z.number().int().min(0).max(1000) }),
  async run(args, { api }) {
    const result = await api.request<S['Account']>({
      method: 'POST',
      path: '/test_helpers/account/launches',
      json: { available: args.available },
    });
    if (!result.ok) return failure(result.error);
    return success({ launches: pick(result.data.launches, ['available', 'used', 'total']) });
  },
});
