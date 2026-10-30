// Packs the package and installs the tarball in an empty folder outside this
// checkout, then runs the stdio handshake there. A missing dependency passes
// every local check when a parent folder's node_modules lends it; this
// catches that before a user's npx does.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString();

run('npm', ['run', 'build'], root);
const packs = mkdtempSync(join(tmpdir(), 'submitator-mcp-pack-'));
const tarball = run('npm', ['pack', '--silent', '--pack-destination', packs], root).trim().split('\n').pop();
const app = mkdtempSync(join(tmpdir(), 'submitator-mcp-clean-'));
run('npm', ['init', '-y'], app);
run('npm', ['install', '--silent', '--no-audit', '--no-fund', join(packs, tarball)], app);

const child = spawn(join(app, 'node_modules', '.bin', 'submitator-mcp'), [], {
  cwd: app,
  env: { PATH: process.env.PATH ?? '' },
  stdio: ['pipe', 'pipe', 'inherit'],
});
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
const answers = new Map();
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) {
      const message = JSON.parse(line);
      if (message.id !== undefined) answers.set(message.id, message);
    }
  }
});

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'clean-room', version: '1' } } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

const deadline = Date.now() + 20_000;
while (!answers.has(2) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
child.kill();

const tools = answers.get(2)?.result?.tools ?? [];
if (answers.get(1)?.result?.serverInfo?.name !== 'submitator' || tools.length < 15) {
  console.error('check:pack: the packed server did not answer the handshake', JSON.stringify([...answers.values()]).slice(0, 500));
  process.exit(1);
}
console.error(`check:pack: ${tarball} installs cleanly and lists ${tools.length} tools`);
