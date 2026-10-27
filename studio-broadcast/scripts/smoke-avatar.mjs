/** Real local browser -> MediaRecorder -> FFmpeg with REAL AIR3-runtime.glb AVATAR */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, basename, dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createGateway } from '../src/gateway.mjs';
import { loadConfig, serviceRoot } from '../src/config.mjs';

const exec = promisify(execFile);
const temporary = await mkdtemp(resolve(tmpdir(), 'air3-avatar-qa-'));
const output = resolve(process.env.AIR3_QA_DIR || temporary, 'avatar-smoke');
await mkdir(output, { recursive: true });
const env = { ...process.env,
  AIR3_PRODUCER_TOKEN: randomBytes(32).toString('hex'), AIR3_PLAYER_TOKEN: randomBytes(32).toString('hex'),
  AIR3_HOST: '127.0.0.1', AIR3_DATA_DIR: resolve(temporary, 'data'),
  AIR3_DAPP_BASE_URL: '', AIR3_AVATAR_URL: '/assets/air3/models/AIR3-runtime.glb', AIR3_WIDTH: '960', AIR3_HEIGHT: '540', AIR3_FPS: '15',
  AIR3_TTS_BASE_URL: 'http://unused.local/v1', AIR3_PLAYER_LEASE_MS: '15000', AIR3_CONTROL_STDIN: 'false',
  AIR3_LIPSYNC_MODE: 'required', AIR3_RENDER_QUALITY: 'software',
  AIR3_OUTPUT_MODE: 'file', AIR3_RECORDING_DIR: output, AIR3_RTMP_URL: '', AIR3_RTMP_KEY: '', AIR3_RTSP_URL: '',
  AIR3_VIDEO_ENCODER: 'libx264', AIR3_VIDEO_BITRATE_KBPS: '1500', AIR3_CAPTURE_BITRATE_KBPS: '3000',
  AIR3_REQUIRE_HARDWARE_RENDERING: 'false', AIR3_MAX_RESTARTS: '0', AIR3_BROADCAST_DURATION_SECONDS: '180',
};
delete env.DISPLAY;
if (process.env.AIR3_QA_SOFTWARE === 'true') env.AIR3_CHROME_ANGLE = 'swiftshader';
if (process.getuid?.() === 0) env.AIR3_CHROME_NO_SANDBOX = 'true'; // Isolated root CI only.
let providerCalls = 0;
const voice = await readFile(resolve(serviceRoot, 'public/assets/air3/demo/voice-reference.wav'));
const frontendBuild = JSON.parse(await readFile(resolve(serviceRoot, 'public/build/manifest.json'), 'utf8'));
const shippedLook = JSON.parse(await readFile(resolve(serviceRoot, 'public/assets/air3/presets/default-look.json'), 'utf8'));
const gateway = await createGateway({ ...loadConfig(env), port: 0, fetchImpl: async (_url, options) => {
  providerCalls++;
  const request = JSON.parse(options.body);
  assert.equal(request.response_format, 'wav');
  return new Response(voice, { headers: { 'content-type': 'audio/wav' } });
} });
await new Promise((done) => gateway.server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${gateway.server.address().port}`;
env.AIR3_PORT = String(gateway.server.address().port);
env.AIR3_STUDIO_URL = `${base}/studio?output=1`;
const records = [];
let logText = '', lineBuffer = '', exitResult = null;
const child = spawn(process.execPath, ['src/broadcast.mjs'], { cwd: serviceRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
const ended = new Promise((done) => {
  child.once('exit', (code, signal) => { exitResult = { code, signal }; done(exitResult); });
  child.once('error', (error) => { exitResult = { code: -1, error: error.message }; done(exitResult); });
});
child.stdout.on('data', (chunk) => {
  logText = (logText + chunk).slice(-256000);
  lineBuffer += chunk;
  let index;
  while ((index = lineBuffer.indexOf('\n')) >= 0) {
    const line = lineBuffer.slice(0, index); lineBuffer = lineBuffer.slice(index + 1);
    try { const event = JSON.parse(line); records.push(event); console.log(JSON.stringify(event)); } catch {}
  }
});
child.stderr.on('data', (chunk) => { logText = (logText + chunk).slice(-256000); });
async function until(read, accept, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (exitResult) throw new Error(`Broadcaster exited early: ${JSON.stringify(exitResult)}`);
    const value = await read();
    if (accept(value)) return value;
    await sleep(150);
  }
  throw new Error('Local browser smoke condition timed out');
}
async function request(path, method = 'GET', value) {
  const response = await fetch(base + path, { method, headers: {
    Authorization: `Bearer ${env.AIR3_PRODUCER_TOKEN}`, 'Content-Type': 'application/json',
  }, body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(5000) });
  assert.ok(response.ok, `Fixture API status ${response.status}`);
  return response.json();
}
let outcome;
try {
  await until(() => records, (items) => items.some((r) => r.event === 'broadcast-running'), 65000);
  const started = Date.now();
  await request('/api/narrations', 'POST', { id: 'browser-qa-complete', text: 'Prerecorded voice reference supplied with the project; local pipeline test.', language: 'en', emotion: { name: 'warm', intensity: .3 }, presentation: { action: 'monitor', monitor: 'left' } });
  const completed = await until(() => request('/api/narrations/browser-qa-complete'), (job) => job.status === 'finished', 75000);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 12000, 'Completion waits for the real 12-second audio');
  assert.ok(records.some(r => r.event === 'speech-playback' && r.phase === 'playing' && r.lipSync === 'rhubarb:pocketSphinx'), 'Actual player used the audio-derived lip timeline');
  const explicitExpression = records.find(r => r.event === 'speech-playback' && r.job === 'browser-qa-complete' && r.phase === 'playing');
  assert.equal(explicitExpression?.expression, 'warm', 'An explicit narration expression overrides the operator default while speaking');
  assert.equal(explicitExpression?.expressionIntensity, .3);
  await request('/api/narrations', 'POST', { id: 'browser-qa-cancel', text: 'Cancellation of a prerecorded voice reference.', language: 'en' });
  await until(() => request('/api/narrations/browser-qa-cancel'), (job) => job.status === 'playing', 60000);
  await until(() => records, rows => rows.some(r => r.event === 'speech-playback' && r.job === 'browser-qa-cancel' && r.phase === 'playing'), 15000);
  const defaultExpression = records.find(r => r.event === 'speech-playback' && r.job === 'browser-qa-cancel' && r.phase === 'playing');
  assert.equal(defaultExpression?.expression, 'happy', 'Plain text from the agent retains the selected baseline while speaking');
  assert.equal(defaultExpression?.expressionIntensity, 1);
  await request('/api/narrations/browser-qa-cancel', 'DELETE');
  const cancelAt = Date.now();
  await until(() => records, items => items.some(r => r.event === 'speech-playback' && Date.parse(r.at) >= cancelAt && r.phase === 'idle' && !r.job), 20000);
  const cancelled = await request('/api/narrations/browser-qa-cancel');
  assert.equal(cancelled.status, 'cancelled');
  await sleep(1500); // Allow final frames and audio to flush to encoder.
  child.kill('SIGTERM');
  const stopped = await Promise.race([ended, sleep(20000).then(() => { child.kill('SIGTERM'); throw new Error('Broadcaster did not stop'); })]);
  assert.ok(stopped.code === 0 || stopped.code === null || stopped.signal === 'SIGTERM', `Broadcaster exited cleanly: ${JSON.stringify(stopped)}`);
  assert.ok(!records.some(row => row.event === 'capture-drain-timeout'), 'Final MediaRecorder chunk is drained before closing the encoder');
  assert.ok(!records.some(row => row.event === 'encoder-message' && /ended prematurely|Invalid data/i.test(row.message)), 'Capture input reaches the encoder without a truncated tail');
  const runRecordings = records.filter(row => row.event === 'broadcast-running').map(row => row.recording);
  assert.equal(runRecordings.length, 1, 'Exactly one broadcast session expected in this run');
  const recording = resolve(runRecordings[0]);
  assert.equal(dirname(recording), output, 'Validate the file produced by this run, regardless of older recordings');
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', recording], { maxBuffer: 4 * 1024 * 1024 });
  const probe = JSON.parse(stdout);
  const video = probe.streams.find((s) => s.codec_type === 'video');
  const audio = probe.streams.find((s) => s.codec_type === 'audio');
  assert.equal(video?.codec_name, 'h264'); assert.equal(audio?.codec_name, 'aac');
  assert.equal(video.width, 960); assert.equal(video.height, 540);
  assert.ok(Number(video.nb_read_frames) > 15);
  const decoded = await exec('ffmpeg', ['-v', 'error', '-i', recording, '-map', '0:a:0', '-ac', '1', '-ar', '24000', '-f', 's16le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
  let peak = 0, nonSilent = 0;
  for (let i = 0; i + 1 < decoded.stdout.length; i += 2) { const sample = Math.abs(decoded.stdout.readInt16LE(i)); peak = Math.max(peak, sample); if (sample > 200) nonSilent++; }
  assert.ok(peak > 1000 && nonSilent > 12000, 'Recorded AAC contains audible voice, not only a silent track');
  await exec('ffmpeg', ['-v', 'error', '-ss', '1', '-i', recording, '-frames:v', '1', '-y', resolve(output, 'avatar-preview.png')]);
  const rendererDiagnostics = records.find((r) => r.event === 'renderer-final')?.diagnostics;
  assert.equal(rendererDiagnostics?.stageMotion?.target, 'left', 'The authenticated narration presentation cue reached the actual renderer');
  assert.equal(rendererDiagnostics?.lighting?.lights.length, 5, 'The unattended renderer uses all five configurable lights');
  assert.equal(rendererDiagnostics?.hair?.style, shippedLook.hair.style, 'The headless session loads the shipped hairstyle');
  assert.equal(rendererDiagnostics?.footwear?.style, shippedLook.footwear.style, 'The headless session loads the shipped footwear');
  assert.equal(rendererDiagnostics?.footwear?.fit, shippedLook.footwear.fit, 'The headless session loads the fitted boot variant');
  assert.equal(rendererDiagnostics?.clothing?.style, shippedLook.clothing.style, 'The headless session loads the shipped shirt');
  assert.equal(rendererDiagnostics?.hair?.color, 'espresso', 'The requested hair color is used in capture');
  assert.equal(rendererDiagnostics?.avatarRig?.facialLipSync?.emotion, 'happy', 'Idle expression is restored after narrated emotion and cancellation');
  assert.equal(rendererDiagnostics?.avatarRig?.facialLipSync?.emotionIntensity, 1, 'Idle expression retains the requested full intensity');
  assert.deepEqual(rendererDiagnostics?.branding, { corporateInScene: 1, projectInScene: 1, monitorLogos: 0 });
  outcome = { passed: true, date: new Date().toISOString(), frontendBuild, presentationCue: 'monitor:left', desktop: false, displayVariable: false, stdin: 'closed, unattended service mode',
    fixture: '12-second prerecorded speech from the supplied project, returned by a local TTS API fixture; native Rhubarb is actually executed',
    providerCalls, completed: completed.status, cancellation: cancelled.status, completionElapsedMs: elapsed, cleanCaptureShutdown: true,
    expressions: { explicit: { name: explicitExpression.expression, intensity: explicitExpression.expressionIntensity },
      omitted: { name: defaultExpression.expression, intensity: defaultExpression.expressionIntensity },
      afterCancel: { name: rendererDiagnostics.avatarRig.facialLipSync.emotion, intensity: rendererDiagnostics.avatarRig.facialLipSync.emotionIntensity } },
    lipSync: 'rhubarb:pocketSphinx', alignment: 'generated from WAV during this test, not the precalculated demo JSON',
    avatar: 'AIR3-runtime.glb',
    recording: basename(recording), video: { codec: video.codec_name, width: video.width, height: video.height,
      fps: video.r_frame_rate, frames: Number(video.nb_read_frames) },
    audio: { codec: audio.codec_name, sampleRate: audio.sample_rate, channels: audio.channels, peakPcm16: peak, nonSilentSamples: nonSilent },
    durationSeconds: Number(probe.format.duration),
    renderer: rendererDiagnostics,
    limitations: ['Software WebGL and libx264; CUDA/NVENC not tested', '960x540 at 15fps encoding; renderer may run slower and encoder duplicate frames', 'No live RTMP/RTSP publication or external TTS inference', 'No GPU soak or Unreal parity certification'],
  };
  await writeFile(resolve(output, 'result.json'), JSON.stringify(outcome, null, 2) + '\n');
  console.log(JSON.stringify({ event: 'avatar-smoke-passed', output, result: outcome }));
} catch (error) {
  outcome = { passed: false, date: new Date().toISOString(), error: error.stack, events: records };
  await writeFile(resolve(output, 'result.json'), JSON.stringify(outcome, null, 2) + '\n');
  throw error;
} finally {
  if (!exitResult) {
    child.kill('SIGTERM');
    await Promise.race([ended, sleep(12000)]);
    if (!exitResult) { child.kill('SIGKILL'); await ended; }
  }
  await writeFile(resolve(output, 'broadcast.log'), logText);
  await gateway.close();
  if (process.env.AIR3_QA_DIR) await rm(temporary, { recursive: true, force: true });
}
