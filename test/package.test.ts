import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('package.json', () => {
  it('carries the version the server reports', () => {
    expect(VERSION).toBe(pkg.version);
  });

  it('names the registry entry and the binary', () => {
    expect(pkg.mcpName).toBe('com.submitator/mcp');
    expect(pkg.bin['submitator-mcp']).toBe('dist/stdio.js');
    expect(pkg.files).toEqual(['dist', 'README.md', 'LICENSE']);
  });

  it('depends only on the SDK and zod at runtime', () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@modelcontextprotocol/server', 'zod']);
  });
});
