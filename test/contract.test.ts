// Holds the tools equal to the /v1 contract (openapi/v1.json, refreshed by
// npm run sync:openapi): every operation is a tool or EXCLUDED, every tool
// input exists in the contract, and every input enum matches it.
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { EXCLUDED, TOOLS } from '../src/tools/index.js';
import type { ToolSpec, Transport } from '../src/tools/types.js';
import { contract, operation, operations } from './helpers.js';

// Inputs that exist only in the tool: guards, paging over a list the API
// returns whole, and renamed filters.
const LOCAL: Record<string, string[]> = {
  preview_launch: ['directories', 'excluded_directories', 'auto_replace'],
  launch_project: ['confirm_selected'],
  add_directories: ['confirm_selected'],
  project_directories: ['states', 'offset', 'limit'],
  list_events: ['since', 'project_id'],
  set_logo: ['file_path'],
  add_screenshot: ['file_path'],
  remove_image: ['image'],
  get_badge: ['platform'],
  create_share_link: ['replace'],
  save_report_file: ['directory'],
};

function inputSchema(tool: ToolSpec, transport: Transport): any {
  const schema = typeof tool.input === 'function' ? tool.input(transport) : tool.input;
  return z.toJSONSchema(schema, { io: 'input' });
}

function resolve(schema: any): any {
  if (schema?.$ref) return resolve(contract.components.schemas[schema.$ref.split('/').pop()]);
  return schema;
}

function parameter(param: any): any {
  if (param?.$ref) return contract.components.parameters[param.$ref.split('/').pop()];
  return param;
}

// Every name a tool's operations accept, with its enum values when it has them.
function accepted(tool: ToolSpec): Map<string, Set<string> | undefined> {
  const names = new Map<string, Set<string> | undefined>();
  const add = (name: string, schema: any) => {
    const values = enumOf(resolve(schema));
    names.set(name, values ?? names.get(name));
  };
  for (const id of tool.operations) {
    const { path, op } = operation(id);
    const item = contract.paths[path];
    for (const raw of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
      const param = parameter(raw);
      add(param.name, param.schema);
    }
    const body = resolve(op.requestBody?.content?.['application/json']?.schema);
    for (const [name, schema] of Object.entries<any>(body?.properties ?? {})) add(name, schema);
  }
  return names;
}

function enumOf(schema: any): Set<string> | undefined {
  if (!schema) return undefined;
  if (Array.isArray(schema.enum)) return new Set(schema.enum.filter((value: unknown) => value !== null));
  if (schema.items) return enumOf(resolve(schema.items));
  for (const key of ['anyOf', 'oneOf']) {
    if (Array.isArray(schema[key])) {
      const values = schema[key].flatMap((part: any) => [...(enumOf(resolve(part)) ?? [])]);
      if (values.length) return new Set(values);
    }
  }
  return undefined;
}

describe('operations', () => {
  const all = new Set(operations().map((entry) => entry.op.operationId));
  const covered = new Set(TOOLS.flatMap((tool) => tool.operations));

  it('every tool operation exists in the contract', () => {
    expect([...covered].filter((id) => !all.has(id))).toEqual([]);
  });

  it('every contract operation is a tool or EXCLUDED', () => {
    expect([...all].filter((id) => !covered.has(id) && !(id in EXCLUDED))).toEqual([]);
  });

  it('nothing is both a tool and EXCLUDED, and EXCLUDED names real operations', () => {
    expect(Object.keys(EXCLUDED).filter((id) => covered.has(id) || !all.has(id))).toEqual([]);
  });
});

describe.each(['stdio', 'http'] as const)('inputs (%s)', (transport) => {
  it.each(TOOLS.map((tool) => [tool.name, tool] as const))('%s takes only what the contract takes', (_name, tool) => {
    const schema = inputSchema(tool, transport);
    const names = accepted(tool);
    const local = new Set(['cursor', 'limit', ...(LOCAL[tool.name] ?? [])]);
    const unknown = Object.keys(schema.properties ?? {}).filter((name) => !names.has(name) && !local.has(name));
    expect(unknown).toEqual([]);
  });

  it.each(TOOLS.map((tool) => [tool.name, tool] as const))('%s enums equal the contract', (_name, tool) => {
    const schema = inputSchema(tool, transport);
    const names = accepted(tool);
    for (const [name, property] of Object.entries<any>(schema.properties ?? {})) {
      const ours = enumOf(property);
      const theirs = names.get(name);
      if (!ours || !theirs) continue;
      expect([...ours].sort(), `${tool.name}.${name}`).toEqual([...theirs].sort());
    }
  });
});

describe('the checks above bite', () => {
  it('compare real enums and real field names', () => {
    let compared = 0;
    for (const tool of TOOLS) {
      const schema = inputSchema(tool, 'stdio');
      const names = accepted(tool);
      for (const [name, property] of Object.entries<any>(schema.properties ?? {})) {
        if (enumOf(property) && names.get(name)) compared += 1;
      }
    }
    expect(compared).toBeGreaterThanOrEqual(14);
    expect(accepted(TOOLS.find((tool) => tool.name === 'create_project') as ToolSpec).has('screenshot_urls')).toBe(true);
    expect(accepted(TOOLS.find((tool) => tool.name === 'list_events') as ToolSpec).has('project_id')).toBe(false);
  });
});

describe('tool texts', () => {
  it('every tool has a title, a description and the annotations directories require', () => {
    for (const tool of TOOLS) {
      expect(tool.title.length, tool.name).toBeGreaterThan(3);
      expect(tool.name.length, tool.name).toBeLessThanOrEqual(64);
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
      expect(typeof tool.annotations.readOnlyHint, tool.name).toBe('boolean');
      if (!tool.annotations.readOnlyHint) expect(typeof tool.annotations.destructiveHint, tool.name).toBe('boolean');
    }
  });
});
