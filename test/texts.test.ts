// Everything in this repo is public, and every text in it can end up quoted
// by an assistant, a registry or a directory: no long dashes, and none of the
// promises the product does not make. (Words about how the service works
// inside are checked from the private backend repo: bin/mcp-public-check.)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INSTRUCTIONS } from '../src/instructions.js';
import { descriptionOf, TOOLS } from '../src/tools/index.js';

const PROMISES = ['sandbox', 'the only', 'the first', 'coming soon', 'chatgpt'];
const DASHES = /[\u2013\u2014]/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return [path];
  });
}

const root = new URL('..', import.meta.url).pathname;
// Our own files; the contract snapshot and its generated types are the API's
// published text, checked on the API side.
const OURS = [
  ...files(join(root, 'src')).filter((path) => !path.endsWith('v1.d.ts')),
  ...files(join(root, 'scripts')),
  ...files(join(root, 'api')),
  ...files(join(root, 'public')),
  ...files(join(root, '.github')),
  join(root, 'README.md'),
  join(root, 'package.json'),
  ...['server.json', 'vercel.json'].map((name) => join(root, name)).filter((path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  }),
];

function hits(text: string, words: string[]): string[] {
  return words.filter((item) => new RegExp(`\\b${item.replace(/[.+]/g, '\\$&')}\\b`, 'i').test(text));
}

describe('public texts', () => {
  it.each(OURS.map((path) => [path.slice(root.length), path]))('%s has no promises or long dashes', (_name, path) => {
    const text = readFileSync(path, 'utf8');
    expect(hits(text, PROMISES)).toEqual([]);
    expect(DASHES.test(text)).toBe(false);
    expect(text).not.toMatch(/\b100\+/);
  });

  it('tool texts and instructions name only clients that take an API key', () => {
    const texts = [
      INSTRUCTIONS,
      ...TOOLS.flatMap((tool) => [tool.title, descriptionOf(tool, 'stdio'), descriptionOf(tool, 'http')]),
    ].join('\n');
    expect(hits(texts, PROMISES)).toEqual([]);
    expect(DASHES.test(texts)).toBe(false);
  });

  it('covers the files it should', () => {
    expect(OURS.some((path) => path.endsWith('src/client.ts'))).toBe(true);
    expect(OURS.some((path) => path.endsWith('README.md'))).toBe(true);
  });
});
