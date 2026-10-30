// Compact views of API objects. A model reads every byte of a tool result, and
// some API objects are large (a project directory list is the whole catalog,
// an event carries a whole project), so each view keeps what a decision needs.
// Keys are listed one by one: a new field in the API never reaches the model
// by accident, and an unknown enum value passes through as a plain string.
import type { components } from './v1.js';

type S = components['schemas'];

export function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    if (Array.isArray(item) && item.length === 0) continue;
    out[key] = item;
  }
  return out as Partial<T>;
}

// Copies the named keys of a nested object, so its new fields stay out too.
export function pick<K extends string>(value: unknown, keys: readonly K[]): Partial<Record<K, unknown>> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const out: Partial<Record<K, unknown>> = {};
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) out[key] = source[key];
  }
  return out;
}

const PROGRESS = ['total', 'pending', 'in_progress', 'action_required', 'submitted', 'live', 'not_accepted', 'cancelled'] as const;
const ALLOWANCE = ['total', 'used', 'reserved', 'available'] as const;

function stringPairs(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const pairs = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return pairs.length > 0 ? Object.fromEntries(pairs) : undefined;
}

export function accountView(ping: S['Ping'], account: S['Account']) {
  const launches = pick(account.launches, ['available', 'used', 'total']);
  return compact({
    mode: account.livemode ? 'live' : 'test',
    agency: account.name,
    state: account.state,
    key_permissions: ping.key?.permissions,
    // Test mode has its own launches (100 to start); never present them as bought ones.
    launches: account.livemode ? launches : undefined,
    test_launches: account.livemode ? undefined : launches,
    capacity: pick(account.capacity, ['in_flight', 'limit']),
    rate_limit: pick(account.rate_limit, ['limit', 'remaining', 'resets_at']),
  });
}

export function projectRow(project: S['Project']) {
  return compact({
    id: project.id,
    name: project.name,
    url: project.url,
    status: project.status,
    hold_reason: project.hold_reason,
    action: project.action
      ? compact({ code: project.action.code, waiting_on: project.action.waiting_on, client_message: project.action.client_message })
      : undefined,
    live: project.progress?.live,
    total: project.progress?.total,
    launched_at: project.launched_at,
    external_id: project.external_id,
  });
}

export function imageView(image: S['Image'] | null | undefined) {
  if (!image) return undefined;
  const error = image.error as { message?: string } | null | undefined;
  return compact({ id: image.id, status: image.status, url: image.url, error: error?.message });
}

export function projectView(project: S['Project']) {
  return compact({
    id: project.id,
    name: project.name,
    url: project.url,
    status: project.status,
    hold_reason: project.hold_reason,
    action: project.action
      ? compact({ code: project.action.code, waiting_on: project.action.waiting_on, client_message: project.action.client_message })
      : undefined,
    readiness: pick(project.readiness, ['ready', 'missing']),
    progress: pick(project.progress, PROGRESS),
    allowance: pick(project.allowance, ALLOWANCE),
    badge: pick(project.badge, ['status', 'checked_at']),
    domain_rating: project.domain_rating,
    maker_name: project.maker_name,
    contact_email: project.contact_email,
    tagline: project.tagline,
    short_description: project.short_description,
    long_description: project.long_description,
    category: project.category,
    pricing_model: project.pricing_model,
    price_amount_cents: project.price_amount_cents,
    price_period: project.price_period,
    launch_date: project.launch_date,
    twitter_url: project.twitter_url,
    competitors: project.competitors?.map((competitor) => pick(competitor, ['name', 'url'])),
    tags: project.tags,
    audience: pick(project.audience, ['b2b', 'ai', 'directory']),
    promo_code: project.promo_code,
    promo_description: project.promo_description,
    logo: imageView(project.logo),
    screenshots: project.screenshots?.map((image) => imageView(image)),
    autofill: project.autofill
      ? compact({
          status: project.autofill.status,
          filled: project.autofill.filled,
          image_candidates: project.autofill.image_candidates
            ?.slice(0, 8)
            .map((candidate) => ({ url: candidate.url, suggested_as: candidate.suggested_as })),
        })
      : undefined,
    auto_replace: project.auto_replace,
    excluded_directories: project.excluded_directories,
    external_id: project.external_id,
    // The agency's own key-value pairs: their keys are theirs to choose.
    metadata: stringPairs(project.metadata),
    created_at: project.created_at,
    launched_at: project.launched_at,
  });
}

export function readinessView(readiness: S['Readiness']) {
  return compact({
    project: readiness.project,
    ready: readiness.ready,
    missing: readiness.missing,
    directories: pick(readiness.directories, ['selected', 'limit', 'top_domain_rating', 'median_domain_rating']),
    unlocks: readiness.unlocks?.map((unlock) => pick(unlock, ['requirement', 'directories', 'how'])),
    not_matching: pick(readiness.not_matching, ['b2b_only', 'ai_only', 'directories_only', 'other']),
    cost: pick(readiness.cost, ['launches', 'available']),
  });
}

export function directoryView(directory: S['Directory']) {
  return compact({
    id: directory.id,
    name: directory.name,
    url: directory.url,
    dr: directory.domain_rating,
    topic: directory.topic,
    backlink: directory.backlink,
    backlink_condition: directory.backlink_condition,
    requires: directory.requires,
    kind: directory.kind === 'article' ? directory.kind : undefined,
    outdated: directory.outdated === true ? true : undefined,
  });
}

export function projectDirectoryRow(entry: S['ProjectDirectory']) {
  return compact({
    id: entry.directory.id,
    name: entry.directory.name,
    dr: entry.directory.domain_rating,
    backlink: entry.directory.backlink,
    kind: entry.directory.kind === 'article' ? entry.directory.kind : undefined,
    state: entry.state,
    reason: entry.reason,
    backlink_condition: entry.directory.backlink_condition,
    outdated: entry.directory.outdated === true ? true : undefined,
    message: entry.state === 'locked' ? entry.message : undefined,
    listing: entry.listing,
  });
}

export function listingRow(listing: S['Listing']) {
  return compact({
    id: listing.id,
    directory: listing.directory?.name,
    directory_id: listing.directory?.id,
    dr: listing.directory?.domain_rating,
    status: listing.status,
    reason: listing.reason,
    action: listing.action ? compact({ code: listing.action.code, waiting_on: listing.action.waiting_on }) : undefined,
    live_url: listing.live_url,
    // The proof matters when a live listing has no public link.
    proof_url: listing.live_url ? undefined : listing.proof_url,
    submitted_at: listing.submitted_at,
    live_at: listing.live_at,
  });
}

export function listingView(listing: S['Listing']) {
  return compact({
    ...listingRow(listing),
    project: listing.project,
    action: listing.action
      ? compact({ code: listing.action.code, waiting_on: listing.action.waiting_on, client_message: listing.action.client_message })
      : undefined,
    created_at: listing.created_at,
  });
}

// An event carries the whole object it is about; the row keeps what changed.
export function eventRow(event: S['Event']) {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const object = (data.object ?? {}) as Record<string, unknown>;
  const directory = object.directory as { name?: string } | undefined;
  return compact({
    id: event.id,
    type: event.type,
    created_at: event.created_at,
    project: event.project,
    object_id: typeof object.id === 'string' ? object.id : undefined,
    name: typeof object.name === 'string' ? object.name : directory?.name,
    status: typeof object.status === 'string' ? object.status : undefined,
    previous_status: typeof data.previous_status === 'string' ? data.previous_status : undefined,
    live_url: typeof object.live_url === 'string' ? object.live_url : undefined,
    reason: typeof object.reason === 'string' ? object.reason : undefined,
    listings_created: typeof data.listings_created === 'number' ? data.listings_created : undefined,
    listings_added: typeof data.listings_added === 'number' ? data.listings_added : undefined,
  });
}

export function badgeView(badge: S['Badge'], platform?: string) {
  const recipes = badge.recipes ?? [];
  const recipe = platform ? recipes.find((item) => item.platform === platform) : undefined;
  return compact({
    project: badge.project,
    status: badge.status,
    checked_at: badge.checked_at,
    feed: pick(badge.feed, ['json_url', 'html_url']),
    check_command: badge.check_command,
    client_message: badge.client_message,
    platforms: recipes.map((item) => item.platform),
    recipe: recipe ? { platform: recipe.platform, title: recipe.title, language: recipe.language, code: recipe.code } : undefined,
  });
}

export function reportView(report: S['Report']) {
  return compact({
    id: report.id,
    project: report.project,
    format: report.format,
    include_logins: report.include_logins === true ? true : undefined,
    status: report.status,
    file_name: report.file_name,
    created_at: report.created_at,
    ready_at: report.ready_at,
    expires_at: report.expires_at,
  });
}

export function shareLinkView(link: S['ShareLink']) {
  return compact({
    project: link.project,
    url: link.url,
    created_at: link.created_at,
    expires_at: link.expires_at,
    revoked_at: link.revoked_at,
    last_viewed_at: link.last_viewed_at,
    view_count: link.view_count,
  });
}
