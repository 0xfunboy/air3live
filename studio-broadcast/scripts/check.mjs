import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { serviceRoot } from '../src/config.mjs';
let count = 0;
async function walk(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const file = resolve(dir, item.name);
    if (item.isDirectory()) await walk(file);
    else if (/\.(mjs|js)$/.test(item.name)) {
      const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(1);
      count++;
    }
  }
}
for (const dir of ['src', 'scripts', 'public', 'test', '../scripts', '../tools', '../adapters']) await walk(resolve(serviceRoot, dir));
console.log(`Syntax checked ${count} JavaScript modules`);
