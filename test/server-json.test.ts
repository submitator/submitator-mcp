import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const server = read('../server.json');
const pkg = read('../package.json');
const schema = read('./fixtures/server.schema.json');

describe('server.json', () => {
  it('is valid for the official registry', () => {
    const ajv = new Ajv({ strict: false, validateFormats: false });
    const valid = ajv.validate(schema, server);
    expect(ajv.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  it('matches package.json, which the registry checks against npm', () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].identifier).toBe(pkg.name);
    expect(server.packages[0].version).toBe(pkg.version);
    expect(server.description).toBe(pkg.description);
    expect(server.repository.url).toBe(pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, ''));
  });

  it('opens the README with the same sentence', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme.split('\n')[2]).toBe(pkg.description);
  });
});
