/** Real compiled control room + owned headless renderer + WebAudio/Rhubarb + FFmpeg.
 * Provider voice is a local WAV fixture; no platform credentials or public broadcast. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';
import { loadConfig, serviceRoot } from '../src/config.mjs';
import { createGateway } from '../src/gateway.mjs';
import { createLiveSettingsStore, defaultLiveSettings } from '../src/live-settings.mjs';

const exec = promisify(execFile), temporary = await mkdtemp(resolve(tmpdir(), 'air3-live-e2e-'));
const output = resolve(process.env.AIR3_QA_DIR || resolve(serviceRoot, '../docs/validation/live-3.0'), 'compiled-live');
await mkdir(output, { recursive: true });
const chrome = process.env.AIR3_CHROME_PATH || (await readFile(resolve(serviceRoot, '.browser-path'), 'utf8')).trim();
const env = { ...process.env, AIR3_HOST: '127.0.0.1', AIR3_PORT: '5890', AIR3_LIVE_ENABLED: 'true', AIR3_LOCAL_OPERATOR: 'true', AIR3_PUBLIC_ORIGIN: '',
  AIR3_PRODUCER_TOKEN: randomBytes(32).toString('hex'), AIR3_PLAYER_TOKEN: randomBytes(32).toString('hex'), AIR3_OPERATOR_TOKEN: randomBytes(32).toString('hex'),
  AIR3_DATA_DIR: resolve(temporary, 'data'), AIR3_AVATAR_URL: '/assets/air3/models/AIR3-runtime.glb', AIR3_DAPP_BASE_URL: '',
  AIR3_CHROME_PATH: chrome, AIR3_CHROME_ANGLE: 'swiftshader', AIR3_CHROME_NO_SANDBOX: process.getuid?.() === 0 ? 'true' : 'false',
  AIR3_MAX_RESTARTS: '0', AIR3_TTS_BASE_URL: 'http://tts-fixture.invalid/v1', AIR3_TTS_MODEL: 'wav-fixture', AIR3_LIPSYNC_MODE: 'required',
  AIR3_FFMPEG: process.env.AIR3_FFMPEG || 'ffmpeg' };
delete env.DISPLAY;
const config = { ...loadConfig(env), port: 0 }; let providerCalls = 0, browser, gateway, page, studio;
const voice = await readFile(resolve(serviceRoot, 'public/assets/air3/demo/voice-reference.wav'));
config.fetchImpl = async (_url, options) => { providerCalls++; assert.equal(JSON.parse(options.body).response_format, 'wav'); return new Response(voice, { headers: { 'Content-Type': 'audio/wav' } }); };
config.liveDependencies = { baseEnv: env };
const store = await createLiveSettingsStore(config.dataDir, defaultLiveSettings(config));
await store.update({ market: { enabled: false }, stream: { profile: '720p30', quality: 'software', encoder: 'libx264', bitrateKbps: 2500 } });
const report = { schema: 'air3.live-e2e.v1', startedAt: new Date().toISOString(), passed: false,
  build: JSON.parse(await readFile(resolve(serviceRoot, 'public/build/manifest.json'), 'utf8')),
  errors: [], httpErrors: [], checks: [], provider: 'local WAV fixture, not external TTS inference',
  platformBroadcast: false, gpuBenchmark: false, market: 'explicit offline/demo QA; no synthetic data masquerades as live' };
async function until(read, accept, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (accept(value)) return value; await sleep(250); }
  throw new Error('QA condition timed out');
}
function check(name) { report.checks.push(name); console.log(JSON.stringify({ check: name, passed: true })); }
try {
  gateway = await createGateway(config);
  await new Promise(done => gateway.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  report.base = base;
  const bearer = { Authorization: `Bearer ${env.AIR3_OPERATOR_TOKEN}`, 'Content-Type': 'application/json' };
  const request = async (path, method = 'GET', value) => {
    const response = await fetch(base + path, { method, headers: bearer, body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(45000) });
    const data = await response.json(); assert.ok(response.ok, `QA API ${path}: ${response.status} ${data.error || ''}`); return data;
  };
  const args = ['--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  if (process.getuid?.() === 0) args.push('--no-sandbox');
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args, protocolTimeout: 120000 });
  report.browser = await browser.version();
  page = await browser.newPage(); await page.setViewport({ width: 1440, height: 1100 });
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) report.httpErrors.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  await page.goto(base + '/control', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#control-room:not([hidden])', { timeout: 20000 });
  assert.equal(await page.$eval('#scene-clothing', e => e.value), 'crop');
  assert.equal(await page.$eval('#scene-emotion', e => e.value), 'happy');
  assert.equal(await page.$eval('#scene-intensity', e => e.value), '1');
  assert.equal((await page.cookies()).find(c => c.name === 'air3_operator')?.httpOnly, true);
  assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some(r => r.name.includes('.glb'))), false);
  check('Compiled control room authenticates locally, preserves requested defaults and loads no second 3D renderer');
  await page.screenshot({ path: resolve(temporary, 'control-desktop.png'), fullPage: true });
  await page.setViewport({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.screenshot({ path: resolve(temporary, 'control-mobile.png'), fullPage: true });
  await page.setViewport({ width: 1440, height: 1100 }); check('Control room fits desktop and 390px mobile viewport');
  await page.click('[data-tab="titles"]');
  await page.evaluate(() => {
    document.getElementById('title-main').value = 'Mercati, il punto della giornata';
    document.getElementById('title-subtitle').value = 'Prova della regia #AIR3 · dati dimostrativi dichiarati';
    document.getElementById('title-ticker').value = 'Una guida scorrevole controllata via API\nPrezzi, commenti e aggiornamenti editoriali';
    document.getElementById('title-enabled').checked = true;
  });
  const titleResponse = page.waitForResponse(r => r.url().endsWith('/api/live/titles') && r.request().method() === 'POST');
  await page.click('#titles-form button.primary'); assert.equal((await titleResponse).status(), 200);
  await request('/api/live/settings', 'PATCH', { market: { enabled: true, provider: 'demo' } });
  const state = await request('/api/live/status'); assert.equal(state.titles.title, 'Mercati, il punto della giornata');
  const publicConfig = await fetch(base + '/api/public-config').then(r => r.json()); assert.equal(publicConfig.live, true);
  const publicProgram = await fetch(base + '/api/live/program').then(r => r.json());
  for (const token of [env.AIR3_PRODUCER_TOKEN, env.AIR3_PLAYER_TOKEN, env.AIR3_OPERATOR_TOKEN]) assert.ok(!JSON.stringify(publicProgram).includes(token));
  check('Titles save from the UI; public program contains scene state without credentials');
  studio = await browser.newPage();
  studio.on('pageerror', error => report.errors.push('studio: ' + error.message));
  studio.on('console', message => { if (message.type() === 'error') report.errors.push('studio: ' + message.text()); });
  await studio.setViewport({ width: 1280, height: 720 });
  await studio.goto(base + '/studio?output=1&quality=software', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await studio.waitForFunction(() => !!window.air3Studio?.ready, { timeout: 120000 });
  await studio.evaluate(() => window.air3Studio.ready);
  await studio.waitForFunction(() => document.querySelector('.editorial-title')?.textContent === 'Mercati, il punto della giornata');
  report.scene = await studio.evaluate(() => window.air3Studio.diagnostics());
  assert.equal(report.scene.look.clothing.style, 'crop');
  const frame = await studio.evaluate(() => window.air3Studio.captureFrame());
  await writeFile(resolve(output, 'studio-canvas.png'), Buffer.from(frame.split(',')[1], 'base64'));
  await studio.screenshot({ path: resolve(temporary, 'program-with-titles.png') });
  const malicious = '<img src=x onerror=alert(1)>';
  await request('/api/live/titles', 'POST', { title: malicious });
  await studio.waitForFunction(text => document.querySelector('.editorial-title')?.textContent === text, {}, malicious);
  assert.equal(await studio.$eval('.live-editorial', e => e.querySelectorAll('img,script,iframe').length), 0);
  await request('/api/live/titles', 'POST', { title: 'Mercati, il punto della giornata' });
  check('Headless compiled studio applies the white top, live titles and explicit demo monitors; title HTML remains inert text');
  await studio.close(); studio = null;
  await page.click('#record');
  await until(() => gateway.live.broadcaster.snapshot(), s => {
    if (s.phase === 'failed') throw new Error('Broadcast failed: ' + s.error); return s.phase === 'running';
  }, 120000);
  check('Record button starts the owned headless browser and real H.264/AAC encoder without DISPLAY');
  await until(() => gateway.live.broadcaster.snapshot(), s => !!s.previewAt, 25000);
  const preview = await fetch(base + '/api/live/preview.jpg', { headers: bearer });
  assert.equal(preview.status, 200); await writeFile(resolve(temporary, 'recording-preview.jpg'), Buffer.from(await preview.arrayBuffer()));
  const job = await request('/api/live/narrations', 'POST', { id: 'live-e2e-voice', text: 'Bundled prerecorded voice, local pipeline test.', language: 'en' });
  assert.equal(job.status, 'queued');
  await until(() => request('/api/live/narrations/live-e2e-voice'), j => {
    if (j.status === 'failed') throw new Error('Narration failed: ' + j.error); return j.status === 'finished';
  }, 90000);
  const events = gateway.live.broadcaster.events;
  assert.ok(events.some(r => r.event === 'speech-playback' && r.phase === 'playing' && r.lipSync === 'rhubarb:pocketSphinx'));
  assert.ok(events.some(r => r.event === 'speech-playback' && r.phase === 'playing' && r.expression === 'happy' && r.expressionIntensity === 1));
  check('Real WebAudio/Rhubarb narration finishes and keeps happy100 while speaking');
  const voiceTestAt = Date.now();
  await request('/api/live/command', 'POST', { type: 'test-voice' });
  await until(() => gateway.live.broadcaster.events, rows => rows.some(row => Date.parse(row.at) >= voiceTestAt && row.event === 'speech-playback' && row.phase === 'playing' && !row.job), 20000);
  await request('/api/live/command', 'POST', { type: 'stop-test-voice' });
  check('Included reference-audio command temporarily releases the player and resumes its exclusive queue afterward');
  report.broadcastBeforeStop = gateway.live.broadcaster.snapshot();
  await page.click('#stop');
  await until(() => gateway.live.broadcaster.snapshot(), s => s.phase === 'stopped', 40000);
  assert.equal(gateway.live.broadcaster.child, null);
  assert.ok(!gateway.live.broadcaster.events.some(r => ['forced-stop', 'capture-drain-timeout'].includes(r.event)));
  assert.ok(!gateway.live.broadcaster.events.some(r => ['studio-page-error', 'studio-console-error'].includes(r.event)), 'No renderer errors in the actual capture process');
  const files = (await readdir(resolve(config.dataDir, 'recordings'))).filter(n => n.endsWith('.mkv')); assert.equal(files.length, 1);
  const recording = resolve(config.dataDir, 'recordings', files[0]);
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', recording], { maxBuffer: 1024 * 1024 });
  const probe = JSON.parse(stdout), video = probe.streams.find(x => x.codec_type === 'video'), audio = probe.streams.find(x => x.codec_type === 'audio');
  assert.equal(video.codec_name, 'h264'); assert.equal(video.width, 1280); assert.equal(video.height, 720);
  assert.equal(audio.codec_name, 'aac'); assert.equal(Number(audio.sample_rate), 48000); assert.equal(audio.channels, 2);
  const decoded = await exec(env.AIR3_FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', recording, '-map', '0:a:0', '-f', 's16le', '-acodec', 'pcm_s16le', '-'], { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 });
  let peak = 0, nonSilent = 0;
  for (let i = 0; i + 1 < decoded.stdout.length; i += 2) { const value = Math.abs(decoded.stdout.readInt16LE(i)); peak = Math.max(peak, value); if (value > 100) nonSilent++; }
  assert.ok(peak > 1000 && nonSilent > 10000, 'Recorded AAC contains real audible voice');
  report.capture = { video: { codec: video.codec_name, width: video.width, height: video.height, fps: video.avg_frame_rate },
    audio: { codec: audio.codec_name, rate: audio.sample_rate, channels: audio.channels, peakPCM: peak, nonSilentSamples: nonSilent },
    durationSeconds: Number(probe.format.duration), bytes: Number(probe.format.size), recording, providerCalls,
    cleanStop: true, events: gateway.live.broadcaster.events };
  check('Stop drains capture and encoder; recorded file decodes to H.264720p and non-silent AAC48k stereo');
  assert.equal(report.errors.length, 0); assert.equal(report.httpErrors.length, 0);
  report.passed = true; report.internalReviewDirectory = temporary;
} catch (error) { report.failure = error.stack || error.message; console.error(report.failure); process.exitCode = 1; }
finally {
  await studio?.close().catch(() => {}); await browser?.close().catch(() => {}); await gateway?.close().catch(error => { report.shutdownError = error.message; report.passed = false; process.exitCode = 1; });
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, output, temporary, failure: report.failure }));
}
