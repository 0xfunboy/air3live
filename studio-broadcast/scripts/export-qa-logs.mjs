import { spawn } from 'node:child_process';
import { writeFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import os from 'node:os';
import { serviceRoot } from '../src/config.mjs';

const output = resolve(process.env.AIR3_QA_DIR || resolve(serviceRoot, '../docs/validation/live-3.0'));
await mkdir(output, { recursive: true });
async function run(name, args) {
  const began = performance.now(), child = spawn(process.execPath, args, { cwd: serviceRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (bytes) => { log += bytes; process.stdout.write(bytes); });
  const code = await new Promise((done, reject) => { child.on('error', reject); child.on('close', done); });
  await writeFile(resolve(output, name), log);
  return { code, durationMs: Math.round(performance.now() - began), log };
}
const testFiles = (await readdir(resolve(serviceRoot, 'test'))).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => 'test/' + name);
const compiled = await run('build-results.txt', ['scripts/build.mjs']);
const tests = await run('studio-tests.txt', ['--test', '--test-reporter=tap', ...testFiles]);
const syntax = await run('check-results.txt', ['scripts/check.mjs']);
const count = (label) => { const match = tests.log.match(new RegExp('^# ' + label + '\\s+(\\d+)', 'm')); return match ? Number(match[1]) : null; };
const report = { schema: 'air3.measured-system-qa.v1', timestamp: new Date().toISOString(),
  environment: { os: process.platform, release: os.release(), arch: process.arch, node: process.version,
    cpu: os.cpus()[0]?.model ?? 'unknown', logicalCpus: os.cpus().length, gpu: 'not measured by this script', encoder: 'not measured by this script' },
  tests: { exitCode: tests.code, tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'), durationMs: tests.durationMs },
  syntax: { exitCode: syntax.code, modules: Number(syntax.log.match(/Syntax checked (\d+)/)?.[1]) || null, durationMs: syntax.durationMs },
  build: { exitCode: compiled.code, durationMs: compiled.durationMs },
  passed: tests.code === 0 && syntax.code === 0 && compiled.code === 0,
  scope: 'Standalone live studio, local integration fixtures and optional HTTP bridges. dApp and Eliza repositories are not required or bundled. External platform publication and GPU throughput are not asserted by this suite.' };
try { report.frontendBuild = JSON.parse(await readFile(resolve(serviceRoot, 'public/build/manifest.json'), 'utf8')); } catch {}
await writeFile(resolve(output, 'system-qa-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, output, tests: report.tests }));
process.exitCode = report.passed ? 0 : 1;
