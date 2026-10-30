// Refreshes openapi/v1.json from the public contract and regenerates
// src/v1.d.ts from it. The contract needs no key. Run it whenever /v1
// ships a new release, then map each new operation to a tool or to
// EXCLUDED in src/tools/catalog.ts (test/contract.test.ts fails until then).
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = process.argv[2] ?? 'https://api.submitator.com/v1/openapi.json';

const response = await fetch(source);
if (!response.ok) {
  console.error(`sync:openapi: ${source} answered ${response.status}`);
  process.exit(1);
}
const document = await response.json();
writeFileSync(`${root}openapi/v1.json`, `${JSON.stringify(document, null, 2)}\n`);
execFileSync('npx', ['openapi-typescript', 'openapi/v1.json', '-o', 'src/v1.d.ts'], { cwd: root, stdio: 'inherit' });
console.error(`sync:openapi: ${document.info.version}, ${Object.keys(document.paths).length} paths`);
