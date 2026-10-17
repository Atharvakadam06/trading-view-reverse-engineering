#!/usr/bin/env node
// One command that proves an install works: offline tests, data-source doctor, live smoke test.
//   node scripts/check.js
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = ['indicators', 'series', 'backtest', 'server', 'reference', 'providers', 'feeds', 'imports', 'ptq', 'quant'].map((t) => path.join(root, 'test', `${t}.test.js`));
// Node 20.14+ and 22+: a stuck test fails after 2 minutes, and a test file exits once its tests finish.
const [major, minor] = process.versions.node.split('.').map(Number);
const guard = major >= 22 || (major === 20 && minor >= 14) ? ['--test-timeout=120000', '--test-force-exit'] : [];
// Each step also has a time limit, so a hang anywhere becomes a FAIL instead of waiting forever.
const steps = [
  ['Offline tests', [process.execPath, '--test', ...guard, ...tests], 15],
  ['Data sources', [process.execPath, path.join(root, 'scripts', 'doctor.js')], 5],
  ['Live smoke test', [process.execPath, path.join(root, 'scripts', 'smoke.js')], 5],
];
const results = [];
for (const [name, [cmd, ...args], minutes] of steps) {
  process.stdout.write(`\n=== ${name} ===\n`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, NODE_NO_WARNINGS: '1' }, timeout: minutes * 60000 });
  if (r.error?.code === 'ETIMEDOUT') console.log(`\n${name} ran for over ${minutes} minutes and was stopped.`);
  results.push([name, r.status === 0]);
}
console.log('\n=== Summary ===');
for (const [name, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
const ready = results.every(([, ok]) => ok);
console.log(ready ? '\nREADY. Start it with: node scripts/launch.js' : '\nNOT READY. Read the FAIL output above.');
process.exit(ready ? 0 : 1);
