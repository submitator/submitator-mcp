// v1 may add fields, enum values and event types at any time (additive
// changes). Tools must pass unknown values through as strings, never leak
// unknown fields, and keep every answer small enough for a model.
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/tools/index.js';
import type { ToolSpec } from '../src/tools/types.js';
import { context, example, json, out, type Route } from './helpers.js';

const tool = (name: string) => TOOLS.find((item) => item.name === name) as ToolSpec;
const PROJECT = 'prj_4QzX1m9Lr2Vb7Nc8Tk3HwP';
const route = (method: string, path: RegExp, body: () => unknown, status = 200): Route => ({
  method,
  path,
  respond: () => json(body(), status),
});

// Adds an unknown field to every object and an unknown value to every status.
function future(value: any): any {
  if (Array.isArray(value)) return value.map(future);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = { zz_new_field: 'zz_leak' };
    for (const [key, item] of Object.entries(value)) {
      // metadata holds the agency's own keys, passed through on purpose.
      if (key === 'metadata') out[key] = item;
      else out[key] = key === 'status' && typeof item === 'string' ? 'zz_new_status' : future(item);
    }
    return out;
  }
  return value;
}

const CASES: Array<{ name: string; args: Record<string, unknown>; routes: Route[] }> = [
  { name: 'whoami', args: {}, routes: [route('GET', /\/ping$/, () => future(example('getPing'))), route('GET', /\/account$/, () => future(example('getAccount')))] },
  { name: 'list_projects', args: {}, routes: [route('GET', /\/projects$/, () => future(example('listProjects')))] },
  { name: 'get_project', args: { project_id: PROJECT }, routes: [route('GET', /\/projects\/prj_[^/]+$/, () => future(example('getProject')))] },
  {
    name: 'preview_launch',
    args: { project_id: PROJECT },
    routes: [
      route('GET', /\/projects\/prj_[^/]+$/, () => future(example('getProject'))),
      route('GET', /\/readiness$/, () => future(example('getProjectReadiness'))),
    ],
  },
  { name: 'find_directories', args: {}, routes: [route('GET', /\/directories$/, () => future(example('listDirectories')))] },
  { name: 'project_directories', args: { project_id: PROJECT }, routes: [route('GET', /\/directories$/, () => future(example('listProjectDirectories')))] },
  { name: 'list_listings', args: { project_id: PROJECT }, routes: [route('GET', /\/listings$/, () => future(example('listProjectListings')))] },
  { name: 'list_events', args: { cursor: 'c' }, routes: [route('GET', /\/events$/, () => future(example('listEvents')))] },
  { name: 'get_badge', args: { project_id: PROJECT, platform: 'nextjs' }, routes: [route('GET', /\/badge$/, () => future(example('getProjectBadge')))] },
  { name: 'get_report', args: { report_id: 'rep_4QzX1m9Lr2Vb7Nc8Tk3HwP' }, routes: [route('GET', /\/reports\//, () => future(example('getReport')))] },
];

describe('additive API changes', () => {
  it.each(CASES)('$name passes new values through and drops new fields', async ({ name, args, routes }) => {
    const { ctx } = context(routes);
    const result = out(await tool(name).run(args, ctx));
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    const text = result.content?.[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual(result.structuredContent);
    expect(text).not.toContain('zz_new_field');
    expect(text).not.toContain('zz_leak');
    if (text.includes('"status"')) expect(text).toContain('zz_new_status');
  });
});

// Claude Code warns above 10k tokens a result; keep each under about 8k
// (4 characters a token), counting the text and the structured copy.
const tokens = (result: unknown) =>
  (JSON.stringify(out(result).content).length + JSON.stringify(out(result).structuredContent ?? '').length) / 4;

function many(operationId: string, count: number, vary: (row: any, index: number) => any) {
  const page = example(operationId);
  const row = page.data[0];
  page.data = Array.from({ length: count }, (_, index) => vary(structuredClone(row), index));
  page.has_more = true;
  page.next_cursor = 'next';
  return page;
}

describe('answer size at the largest page', () => {
  it('list_projects at 50', async () => {
    const { ctx } = context([route('GET', /\/projects$/, () => many('listProjects', 50, (row) => row))]);
    expect(tokens(await tool('list_projects').run({ limit: 50 }, ctx))).toBeLessThan(8000);
  });

  it('find_directories at 50', async () => {
    const { ctx } = context([route('GET', /\/directories$/, () => many('listDirectories', 50, (row) => row))]);
    expect(tokens(await tool('find_directories').run({ limit: 50 }, ctx))).toBeLessThan(8000);
  });

  it('list_listings at 50', async () => {
    const { ctx } = context([route('GET', /\/listings$/, () => many('listProjectListings', 50, (row) => row))]);
    expect(tokens(await tool('list_listings').run({ project_id: PROJECT, limit: 50 }, ctx))).toBeLessThan(8000);
  });

  it('list_events at its largest limit, from 500 scanned events of whole projects', async () => {
    const projectEvent = { ...example('listEvents').data[0], ...example('getEvent') };
    const page = () => ({
      object: 'list',
      data: Array.from({ length: 100 }, (_, index) => ({ ...structuredClone(projectEvent), id: `evt_${String(index).padStart(22, '0')}`, created_at: '2026-10-29T00:00:00Z' })),
      has_more: true,
      next_cursor: 'next',
    });
    const { ctx } = context([route('GET', /\/events$/, page)]);
    const result = await tool('list_events').run({ since: '2026-10-01T00:00:00Z', limit: 50 }, ctx);
    expect(tokens(result)).toBeLessThan(8000);
  });

  it('project_directories at 100 of a 150-directory catalog', async () => {
    const base = example('listProjectDirectories');
    base.directories = Array.from({ length: 150 }, (_, index) => ({ ...base.directories[0], state: 'open', directory: { ...base.directories[0].directory, name: `Directory ${index}` } }));
    const { ctx } = context([route('GET', /\/directories$/, () => base)]);
    expect(tokens(await tool('project_directories').run({ project_id: PROJECT, limit: 100 }, ctx))).toBeLessThan(8000);
  });

  it('get_project and get_badge', async () => {
    const { ctx } = context([
      route('GET', /\/projects\/prj_[^/]+$/, () => example('getProject')),
      route('GET', /\/badge$/, () => example('getProjectBadge')),
    ]);
    expect(tokens(await tool('get_project').run({ project_id: PROJECT }, ctx))).toBeLessThan(3000);
    expect(tokens(await tool('get_badge').run({ project_id: PROJECT }, ctx))).toBeLessThan(1500);
  });
});
