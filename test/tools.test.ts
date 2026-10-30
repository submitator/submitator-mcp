import { describe, expect, it, vi } from 'vitest';
import type { Confirm } from '../src/tools/consent.js';
import { listed, TOOLS } from '../src/tools/index.js';
import type { LocalFiles, ToolSpec } from '../src/tools/types.js';
import { context, example, json, out, textOf, type Route } from './helpers.js';

const tool = (name: string) => TOOLS.find((item) => item.name === name) as ToolSpec;
const PROJECT = 'prj_4QzX1m9Lr2Vb7Nc8Tk3HwP';
const route = (method: string, path: RegExp, respond: Route['respond']): Route => ({ method, path, respond });
const dir = (index: number) => `dir_${String(index).padStart(22, '0')}`;

describe('which tools are listed', () => {
  const names = (mode: 'live' | 'test' | null, transport: 'stdio' | 'http') =>
    TOOLS.filter((item) => listed(item, mode, transport)).map((item) => item.name);

  it('shows test helpers only to test keys, and share links never to them', () => {
    expect(names('test', 'stdio')).toContain('advance_test_listing');
    expect(names('test', 'stdio')).not.toContain('create_share_link');
    expect(names('live', 'stdio')).toContain('create_share_link');
    expect(names('live', 'stdio')).not.toContain('advance_test_listing');
  });

  it('shows the live set when there is no key, so a registry sees the real tools', () => {
    expect(names(null, 'http')).toEqual(names('live', 'http'));
  });

  it('saves files only on stdio', () => {
    expect(names('live', 'stdio')).toContain('save_report_file');
    expect(names('live', 'http')).not.toContain('save_report_file');
  });

  it('offers a local file path for images only on stdio', () => {
    const logo = tool('set_logo').input as (transport: string) => { shape: Record<string, unknown> };
    expect(Object.keys(logo('stdio').shape)).toContain('file_path');
    expect(Object.keys(logo('http').shape)).not.toContain('file_path');
  });

  it('keeps auto_replace out of project edits: it can submit at once', () => {
    const shape = (name: string) => Object.keys((tool(name).input as { shape: Record<string, unknown> }).shape);
    expect(shape('update_project')).not.toContain('auto_replace');
    expect(shape('create_project')).not.toContain('auto_replace');
    expect(shape('launch_project')).toContain('auto_replace');
  });
});

describe('whoami', () => {
  it('joins the key and the account, and keeps test launches apart from bought ones', async () => {
    const { ctx, calls } = context([
      route('GET', /\/ping$/, () => json(example('getPing'))),
      route('GET', /\/account$/, () => json(example('getAccount'))),
    ]);
    const result = out(await tool('whoami').run({}, ctx));
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ mode: 'test', key_permissions: expect.any(String), test_launches: expect.any(Object) });
    expect(result.structuredContent.launches).toBeUndefined();
    expect(textOf(result)).toContain('nothing is submitted');
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/v1/ping', '/v1/account']);
  });
});

describe('create_project and update_project', () => {
  it('creates with an Idempotency-Key and tells the next steps for test mode', async () => {
    const { ctx, calls } = context([route('POST', /\/projects$/, () => json(example('createProject'), 201))]);
    const result = await tool('create_project').run({ url: 'https://acme.test' }, ctx);
    expect(out(result).isError).toBeFalsy();
    expect(calls[0]?.headers.get('idempotency-key')).toBeTruthy();
    expect(await calls[0]?.json()).toEqual({ url: 'https://acme.test' });
    expect(textOf(result)).toContain('placeholders');
  });

  it('refuses an update with nothing in it, without calling the API', async () => {
    const { ctx, calls } = context([]);
    const result = out(await tool('update_project').run({ project_id: PROJECT }, ctx));
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('sends only the fields that change, empty lists included', async () => {
    const { ctx, calls } = context([route('PATCH', /\/projects\/prj_/, () => json(example('updateProject')))]);
    await tool('update_project').run({ project_id: PROJECT, tagline: null, excluded_directories: [] }, ctx);
    expect(await calls[0]?.json()).toEqual({ tagline: null, excluded_directories: [] });
  });
});

describe('images', () => {
  const files: LocalFiles = {
    read: vi.fn(async () => ({ bytes: new Uint8Array([137, 80, 78, 71]), type: 'image/png', extension: 'png' })),
    write: vi.fn(),
  };

  it('needs exactly one of url and file_path', async () => {
    const { ctx, calls } = context([], { files });
    expect(out(await tool('set_logo').run({ project_id: PROJECT }, ctx)).isError).toBe(true);
    expect(out(await tool('set_logo').run({ project_id: PROJECT, url: 'https://a.test/x.png', file_path: '/x.png' }, ctx)).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('imports a URL as JSON', async () => {
    const { ctx, calls } = context([route('PUT', /\/logo$/, () => json(example('setProjectLogo')))], { files });
    const result = out(await tool('set_logo').run({ project_id: PROJECT, url: 'https://a.test/x.png' }, ctx));
    expect(result.isError).toBeFalsy();
    expect(await calls[0]?.json()).toEqual({ url: 'https://a.test/x.png' });
  });

  it('uploads a local file as multipart under a neutral name', async () => {
    const { ctx, calls } = context([route('POST', /\/screenshots$/, () => json(example('addProjectScreenshot')))], { files });
    const result = out(await tool('add_screenshot').run({ project_id: PROJECT, file_path: 'Jane Doe dashboard.png' }, ctx));
    expect(result.isError).toBeFalsy();
    expect(calls[0]?.headers.get('content-type')).toMatch(/^multipart\/form-data/);
    const form = await calls[0]?.formData();
    expect((form?.get('file') as File).name).toBe('screenshot.png');
  });
});

describe('preview, launch and add', () => {
  const ready = (overrides: Record<string, any> = {}) => {
    const base = example('getProjectReadiness');
    return { ...base, ready: true, missing: [], cost: { launches: 1, available: 3 }, ...overrides };
  };
  const project = () => ({ ...example('getProject'), id: PROJECT });
  // 10 fitting directories (2 suggested, 8 open), 1 excluded and 1 article platform.
  const choices = () => {
    const base = example('listProjectDirectories');
    const row = base.directories[0];
    const entry = (index: number, state: string, kind = 'directory') => ({ ...row, state, directory: { ...row.directory, id: dir(index), kind } });
    base.limit = 100;
    base.directories = [
      ...[0, 1].map((index) => entry(index, 'suggested')),
      ...[2, 3, 4, 5, 6, 7, 8, 9].map((index) => entry(index, 'open')),
      entry(10, 'excluded'),
      entry(11, 'open', 'article'),
    ];
    return base;
  };
  const routes = (readiness: object, extra: Route[] = []) => [
    route('GET', /\/projects\/prj_[^/]+$/, () => json(project())),
    route('GET', /\/readiness$/, () => json(readiness)),
    route('GET', /\/projects\/prj_[^/]+\/directories$/, () => json(choices())),
    ...extra,
  ];
  const posts = (calls: Request[]) => calls.filter((call) => call.method === 'POST');

  it('previews the auto pick with the readiness count', async () => {
    const readiness = ready();
    const { ctx } = context(routes(readiness));
    const result = out(await tool('preview_launch').run({ project_id: PROJECT }, ctx));
    expect(result.structuredContent).toMatchObject({ for: 'launch_project', would_submit: readiness.directories.selected });
    expect(textOf(result)).toContain(`confirm_selected: ${readiness.directories.selected}`);
  });

  it('counts an exclude list and a replaced exclusion list the way the API picks', async () => {
    const { ctx } = context(routes(ready()));
    const exclude = out(await tool('preview_launch').run({ project_id: PROJECT, directories: { exclude: [dir(0)] } }, ctx));
    expect(exclude.structuredContent.would_submit).toBe(9);
    const replaced = out(await tool('preview_launch').run({ project_id: PROJECT, excluded_directories: [] }, ctx));
    expect(replaced.structuredContent.would_submit).toBe(11);
  });

  it('counts include with auto_replace as the size it grows to', async () => {
    const { ctx } = context(routes(ready()));
    const plain = out(await tool('preview_launch').run({ project_id: PROJECT, directories: { include: [dir(0), dir(11)] } }, ctx));
    expect(plain.structuredContent.would_submit).toBe(2);
    const growing = out(
      await tool('preview_launch').run({ project_id: PROJECT, directories: { include: [dir(0), dir(11)] }, auto_replace: true }, ctx),
    );
    expect(growing.structuredContent.would_submit).toBe(11);
  });

  it('says why a launch cannot happen, without launching', async () => {
    const missing = context(routes(ready({ ready: false, missing: ['logo'] })));
    const result = out(await tool('launch_project').run({ project_id: PROJECT, confirm_selected: 10 }, missing.ctx));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('logo');
    const none = context(routes(ready({ ready: false, cost: { launches: 1, available: 0 } })));
    expect(textOf(await tool('launch_project').run({ project_id: PROJECT, confirm_selected: 10 }, none.ctx))).toContain('set_test_launches');
    const launched = context(routes(ready({ cost: { launches: 0, available: 3 } })));
    expect(textOf(await tool('launch_project').run({ project_id: PROJECT, confirm_selected: 10 }, launched.ctx))).toContain('add_directories');
    expect([...missing.calls, ...none.calls, ...launched.calls].filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('refuses a count that does not match, and does not hand over the right one', async () => {
    const readiness = ready();
    const selected = readiness.directories.selected;
    const { ctx, calls } = context(routes(readiness));
    const result = out(await tool('launch_project').run({ project_id: PROJECT, confirm_selected: selected + 1 }, ctx));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('preview_launch');
    expect(textOf(result)).not.toContain(String(selected));
    expect(posts(calls)).toHaveLength(0);
  });

  it('launches with the same arguments once the count matches', async () => {
    const { ctx, calls } = context(routes(ready(), [route('POST', /\/launch$/, () => json(example('launchProject'), 202))]));
    const args = { project_id: PROJECT, directories: { exclude: [dir(0)] }, excluded_directories: [] };
    // The empty list frees the excluded directory: 11 fit, 10 without the exclude.
    expect(out(await tool('launch_project').run({ ...args, confirm_selected: 9 }, ctx)).isError).toBe(true);
    const result = out(await tool('launch_project').run({ ...args, confirm_selected: 10 }, ctx));
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(posts(calls)).toHaveLength(1);
    expect(posts(calls)[0]?.headers.get('idempotency-key')).toBeTruthy();
    expect(await posts(calls)[0]?.json()).toEqual({ directories: { exclude: [dir(0)] }, excluded_directories: [] });
    expect(textOf(result)).toContain('test launch');
  });

  describe('asking the person with a live key', () => {
    const ask = (answer: Awaited<ReturnType<Confirm>>) => vi.fn<Confirm>(async () => answer);

    it('launches only after the person confirms', async () => {
      const readiness = ready();
      const confirm = ask({ kind: 'confirmed' });
      const { ctx, calls } = context(routes(readiness, [route('POST', /\/launch$/, () => json(example('launchProject'), 202))]), {
        mode: 'live',
        confirm,
      });
      const result = out(await tool('launch_project').run({ project_id: PROJECT, confirm_selected: readiness.directories.selected }, ctx));
      expect(result.isError).toBeFalsy();
      expect(confirm).toHaveBeenCalledOnce();
      expect(confirm.mock.calls[0]?.[1]).toMatch(/spends one of your 3 launches/);
      expect(posts(calls)).toHaveLength(1);
    });

    it('does nothing when the person declines', async () => {
      const readiness = ready();
      const { ctx, calls } = context(routes(readiness), { mode: 'live', confirm: ask({ kind: 'declined' }) });
      const result = out(await tool('launch_project').run({ project_id: PROJECT, confirm_selected: readiness.directories.selected }, ctx));
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('did not confirm');
      expect(posts(calls)).toHaveLength(0);
    });

    it('returns the question for a 2026 client to ask, without launching', async () => {
      const readiness = ready();
      const question = { resultType: 'input_required', inputRequests: {} } as never;
      const { ctx, calls } = context(routes(readiness), { mode: 'live', confirm: ask({ kind: 'ask', result: question }) });
      expect(await tool('launch_project').run({ project_id: PROJECT, confirm_selected: readiness.directories.selected }, ctx)).toBe(question);
      expect(posts(calls)).toHaveLength(0);
    });

    it('never asks in test mode', async () => {
      const readiness = ready();
      const confirm = ask({ kind: 'declined' });
      const { ctx } = context(routes(readiness, [route('POST', /\/launch$/, () => json(example('launchProject'), 202))]), { confirm });
      expect(out(await tool('launch_project').run({ project_id: PROJECT, confirm_selected: readiness.directories.selected }, ctx)).isError).toBeFalsy();
      expect(confirm).not.toHaveBeenCalled();
    });
  });

  it('adds to a launched project only with a selection and a matching count', async () => {
    const readiness = ready({ cost: { launches: 0, available: 3 }, directories: { selected: 4, limit: 40, top_domain_rating: 70, median_domain_rating: 50 } });
    const { ctx, calls } = context(routes(readiness, [route('POST', /\/listings$/, () => json(example('addProjectListings'), 202))]));
    const result = out(await tool('add_directories').run({ project_id: PROJECT, directories: 'auto', confirm_selected: 4 }, ctx));
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(await posts(calls)[0]?.json()).toEqual({ directories: 'auto' });
    const draft = context(routes(ready()));
    expect(textOf(await tool('add_directories').run({ project_id: PROJECT, directories: 'auto', confirm_selected: 4 }, draft.ctx))).toContain(
      'launch_project',
    );
  });
});

describe('create_share_link', () => {
  it('returns the current link instead of replacing it', async () => {
    const { ctx, calls } = context([route('GET', /\/share_link$/, () => json(example('getShareLink')))], { mode: 'live' });
    const result = out(await tool('create_share_link').run({ project_id: PROJECT }, ctx));
    expect(result.structuredContent).toMatchObject({ existing: true });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('creates one when there is none, or when asked to replace', async () => {
    const notFound = { error: { code: 'not_found', message: 'No share link.' } };
    const { ctx, calls } = context(
      [route('GET', /\/share_link$/, () => json(notFound, 404)), route('POST', /\/share_link$/, () => json(example('createShareLink'), 201))],
      { mode: 'live' },
    );
    expect(out(await tool('create_share_link').run({ project_id: PROJECT }, ctx)).structuredContent).toMatchObject({ existing: false });
    await tool('create_share_link').run({ project_id: PROJECT, replace: true }, ctx);
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(1);
  });
});

describe('list_events', () => {
  const event = (id: number, createdAt: string) => ({ ...example('getEvent'), id: `evt_${String(id).padStart(22, '0')}`, created_at: createdAt });
  const page = (events: unknown[], hasMore: boolean, next: string) => ({ object: 'list', data: events, has_more: hasMore, next_cursor: next });

  it('walks forward to the changes since a time and keeps the cursor', async () => {
    const pages = [page([event(1, '2026-10-01T00:00:00Z'), event(2, '2026-10-20T00:00:00Z')], true, 'c1'), page([event(3, '2026-10-25T00:00:00Z')], false, 'c2')];
    let served = 0;
    const { ctx, calls } = context([route('GET', /\/events$/, () => json(pages[served++]))]);
    const body = out(await tool('list_events').run({ since: '2026-10-15T00:00:00Z' }, ctx)).structuredContent;
    expect(body.events.map((item: { id: string }) => item.id.slice(-1))).toEqual(['2', '3']);
    expect(body).toMatchObject({ next_cursor: 'c2', complete: true, scanned_until: '2026-10-25T00:00:00Z' });
    expect(new URL(calls[1]?.url ?? '').searchParams.get('cursor')).toBe('c1');
  });

  it('continues from a cursor with the same bounded walk, and says when more follow', async () => {
    const { ctx, calls } = context([route('GET', /\/events$/, () => json(page([event(1, '2026-10-29T00:00:00Z')], true, 'more')))]);
    const body = out(await tool('list_events').run({ cursor: 'start' }, ctx)).structuredContent;
    expect(calls).toHaveLength(10);
    expect(new URL(calls[0]?.url ?? '').searchParams.get('cursor')).toBe('start');
    expect(body).toMatchObject({ complete: false, next_cursor: 'more' });
    expect(body.events).toHaveLength(10);
  });

  it('explains an expired cursor', async () => {
    const expired = { error: { code: 'cursor_expired', message: 'Gone.' } };
    const { ctx } = context([route('GET', /\/events$/, () => json(expired, 410))]);
    const result = out(await tool('list_events').run({ cursor: 'old' }, ctx));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('without a cursor');
  });
});

describe('project_directories', () => {
  it('lists suggested, open and locked by default, counts every state, and pages', async () => {
    const base = example('listProjectDirectories');
    const row = base.directories[0];
    const states = ['listed', 'locked', 'excluded', 'suggested', 'open'];
    base.directories = Array.from({ length: 150 }, (_, index) => ({
      ...row,
      state: states[index % 5],
      directory: { ...row.directory, id: dir(index), name: `Directory ${index}` },
    }));
    const { ctx } = context([route('GET', /\/directories$/, () => json(base))]);
    const first = out(await tool('project_directories').run({ project_id: PROJECT }, ctx)).structuredContent;
    expect(first.counts).toEqual({ listed: 30, locked: 30, excluded: 30, suggested: 30, open: 30 });
    expect(first.pick_limit).toBe(base.limit);
    expect(first.directories).toHaveLength(50);
    expect(first.directories.every((item: { state: string }) => ['suggested', 'open', 'locked'].includes(item.state))).toBe(true);
    expect(first.next_offset).toBe(50);
    const last = out(await tool('project_directories').run({ project_id: PROJECT, offset: 50 }, ctx)).structuredContent;
    expect(last.directories).toHaveLength(40);
    expect(last.next_offset).toBeUndefined();
  });
});

describe('reports', () => {
  const ready = (overrides: Record<string, unknown> = {}) => ({ ...example('getReport'), status: 'ready', file_name: 'acme.pdf', format: 'pdf', ...overrides });
  const REPORT = 'rep_4QzX1m9Lr2Vb7Nc8Tk3HwP';

  it('points the remote server to the client page of a live project', async () => {
    const { ctx } = context(
      [route('GET', /\/reports\/rep_/, () => json(ready())), route('GET', /\/share_link$/, () => json(example('getShareLink')))],
      { mode: 'live', transport: 'http' },
    );
    const result = out(await tool('get_report').run({ report_id: REPORT }, ctx));
    expect(result.structuredContent).toMatchObject({ client_page: expect.stringMatching(/^https:/) });
  });

  it('saves a ready file on stdio under its format', async () => {
    const write = vi.fn(async (_dir: string | undefined, name: string, bytes: Uint8Array) => ({ path: `/tmp/${name}`, size: bytes.byteLength }));
    const files: LocalFiles = { read: vi.fn(), write };
    const { ctx } = context(
      [
        route('GET', /\/reports\/rep_[^/]+$/, () => json(ready({ file_name: 'acme.exe' }))),
        route('GET', /\/file$/, () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/pdf' } })),
      ],
      { files },
    );
    const result = out(await tool('save_report_file').run({ report_id: REPORT }, ctx));
    expect(result.structuredContent).toEqual({ saved: '/tmp/acme.pdf', bytes: 3 });
    expect(write).toHaveBeenCalledWith(undefined, 'acme.pdf', expect.any(Uint8Array));
  });

  it('never saves a report with logins, nor one that is not ready', async () => {
    const files: LocalFiles = { read: vi.fn(), write: vi.fn() };
    const logins = context([route('GET', /\/reports\/rep_/, () => json(ready({ include_logins: true })))], { files });
    const result = out(await tool('save_report_file').run({ report_id: REPORT }, logins.ctx));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('logins');
    expect(logins.calls).toHaveLength(1);
    const building = context([route('GET', /\/reports\/rep_/, () => json(ready({ status: 'building' })))], { files });
    expect(out(await tool('save_report_file').run({ report_id: REPORT }, building.ctx)).isError).toBe(true);
    expect(files.write).not.toHaveBeenCalled();
  });
});
