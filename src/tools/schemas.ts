// Input pieces shared by the tools. Limits mirror the /v1 contract, which
// still validates everything; descriptions stay one line, since a client
// sends every tool's schema to the model on every turn.
import * as z from 'zod';

const id = (prefix: string, what: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-Za-z]{22}$`)).describe(`${what} id (${prefix}_...)`);

export const projectId = id('prj', 'Project');
export const directoryId = id('dir', 'Directory');
export const listingId = id('lst', 'Listing');
export const reportId = id('rep', 'Report');
export const imageId = id('img', 'Screenshot');

export const cursor = z.string().max(500).describe('next_cursor from the previous page');

export const limit = (max: number, fallback: number) =>
  z.number().int().min(1).max(max).optional().describe(`Rows to return, ${fallback} by default, ${max} at most`);

export const directorySelection = z
  .union([
    z.literal('auto'),
    z.object({ include: z.array(directoryId).min(1).max(100) }),
    z.object({ exclude: z.array(directoryId).min(1) }),
  ])
  .describe('"auto" (best matches, highest DR first), {include: [ids]} exactly these, or {exclude: [ids]} auto without these');

const text = (max: number, what: string) => z.string().max(max).nullable().optional().describe(what);

// Fields of ProjectCreate and ProjectUpdate. null or "" clears a field on update.
// auto_replace is left out here: it can submit at once, so only launch_project
// takes it, behind the same preview and confirmation as a launch.
export const projectFields = {
  name: z.string().min(2).max(100).optional().describe('Product name; filled from the site when left out'),
  maker_name: text(100, 'Founder or maker name'),
  contact_email: text(254, 'Email the directories write to; required before launch'),
  tagline: text(100, 'One-line pitch'),
  short_description: text(500, 'Short description'),
  long_description: text(2000, 'Long description'),
  category: z.enum(['saas', 'ai_tools', 'dev_tools', 'no_code', 'productivity', 'other']).nullable().optional(),
  pricing_model: z.enum(['free', 'freemium', 'paid', 'open_source']).nullable().optional(),
  price_amount_cents: z.number().int().min(0).nullable().optional().describe('Price in cents'),
  price_period: z.enum(['monthly', 'yearly', 'one_time']).nullable().optional(),
  launch_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe('YYYY-MM-DD'),
  twitter_url: z.string().max(2048).nullable().optional().describe('https://x.com/... profile'),
  competitors: z
    .array(z.object({ name: z.string().min(1).max(100), url: z.string().max(500) }))
    .max(20)
    .optional()
    .describe('Up to 20, some directories need them. Replaces the whole list: send the current one plus changes'),
  tags: z.array(z.string().min(1).max(40)).max(10).optional().describe('Up to 10. Replaces the whole list'),
  audience: z
    .object({ b2b: z.boolean(), ai: z.boolean(), directory: z.boolean() })
    .optional()
    .describe('Which audience-restricted directories fit the product'),
  promo_code: text(50, 'Discount code some directories ask for'),
  promo_description: text(500, 'What the promo code gives'),
  external_id: text(100, "The agency's own id for this client"),
  metadata: z
    .record(z.string().min(1).max(40), z.string().max(500))
    .optional()
    .describe('Up to 20 string pairs for the agency. Replaces all of it; {} clears it'),
  excluded_directories: z
    .array(directoryId)
    .optional()
    .describe('Directories never to use for this project. Replaces the whole list (read get_project first); [] clears it'),
};
