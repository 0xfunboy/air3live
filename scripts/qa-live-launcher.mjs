#!/usr/bin/env node
/** Real gateway + launcher smoke. Temporary settings disable all market/chat
 * connections. No browser, encoder, TTS request or public broadcast is started.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { defaultLiveSettings } from '../studio-broadcast/src/live-settings.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'air3-launcher-smoke-'));
const children = [];
const report = { schema: 'air3.live.launcher.qa.v1', date: new Date().toISOString(), node: process.version,
  platform: process.platform, kind: 'real-local-gateway-no-broadcast', checks: {}, failures: [], sourceHashes: {} };
function deadline(promise, ms = 15000) {
  let timer;
  return Promise.race([promise, new Promise((_done, fail) => { timer = setTimeout(() => fail(new Error('QA_TIMEOUT')), ms); })])
    .finally(() => clearTimeout(timer));
}
async function unusedPort() {
  const server = createServer();
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}
function launch(dataDir, port) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AIR3_')));
  Object.assign(env, { AIR3_PORT: String(port), AIR3_DATA_DIR: dataDir, AIR3_HOST: '127.0.0.1',
    AIR3_PRODUCER_TOKEN: 'fixture-producer-token-not-for-deployment',
    AIR3_PLAYER_TOKEN: 'fixture-player-token-not-for-deployment',
    AIR3_OPERATOR_TOKEN: 'fixture-operator-token-not-for-deployment' });
  const child = spawn(process.execPath, [join(temporary, 'scripts/start-live.mjs')], {
    cwd: temporary, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const row = { child, stdout: '', stderr: '', done: null, result: null };
  row.done = new Promise(done => {
    child.once('error', error => { row.result = { error: error.code }; done(row.result); });
    child.once('exit', (code, signal) => { row.result = { code, signal }; done(row.result); });
  });
  child.stdout.on('data', data => { row.stdout += data; });
  child.stderr.on('data', data => { row.stderr += data; });
  children.push(row); return row;
}
async function waitForUrl(row) {
  if (row.stdout.includes('/control')) return;
  await deadline(new Promise((done, fail) => {
    function data() { if (row.stdout.includes('/control')) { cleanup(); done(); } }
    function ended() { cleanup(); fail(new Error('LAUNCHER_EXITED_BEFORE_READY')); }
    function cleanup() { row.child.stdout.off('data', data); row.child.off('exit', ended); }
    row.child.stdout.on('data', data); row.child.once('exit', ended);
  }));
}
async function settings(dataDir) {
  await mkdir(dataDir, { recursive: true });
  const value = defaultLiveSettings(); value.market.enabled = false; value.twitch.enabled = false;
  await writeFile(join(dataDir, 'live-settings.json'), JSON.stringify(value), { mode: 0o600 });
}

try {
  await mkdir(join(temporary, 'scripts'));
  await mkdir(join(temporary, 'studio-broadcast'));
  for (const file of ['start-live.mjs', 'launcher-runtime.mjs', 'launcher-shutdown.mjs']) {
    await copyFile(join(root, 'scripts', file), join(temporary, 'scripts', file));
  }
  await copyFile(join(root, 'studio-broadcast/.env.example'), join(temporary, 'studio-broadcast/.env.example'));
  for (const name of ['src', 'node_modules']) {
    await symlink(join(root, 'studio-broadcast', name), join(temporary, 'studio-broadcast', name), 'junction');
  }
  const dataDir = join(temporary, 'data-primary'), dataSecond = join(temporary, 'data-second');
  await settings(dataDir); await settings(dataSecond);
  const port = await unusedPort(), origin = 'http://localhost:' + port;
  const primary = launch(dataDir, port); await waitForUrl(primary);
  assert.equal(primary.stdout.trim(), origin + '/control');
  assert.equal(primary.stderr, '');
  report.checks.outputIsOnlyControlUrl = true;
  const authorization = { Authorization: 'Bearer fixture-operator-token-not-for-deployment' };
  const stateResponse = await fetch(origin + '/api/live/status', { headers: authorization });
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.broadcast.phase, 'stopped');
  assert.equal(state.broadcast.mode, null); assert.equal(state.broadcast.frame, 0);
  assert.equal(state.settings.market.enabled, false); assert.equal(state.settings.twitch.enabled, false);
  report.checks.noAutomaticBroadcast = true;
  report.checks.externalFeedsDisabled = true;
  const login = await fetch(origin + '/api/live/session', { method: 'POST', headers: {
    'Content-Type': 'application/json', Origin: origin, 'Sec-Fetch-Site': 'same-origin',
  }, body: JSON.stringify({ local: true }) });
  assert.equal(login.status, 200); assert.equal((await login.json()).authenticated, true);
  assert.ok(login.headers.get('set-cookie')?.includes('HttpOnly'));
  report.checks.loopbackSessionWorks = true;
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const authenticatedStatus = await fetch(origin + '/api/live/status', { headers: { Cookie: cookie, Origin: origin } });
  assert.equal(authenticatedStatus.status, 200);
  assert.equal((await authenticatedStatus.json()).redirectUri, origin + '/api/live/twitch/callback');
  report.checks.localhostCallbackMatchesSessionOrigin = true;
  const duplicate = launch(dataSecond, port); const duplicateExit = await deadline(duplicate.done);
  assert.equal(duplicateExit.code, 1);
  assert.ok(duplicate.stderr.includes('Porta già occupata'));
  assert.equal(primary.result, null);
  assert.equal((await fetch(origin + '/api/live/status', { headers: authorization })).status, 200);
  report.checks.occupiedPortPreservesExistingInstance = true;
  primary.child.kill('SIGTERM'); const stopped = await deadline(primary.done);
  assert.equal(stopped.code, 143);
  await assert.rejects(fetch(origin + '/api/live/status', { headers: authorization }));
  report.checks.gracefulOwnedGatewayShutdown = true;
  for (const relative of ['scripts/start-live.mjs', 'scripts/launcher-runtime.mjs', 'scripts/launcher-shutdown.mjs', 'studio-broadcast/src/main.mjs']) {
    report.sourceHashes[relative] = createHash('sha256').update(await readFile(join(root, relative))).digest('hex');
  }
} catch (error) {
  report.failures.push({ name: error.name, message: error.message }); process.exitCode = 1;
} finally {
  for (const row of children) if (!row.result) {
    row.child.kill('SIGTERM');
    await deadline(row.done, 5000).catch(() => {
      if (process.platform !== 'win32') { try { process.kill(-row.child.pid, 'SIGKILL'); } catch {} }
      else row.child.kill('SIGKILL');
    });
  }
  await rm(temporary, { recursive: true, force: true });
  const output = join(root, 'docs/validation/current/live-launcher');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ checks: report.checks, failures: report.failures }));
}
