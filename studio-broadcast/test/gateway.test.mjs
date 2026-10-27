import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { createGateway } from '../src/gateway.mjs';
import { assemblePcmWav, parsePcmWav } from '../src/speech.mjs';

const PRODUCER = 'producer-secret-0123456789-0123456789';
const PLAYER = 'player-secret-0123456789-0123456789';
const IMPORT_MAP = '{"imports":{"fixture":"/studio/fixture.mjs"}}';
const wav = () => assemblePcmWav([{ channels: 1, sampleRate: 24000, bitsPerSample: 16,
  blockAlign: 2, byteRate: 48000, pcm: Buffer.alloc(4800, 1) }]).bytes;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(fn, predicate, timeout = 2500) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    last = await fn();
    if (predicate(last)) return last;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail(`Condition timed out: ${JSON.stringify(last)}`);
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'air3-gateway-test-'));
  const publicDir = path.join(root, 'public');
  const nodeModulesDir = path.join(root, 'node_modules');
  await mkdir(publicDir, { recursive: true });
  await mkdir(path.join(nodeModulesDir, 'three', 'build'), { recursive: true });
  await writeFile(path.join(publicDir, 'index.html'), `<!doctype html><title>Fixture</title><script type="importmap">${IMPORT_MAP}</script>`);
  await writeFile(path.join(publicDir, '.env'), 'should-never-be-served');
  await writeFile(path.join(nodeModulesDir, 'three', 'build', 'three.module.js'), 'export {};');
  const { queue: queueOverrides, ...rest } = overrides;
  const config = { host: '127.0.0.1', port: 0, dataDir: path.join(root, 'data'), publicDir, nodeModulesDir,
    producerToken: PRODUCER, playerToken: PLAYER, dappBaseUrl: null, avatarUrl: null,
    width: 1920, height: 1080, fps: 30,
    tts: { baseUrl: 'http://tts.fixture/v1', apiKey: 'hidden-tts-secret', model: 'kokoro', voiceEn: 'af_jessica',
      voiceIt: 'if_sara', speed: 1, timeoutMs: 2000, maxChunkChars: 80 },
    queue: { maxPending: 8, maxTextChars: 2000, maxAgeMs: 60000, leaseMs: 2000, retentionMs: 3600000, ...queueOverrides },
    fetchImpl: async () => new Response(wav(), { headers: { 'content-type': 'audio/wav' } }), ...rest };
  let gateway;
  let base;
  const start = async () => {
    gateway = await createGateway(config);
    await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${gateway.server.address().port}`;
  };
  await start();
  t.after(async () => { await gateway.close(); await rm(root, { recursive: true, force: true }); });
  const request = async (route, { method = 'GET', value, token = PRODUCER } = {}) => {
    const response = await fetch(base + route, { method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(value !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(value !== undefined ? { body: JSON.stringify(value) } : {}) });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, headers: response.headers };
  };
  return { root, config, request, get base() { return base; },
    ready: async (id) => eventually(() => request(`/api/narrations/${id}`), (result) => result.data.status === 'ready'),
    restart: async () => { await gateway.close(); await start(); },
    stop: () => gateway.close() };
}

const enqueue = (f, id, text = 'A short local fixture narration.') =>
  f.request('/api/narrations', { method: 'POST', value: { id, text } });
const claim = (f, playerId = 'renderer-one') =>
  f.request('/api/player/claim', { method: 'POST', token: PLAYER, value: { playerId } });
const event = (f, job, kind, playerId = 'renderer-one', leaseToken = job.leaseToken) =>
  f.request(`/api/player/${job.id}/events`, { method: 'POST', token: PLAYER, value: { playerId, leaseToken, event: kind } });

test('producer/player authorization is separate; config and failures never disclose credentials', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/narrations', { method: 'POST', token: null, value: { text: 'Hello' } })).status, 401);
  assert.equal((await f.request('/api/player/claim', { method: 'POST', value: { playerId: 'one' } })).status, 401);
  assert.equal((await f.request('/api/narrations/x', { token: PLAYER })).status, 401);
  assert.equal((await f.request('/api/player/claim?token=secret', { method: 'POST', token: PLAYER, value: { playerId: 'one' } })).status, 400);
  const publicResult = await f.request('/api/public-config', { token: null });
  assert.equal(publicResult.status, 200);
  const scriptPolicy = publicResult.headers.get('content-security-policy').split(';').find((part) => part.includes('script-src'));
  assert.ok(scriptPolicy.includes(`'sha256-${createHash('sha256').update(IMPORT_MAP).digest('base64')}'`));
  assert.ok(!scriptPolicy.includes('unsafe-inline'));
  assert.deepEqual(publicResult.data, { project: 'air3', dappBaseUrl: null, avatarUrl: null, defaultTimeframe: '1h', renderQuality: 'auto', width: 1920, height: 1080, fps: 30 });
  const health = await f.request('/api/health', { token: null });
  assert.equal(health.data.speech.mode, 'fully-buffered');
  assert.ok(!JSON.stringify([health.data, publicResult.data]).includes('secret'));
});

test('idempotency survives readiness and conflicts are rejected; bounded queue recovers after cancel', async (t) => {
  const f = await fixture(t, { queue: { maxPending: 1 } });
  assert.equal((await enqueue(f, 'same-key')).data.duplicate, false);
  await f.ready('same-key');
  const retry = await enqueue(f, 'same-key');
  assert.equal(retry.status, 202); assert.equal(retry.data.duplicate, true);
  assert.equal((await enqueue(f, 'same-key', 'Changed content.')).status, 409);
  assert.equal((await enqueue(f, 'another-key')).status, 429);
  assert.equal((await f.request('/api/narrations/same-key', { method: 'DELETE' })).data.status, 'cancelled');
  assert.equal((await f.request('/api/narrations/same-key', { method: 'DELETE' })).data.status, 'cancelled');
  assert.equal((await enqueue(f, 'another-key')).status, 202);
});

test('public emotion discovery matches aliases and narration stage cues are validated over HTTP', async (t) => {
  const f = await fixture(t);
  const emotions = await f.request('/api/emotions', { token: null });
  const expressions = await f.request('/api/expressions', { token: null });
  assert.equal(emotions.status, 200); assert.deepEqual(expressions.data, emotions.data);
  assert.deepEqual(emotions.data.emotions, ['neutral', 'happy', 'sad', 'surprised', 'warm', 'focused', 'concerned']);
  assert.equal(emotions.data.aliases.felice, 'happy'); assert.equal(emotions.data.aliases.stupita, 'surprised');
  assert.ok(!JSON.stringify(emotions.data).includes('secret'));
  const invalid = await f.request('/api/narrations', { method: 'POST', value: {
    id: 'bad-presentation', text: 'A chart.', presentation: { action: 'monitor', monitor: 'center', arbitrary: 1 } } });
  assert.equal(invalid.status, 400); assert.equal(invalid.data.error, 'INVALID_PRESENTATION');
  const input = { id: 'chart-presentation', text: 'A chart.', presentation: { action: 'monitor', monitor: 'center' } };
  assert.equal((await f.request('/api/narrations', { method: 'POST', value: input })).status, 202);
  await f.ready(input.id);
  const job = (await claim(f)).data.job;
  assert.deepEqual(job.presentation, input.presentation);
});

test('simultaneous claims lease exactly one narration; leased heartbeat protects decoding', async (t) => {
  const f = await fixture(t);
  await enqueue(f, 'spoken-once'); await f.ready('spoken-once');
  const claims = await Promise.all([claim(f, 'one'), claim(f, 'two')]);
  assert.equal(claims.filter((result) => result.data.job).length, 1);
  const winner = claims[0].data.job ? 'one' : 'two';
  const job = claims.find((result) => result.data.job).data.job;
  assert.equal((await event(f, job, 'heartbeat', winner)).status, 200);
  assert.equal((await event(f, job, 'started', 'intruder')).status, 409);
  assert.equal((await event(f, job, 'started', winner, 'wrong-token')).status, 409);
  const audio = await fetch(f.base + job.audioPath, { headers: { Authorization: `Bearer ${PLAYER}` } });
  assert.equal(audio.status, 200); assert.equal(audio.headers.get('cache-control'), 'no-store');
  assert.equal(parsePcmWav(Buffer.from(await audio.arrayBuffer())).durationMs, 100);
  assert.equal((await event(f, job, 'started', winner)).data.status, 'playing');
  assert.equal((await event(f, job, 'finished', winner)).data.status, 'finished');
  assert.equal((await claim(f)).data.job, null);
});

test('cancelling generation aborts provider, preserves cancelled state and starts next job', async (t) => {
  let calls = 0;
  let active = 0;
  let maximum = 0;
  let aborted = false;
  const f = await fixture(t, { fetchImpl: async (_url, { signal }) => {
    calls++; active++; maximum = Math.max(maximum, active);
    if (calls === 1) return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { active--; aborted = true; reject(new Error('secret provider details')); }, { once: true });
    });
    active--; return new Response(wav());
  } });
  await enqueue(f, 'cancel-generation');
  await eventually(async () => calls, (count) => count === 1);
  await enqueue(f, 'next-job');
  await f.request('/api/narrations/cancel-generation', { method: 'DELETE' });
  await f.ready('next-job');
  assert.equal(aborted, true); assert.equal(maximum, 1);
  assert.equal((await f.request('/api/narrations/cancel-generation')).data.status, 'cancelled');
});

test('cancellation invalidates playback lease and denies subsequent audio reads', async (t) => {
  const f = await fixture(t);
  await enqueue(f, 'cancel-playing'); await f.ready('cancel-playing');
  const { job } = (await claim(f)).data;
  await event(f, job, 'started');
  await f.request('/api/narrations/cancel-playing', { method: 'DELETE' });
  assert.equal((await event(f, job, 'heartbeat')).status, 409);
  assert.equal((await f.request(job.audioPath, { token: PLAYER })).status, 404);
  assert.equal((await claim(f)).data.job, null);
});

test('expired lease never replays; a new narration can be claimed', async (t) => {
  let clock = Date.now();
  const f = await fixture(t, { now: () => clock });
  await enqueue(f, 'lost-lease'); await enqueue(f, 'after-lost');
  await f.ready('lost-lease'); await f.ready('after-lost');
  const old = (await claim(f)).data.job;
  clock += f.config.queue.leaseMs + 1;
  const next = (await claim(f, 'replacement')).data.job;
  assert.equal(old.id, 'lost-lease'); assert.equal(next.id, 'after-lost');
  assert.equal((await f.request('/api/narrations/lost-lease')).data.status, 'expired');
  assert.equal((await event(f, old, 'heartbeat')).status, 409);
});

test('original expiry caps heartbeats and work cannot be played after its deadline', async (t) => {
  let clock = Date.now();
  const f = await fixture(t, { now: () => clock });
  const expiresAt = clock + 4000;
  await f.request('/api/narrations', { method: 'POST', value: { id: 'deadline', text: 'Deadline fixture.', expiresAt } });
  await f.ready('deadline');
  const job = (await claim(f)).data.job;
  clock += 1500; await event(f, job, 'heartbeat');
  clock += 1500;
  assert.equal((await event(f, job, 'heartbeat')).data.leaseMs, 1000);
  clock = expiresAt;
  assert.equal((await event(f, job, 'heartbeat')).status, 409);
  assert.equal((await f.request('/api/narrations/deadline')).data.error, 'NARRATION_EXPIRED');
});

test('claim skips audio that cannot finish before expiry and start rechecks after decoding', async (t) => {
  let clock = Date.now();
  const f = await fixture(t, { now: () => clock });
  await f.request('/api/narrations', { method: 'POST', value: {
    id: 'too-late', text: 'Old market update.', expiresAt: clock + 2100 } });
  await enqueue(f, 'following');
  await f.ready('too-late'); await f.ready('following');
  assert.equal((await claim(f)).data.job.id, 'following');
  assert.equal((await f.request('/api/narrations/too-late')).data.error, 'PLAYBACK_DEADLINE_TOO_CLOSE');
  await f.request('/api/narrations/following', { method: 'DELETE' });
  await f.request('/api/narrations', { method: 'POST', value: {
    id: 'slow-decode', text: 'Decode deadline fixture.', expiresAt: clock + 4000 } });
  await f.ready('slow-decode');
  const job = (await claim(f)).data.job;
  clock += 1500;
  assert.equal((await event(f, job, 'heartbeat')).status, 200);
  clock += 500;
  const started = await event(f, job, 'started');
  assert.equal(started.status, 409);
  assert.equal(started.data.error, 'PLAYBACK_DEADLINE_TOO_CLOSE');
  assert.equal((await f.request('/api/narrations/slow-decode')).data.status, 'expired');
  assert.equal((await claim(f)).data.job, null);
});

test('restart expires possibly spoken audio while preserving ready jobs and idempotency', async (t) => {
  const f = await fixture(t);
  await enqueue(f, 'before-restart'); await enqueue(f, 'ready-after-restart');
  await f.ready('before-restart'); await f.ready('ready-after-restart');
  const job = (await claim(f)).data.job;
  await event(f, job, 'started');
  await f.restart();
  const old = await f.request('/api/narrations/before-restart');
  assert.equal(old.data.status, 'expired'); assert.equal(old.data.error, 'PLAYBACK_INTERRUPTED_BY_RESTART');
  assert.equal((await enqueue(f, 'before-restart')).data.duplicate, true);
  assert.equal((await claim(f)).data.job.id, 'ready-after-restart');
});

test('static serving permits only studio assets and vendor allowlist, including symlink containment', async (t) => {
  const f = await fixture(t, { avatarUrl: '/assets/avatar.glb' });
  await mkdir(path.join(f.config.publicDir, 'assets'));
  await writeFile(path.join(f.config.publicDir, 'assets', 'avatar.glb'), 'fixture model bytes');
  assert.equal((await f.request('/studio', { token: null })).status, 200);
  assert.equal((await f.request('/api/public-config', { token: null })).data.avatarUrl, '/assets/avatar.glb');
  assert.equal((await f.request('/assets/avatar.glb', { token: null })).status, 200);
  assert.equal((await f.request('/studio/assets/avatar.glb', { token: null })).status, 200);
  assert.equal((await f.request('/assets/%2e%2e%2findex.html', { token: null })).status, 404);
  assert.equal((await f.request('/vendor/three/build/three.module.js', { token: null })).status, 200);
  assert.equal((await f.request('/studio/.env', { token: null })).status, 404);
  assert.equal((await f.request('/studio/%2e%2e%2fsrc%2fgateway.mjs', { token: null })).status, 404);
  assert.equal((await f.request('/vendor/other/package.json', { token: null })).status, 404);
  await writeFile(path.join(f.root, 'outside.js'), 'secret');
  await symlink(path.join(f.root, 'outside.js'), path.join(f.config.publicDir, 'escape.js'));
  assert.equal((await f.request('/studio/escape.js', { token: null })).status, 404);
});

test('second gateway on same database is rejected without disrupting active instance', async (t) => {
  const f = await fixture(t);
  await assert.rejects(createGateway(f.config), /GATEWAY_ALREADY_RUNNING/);
  assert.equal((await enqueue(f, 'still-alive')).status, 202);
  await f.ready('still-alive');
});

test('process crash releases the gateway lock and recovery never replays leased audio', async (t) => {
  const f = await fixture(t);
  await f.stop();
  const queueModule = new URL('../src/queue.mjs', import.meta.url).href;
  const script = `import { NarrationQueue } from ${JSON.stringify(queueModule)};
    const queue = new NarrationQueue(process.argv[1], JSON.parse(process.argv[2]));
    queue.enqueue({ id: 'crashed-player', text: 'Never replay this fixture.' });
    queue.takeForGeneration(); queue.markReady('crashed-player', 'fixture.wav', 100);
    queue.claim('child-player');
    process.stdout.write('READY'); setInterval(() => queue.counts(), 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script,
    path.join(f.config.dataDir, 'narrations.sqlite'), JSON.stringify(f.config.queue)], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', (data) => data.toString() === 'READY' ? resolve() : reject(new Error('Unexpected child output')));
    child.once('exit', () => reject(new Error('Child exited before ready')));
  });
  let timeout;
  try {
    await Promise.race([ready, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Child startup timed out')), 3000); })]);
  } finally { clearTimeout(timeout); }
  await assert.rejects(createGateway(f.config), /GATEWAY_ALREADY_RUNNING/);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  await f.restart();
  const interrupted = await f.request('/api/narrations/crashed-player');
  assert.equal(interrupted.data.status, 'expired');
  assert.equal(interrupted.data.error, 'PLAYBACK_INTERRUPTED_BY_RESTART');
  assert.equal((await claim(f)).data.job, null);
  await enqueue(f, 'after-crash');
  await f.ready('after-crash');
  assert.equal((await claim(f)).data.job.id, 'after-crash');
});
