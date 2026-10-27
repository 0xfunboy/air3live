/** Real local browser -> MediaRecorder -> FFmpeg smoke check; no external TTS or publishing. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createGateway } from '../src/gateway.mjs';
import { assemblePcmWav } from '../src/speech.mjs';
import { loadConfig, serviceRoot } from '../src/config.mjs';

const exec = promisify(execFile);
const temporary = await mkdtemp(resolve(tmpdir(), 'air3-browser-qa-'));
const output = resolve(process.env.AIR3_QA_DIR || temporary, 'browser-smoke');
await mkdir(output, { recursive: true });
const env = { ...process.env,
  AIR3_PRODUCER_TOKEN: randomBytes(32).toString('hex'), AIR3_PLAYER_TOKEN: randomBytes(32).toString('hex'),
  AIR3_HOST: '127.0.0.1', AIR3_DATA_DIR: resolve(temporary, 'data'),
  AIR3_DAPP_BASE_URL: '', AIR3_AVATAR_URL: '', AIR3_WIDTH: '960', AIR3_HEIGHT: '540', AIR3_FPS: '15',
  AIR3_TTS_BASE_URL: 'http://unused.local/v1', AIR3_PLAYER_LEASE_MS: '3000',
  AIR3_OUTPUT_MODE: 'file', AIR3_RECORDING_DIR: output, AIR3_RTMP_URL: '', AIR3_RTMP_KEY: '', AIR3_RTSP_URL: '',
  AIR3_VIDEO_ENCODER: 'libx264', AIR3_VIDEO_BITRATE_KBPS: '1500', AIR3_CAPTURE_BITRATE_KBPS: '3000',
  AIR3_REQUIRE_HARDWARE_RENDERING: 'false', AIR3_MAX_RESTARTS: '0', AIR3_BROADCAST_DURATION_SECONDS: '90',
};
delete env.DISPLAY;
if (process.env.AIR3_QA_SOFTWARE === 'true') env.AIR3_CHROME_ANGLE = 'swiftshader';
if (process.getuid?.() === 0) env.AIR3_CHROME_NO_SANDBOX = 'true'; // Isolated root CI only; deployment keeps sandbox.
let providerCalls = 0;
function tone(seconds) {
  const rate = 24000;
  const pcm = Buffer.alloc(rate * seconds * 2);
  for (let i = 0; i < pcm.length / 2; i++) {
    const time = i / rate;
    const envelope = Math.min(1, time / 0.04, (seconds - time) / 0.04);
    const gate = Math.sin(2 * Math.PI * 2 * time) > -0.25 ? 1 : 0;
    pcm.writeInt16LE(Math.round(6000 * envelope * gate * Math.sin(2 * Math.PI * 440 * time)), i * 2);
  }
  return assemblePcmWav([{ channels: 1, sampleRate: rate, bitsPerSample: 16, blockAlign: 2, byteRate: rate * 2, pcm }]).bytes;
}
const gateway = await createGateway({ ...loadConfig(env), port: 0, fetchImpl: async (_url, options) => {
  providerCalls++;
  const request = JSON.parse(options.body);
  assert.equal(request.response_format, 'wav');
  return new Response(tone(request.input.startsWith('Cancellation') ? 6 : 2.4), { headers: { 'content-type': 'audio/wav' } });
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
  await request('/api/narrations', 'POST', { id: 'browser-qa-complete', text: 'Local audio test. Synthetic calibration tone, not speech.', language: 'en' });
  const completed = await until(() => request('/api/narrations/browser-qa-complete'), (job) => job.status === 'finished');
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 2400, 'Completion must wait for actual audio duration');
  await request('/api/narrations', 'POST', { id: 'browser-qa-cancel', text: 'Cancellation calibration tone.', language: 'it' });
  await until(() => request('/api/narrations/browser-qa-cancel'), (job) => job.status === 'playing');
  await request('/api/narrations/browser-qa-cancel', 'DELETE');
  await sleep(1700); // Allows a failed heartbeat to stop the real AudioBufferSource.
  const cancelled = await request('/api/narrations/browser-qa-cancel');
  assert.equal(cancelled.status, 'cancelled');
  child.kill('SIGTERM');
  const stopped = await Promise.race([ended, sleep(15000).then(() => { throw new Error('Broadcaster did not stop'); })]);
  assert.ok(stopped.code === 0 || stopped.code === null || stopped.signal === 'SIGTERM', `Broadcaster exited cleanly: ${JSON.stringify(stopped)}`);
  const files = (await readdir(output)).filter((file) => file.endsWith('.mkv'));
  assert.equal(files.length, 1, 'Exactly one recording expected in a fresh QA directory');
  const recording = resolve(output, files[0]);
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', recording], { maxBuffer: 4 * 1024 * 1024 });
  const probe = JSON.parse(stdout);
  const video = probe.streams.find((s) => s.codec_type === 'video');
  const audio = probe.streams.find((s) => s.codec_type === 'audio');
  assert.equal(video?.codec_name, 'h264'); assert.equal(audio?.codec_name, 'aac');
  assert.equal(video.width, 960); assert.equal(video.height, 540);
  assert.ok(Number(video.nb_read_frames) > 15);
  const decoded = await exec('ffmpeg', ['-v', 'error', '-i', recording, '-map', '0:a:0', '-ac', '1', '-ar', '24000', '-f', 's16le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
  let peak = 0, nonSilent = 0;
  for (let i = 0; i + 1 < decoded.stdout.length; i += 2) {
    const sample = Math.abs(decoded.stdout.readInt16LE(i)); peak = Math.max(peak, sample);
    if (sample > 200) nonSilent++;
  }
  assert.ok(peak > 1000 && nonSilent > 12000, 'Recording must contain the generated audible tone, not only a silent track');
  await exec('ffmpeg', ['-v', 'error', '-ss', '2', '-i', recording, '-frames:v', '1', '-y', resolve(output, 'preview.png')]);
  outcome = { passed: true, date: new Date().toISOString(), desktop: false, displayVariable: false,
    fixture: 'synthetic PCM16 tones, no external provider or market API', providerCalls,
    completed: completed.status, cancellation: cancelled.status, completionElapsedMs: elapsed,
    recording: basename(recording), video: { codec: video.codec_name, width: video.width, height: video.height,
      fps: video.r_frame_rate, frames: Number(video.nb_read_frames) },
    audio: { codec: audio.codec_name, sampleRate: audio.sample_rate, channels: audio.channels, peakPcm16: peak, nonSilentSamples: nonSilent },
    durationSeconds: Number(probe.format.duration),
    renderer: records.find((r) => r.event === 'renderer-final')?.diagnostics,
    limitations: ['Software WebGL/libx264 QA, not CUDA or NVENC validation', '960x540 at 15fps encoding; not a 1080p benchmark',
      'No live RTMP/RTSP publication', 'No actual TTS model or avatar used'],
  };
  await writeFile(resolve(output, 'result.json'), JSON.stringify(outcome, null, 2) + '\n');
  console.log(JSON.stringify({ event: 'browser-smoke-passed', output, result: outcome }));
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
