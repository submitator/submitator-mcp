// Checks what a release needs, in the order it needs it, and prints the
// publishing commands only when everything holds. It publishes nothing: npm
// and the registry ask for the owner's own login.
//
//   npm run release:check            all checks, the remote endpoint included
//   npm run release:check -- --first before release 0.1.0, while the remote may not be up yet
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const first = process.argv.includes('--first');
const read = (path) => readFileSync(new URL(path, `file://${root}`), 'utf8');
const failures = [];
const check = (ok, message) => {
  console.error(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
};

const pkg = JSON.parse(read('package.json'));
const server = JSON.parse(read('server.json'));
const version = /VERSION = '([^']+)'/.exec(read('src/version.ts'))?.[1];
check(version === pkg.version && server.version === pkg.version && server.packages[0].version === pkg.version,
  `one version everywhere: package.json ${pkg.version}, src/version.ts ${version}, server.json ${server.version}`);

let published = null;
try {
  published = execFileSync('npm', ['view', pkg.name, 'version'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {
  published = null;
}
check(published !== pkg.version, `npm has ${published ?? 'no release'} of ${pkg.name}, this is ${pkg.version}`);

for (const [script, label] of [['typecheck', 'types'], ['test', 'tests'], ['check:pack', 'clean install of the packed tarball']]) {
  try {
    execFileSync('npm', ['run', '--silent', script], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    check(true, label);
  } catch {
    check(false, label);
  }
}

if (!first) {
  const url = server.remotes[0].url;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'release-check', version: '1' } } }),
    });
    check(response.ok, `${url} answers initialize (${response.status})`);
  } catch {
    check(false, `${url} answers initialize (no answer)`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} checks failed: nothing to publish yet.`);
  process.exit(1);
}
console.error(`
All checks hold. First, from the backend repo, the private word check:
  bin/mcp-public-check --history
Then, in this folder (an npm login session lasts about two hours):
  npm login
  npm publish
And right after it (a registry login lasts five minutes; the key stays outside this repo):
  PRIVATE_KEY="$(openssl pkey -in ~/.mcp-registry/submitator.pem -outform DER | tail -c 32 | xxd -p -c 64)"
  mcp-publisher login dns --domain submitator.com --private-key "$PRIVATE_KEY"
  unset PRIVATE_KEY
  mcp-publisher publish
`);
