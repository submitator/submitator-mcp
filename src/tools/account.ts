import * as z from 'zod';
import { accountView } from '../projections.js';
import { failure, success } from '../result.js';
import type { components } from '../v1.js';
import { defineTool } from './types.js';

type S = components['schemas'];

export const whoami = defineTool({
  name: 'whoami',
  title: 'Check the API key',
  description:
    'Shows the agency and mode (live or test) behind the key, its permissions, launches left and the hourly request budget. Call it first.',
  operations: ['getPing', 'getAccount'],
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  input: z.object({}),
  async run(_args, { api }) {
    const ping = await api.request<S['Ping']>({ method: 'GET', path: '/ping' });
    if (!ping.ok) return failure(ping.error);
    const account = await api.request<S['Account']>({ method: 'GET', path: '/account' });
    if (!account.ok) return failure(account.error);
    const view = accountView(ping.data, account.data);
    return success({
      ...view,
      note:
        view.mode === 'test'
          ? 'Test mode: projects and listings are test data, nothing is submitted, and test launches are not bought ones.'
          : 'Live mode: launch_project spends one of the agency launches.',
    });
  },
});
