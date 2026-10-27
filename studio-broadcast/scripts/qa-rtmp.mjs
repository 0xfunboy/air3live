import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encoderArgs } from '../src/encoder.mjs';

// Local protocol test. It publishes only to a receiver created on loopback,
// using the real recorded headless program and the production encoder flags.
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.resolve(process.env.AIR3_QA_DIR || path.join(root, 'docs/validation/live-3.0'));
const ffmpeg = process.env.AIR3_FFMPEG || 'ffmpeg';
const ffprobe = process.env.AIR3_FFPROBE || 'ffprobe';
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'air3-rtmp-loopback-'));
const report = { schema: 'air3.rtmp-loopback.v1', startedAt: new Date().toISOString(), passed: false,
  scope: 'Local RTMP publish/receive of the actual headless recording; no platform, OAuth, TLS or hardware GPU assertion',
  temporary, checks: [] };
const children = new Set();

function run(command, args, { timeout = 30000, binary = false } = {}) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let stdout = [], bytes = 0, stderr = '', settled = false;
  const complete = new Promise((resolve, reject) => {
    const finish = (error, code, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timer); children.delete(child);
      if (error) reject(error);
      else resolve({ code, signal, stdout: binary ? Buffer.concat(stdout) : Buffer.concat(stdout).toString(), stderr });
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error(`${command} timed out`)); }, timeout);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) { child.kill('SIGKILL'); finish(new Error('QA output exceeded bound')); }
      else stdout.push(chunk);
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-65536); });
    child.once('error', error => finish(error));
    child.once('close', (code, signal) => finish(null, code, signal));
  });
  // Callers can start independent encoder/receiver processes before awaiting them.
  complete.catch(() => {});
  return { child, complete };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

try {
  const source = JSON.parse(await fs.readFile(path.join(output, 'compiled-live/report.json'), 'utf8'));
  assert.equal(source.passed, true, 'Run qa:live successfully before qa:rtmp');
  const input = source.capture.recording;
  const inputBytes = await fs.readFile(input);
  report.source = { report: 'compiled-live/report.json', recording: input,
    sha256: createHash('sha256').update(inputBytes).digest('hex'), bytes: inputBytes.length };
  const destination = `rtmp://127.0.0.1:${await freePort()}/live/air3-local-qa`;
  const received = path.join(temporary, 'received.mkv');
  const receiverArgs = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-listen', '1', '-timeout', '15',
    '-i', destination, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-n', received];
  const receiver = run(ffmpeg, receiverArgs, { timeout: 40000 });
  await new Promise(resolve => setTimeout(resolve, 500));
  const config = { mode: 'rtmp', bitrateKbps: 2500, gateway: { width: 1280, height: 720, fps: 30 } };
  const args = encoderArgs(config, 'libx264', destination);
  const i = args.indexOf('-i');
  args.splice(i, 2, '-re', '-ss', String(Math.max(0, source.capture.durationSeconds - 12)), '-i', input);
  args.splice(args.length - 1, 0, '-t', '8');
  const sent = await run(ffmpeg, args, { timeout: 35000 }).complete;
  const accepted = await receiver.complete;
  report.publisher = { exitCode: sent.code, stderr: sent.stderr };
  report.receiver = { exitCode: accepted.code, stderr: accepted.stderr };
  assert.equal(sent.code, 0, `RTMP publisher failed: ${sent.stderr}`);
  assert.equal(accepted.code, 0, `RTMP receiver failed: ${accepted.stderr}`);
  report.checks.push('Production H.264/AAC encoder flags publish to a real local RTMP listener');
  const probe = await run(ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', received]).complete;
  assert.equal(probe.code, 0, probe.stderr);
  const meta = JSON.parse(probe.stdout);
  const video = meta.streams.find(s => s.codec_type === 'video');
  const audio = meta.streams.find(s => s.codec_type === 'audio');
  assert.equal(video.codec_name, 'h264');
  assert.equal(video.width, 1280); assert.equal(video.height, 720);
  assert.ok(Number(video.nb_read_frames) >= 220);
  assert.equal(audio.codec_name, 'aac'); assert.equal(audio.sample_rate, '48000'); assert.equal(audio.channels, 2);
  assert.ok(Number(meta.format.duration) >= 7.8 && Number(meta.format.duration) < 9);
  report.checks.push('Received stream decodes as 720p H.264 and 48 kHz stereo AAC with the expected duration and frame count');
  const pcm = await run(ffmpeg, ['-v', 'error', '-i', received, '-map', '0:a:0', '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], { binary: true }).complete;
  assert.equal(pcm.code, 0, pcm.stderr);
  let peak = 0, nonSilent = 0;
  for (let n = 0; n + 1 < pcm.stdout.length; n += 2) {
    const sample = Math.abs(pcm.stdout.readInt16LE(n));
    peak = Math.max(peak, sample); if (sample > 32) nonSilent++;
  }
  assert.ok(peak > 500 && nonSilent > 1000, 'Received voice must contain non-silent samples');
  report.checks.push('Voice remains audible after RTMP transport and AAC decoding');
  report.received = { file: received, bytes: (await fs.stat(received)).size, durationSeconds: Number(meta.format.duration),
    video: { codec: video.codec_name, width: video.width, height: video.height, frames: Number(video.nb_read_frames), fps: video.r_frame_rate },
    audio: { codec: audio.codec_name, rate: Number(audio.sample_rate), channels: audio.channels, peakPCM: peak, nonSilentSamples: nonSilent } };
  report.encoderSourceSha256 = createHash('sha256').update(await fs.readFile(new URL('../src/encoder.mjs', import.meta.url))).digest('hex');
  report.passed = true;
} catch (error) {
  report.error = error.stack || String(error);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill('SIGKILL');
  report.finishedAt = new Date().toISOString();
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'rtmp-loopback.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, error: report.error, output: path.join(output, 'rtmp-loopback.json') }));
}
