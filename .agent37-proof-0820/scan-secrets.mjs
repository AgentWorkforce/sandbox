import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const names = ['RELAY_NODE_TOKEN', 'RELAY_WORKER_AGENT_TOKEN', 'RELAYFILE_TOKEN', 'RELAYHISTORY_ACCESS_TOKEN'];
const secrets = names.map((name) => process.env[name]).filter((value) => typeof value === 'string' && value.length > 0);
if (secrets.length !== names.length) throw new Error('secret scanner missing a named inherited value');
const roots = ['/opt/agent37-proof', '/root/.relayfile', '/root/.agentworkforce'];
let files = 0;
let leaks = 0;
function walk(path) {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) walk(join(path, name));
    return;
  }
  files += 1;
  const data = readFileSync(path);
  for (const secret of secrets) if (data.includes(Buffer.from(secret))) leaks += 1;
}
for (const root of roots) walk(root);
if (leaks > 0) throw new Error(`credential filesystem scan failed: ${leaks} matches`);
process.stdout.write(JSON.stringify({ ok: true, roots: roots.length, files }) + '\n');
