import { fork, execFile } from 'node:child_process';
import { access, mkdir, appendFile, stat, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { serviceRoot, loadBroadcastConfig } from './config.mjs';
import { selectEncoder, redactValue } from './encoder.mjs';
import { streamDestination, VIDEO_PROFILES } from './live-settings.mjs';
import { QueueError } from './queue.mjs';

const exec = promisify(execFile);
function cancelled() { return new QueueError('LIVE_START_CANCELLED', 409); }
function abortable(promise, signal) {
  return new Promise((done, fail) => {
    const abort = () => fail(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then(done, fail).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function endedWithin(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise.then(() => true), new Promise(done => { timer = setTimeout(() => done(false), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
export function buildLiveEnvironment(settings, gatewayConfig, baseEnv, { mode, origin }) {
  if (!['live', 'record', 'twitch-test'].includes(mode)) throw new QueueError('INVALID_LIVE_MODE', 400);
  if (mode === 'twitch-test' && settings.stream.provider !== 'twitch') throw new QueueError('TWITCH_TEST_ONLY', 400);
  const profile = VIDEO_PROFILES[settings.stream.profile];
  const env = { ...baseEnv, AIR3_PRODUCER_TOKEN: gatewayConfig.producerToken, AIR3_PLAYER_TOKEN: gatewayConfig.playerToken,
    AIR3_PORT: String(gatewayConfig.port), AIR3_DATA_DIR: gatewayConfig.dataDir,
    AIR3_STUDIO_URL: `${origin}/studio?output=1&live=1`, AIR3_AVATAR_URL: gatewayConfig.avatarUrl || '',
    AIR3_WIDTH: String(profile.width), AIR3_HEIGHT: String(profile.height), AIR3_FPS: String(profile.fps),
    AIR3_RENDER_QUALITY: settings.stream.quality,
    AIR3_OUTPUT_MODE: mode === 'record' ? 'file' : 'rtmp',
    AIR3_RTMP_URL: mode === 'record' ? '' : streamDestination(settings.stream, { test: mode === 'twitch-test' || settings.stream.twitchBandwidthTest }),
    AIR3_RTMP_KEY: '', AIR3_RTSP_URL: '', AIR3_RECORDING_DIR: resolve(gatewayConfig.dataDir, 'recordings'),
    AIR3_VIDEO_ENCODER: settings.stream.encoder, AIR3_VIDEO_BITRATE_KBPS: String(settings.stream.bitrateKbps),
    AIR3_BROADCAST_DURATION_SECONDS: '0', AIR3_CONTROL_STDIN: 'false', AIR3_LIVE_IPC: 'true',
    // Record tests can use software WebGL. Public output must prove actual GPU rendering.
    AIR3_REQUIRE_HARDWARE_RENDERING: mode === 'record' ? 'false' : 'true',
  };
  return env;
}

export class LiveProcess extends EventEmitter {
  constructor({ config, getSettings, baseEnv = process.env, forkImpl = fork, now = Date.now,
    stopTimeoutMs = 18_000, killTimeoutMs = 4_000, killTreeImpl = null }) {
    super(); Object.assign(this, { config, getSettings, baseEnv, forkImpl, now });
    Object.assign(this, { stopTimeoutMs, killTimeoutMs, killTreeImpl });
    this.child = null; this.busy = false; this.state = { phase: 'stopped', mode: null, startedAt: null,
      encoder: null, frame: 0, fps: 0, renderFps: null, bitrate: null, elapsedSeconds: 0, lastProgressAt: null,
      error: null, attempt: 0, previewAt: null, recording: null };
    this.events = []; this.preview = null; this.logChain = Promise.resolve(); this.pending = new Map();
    this.generation = 0; this.startAbort = null; this.startDone = Promise.resolve(); this.stopTask = null; this.closed = false;
    this.knownSecrets = new Set(); this.previewRequestAt = null; this.stopRequested = false;
    this.lastOrigin = null; this.restartAttempts = 0; this.recoveryTimer = null;
  }
  snapshot() { return redactValue({ ...this.state, events: this.events.slice(-30), busy: this.busy }, this.secrets()); }
  secrets() {
    const s = this.getSettings();
    const current = [s.stream?.key, s.tts?.apiKey, s.market?.coinglassKey, s.twitch?.clientSecret, s.twitch?.accessToken,
      s.twitch?.refreshToken, this.config.producerToken, this.config.playerToken, this.config.live?.operatorToken,
      this.baseEnv.AIR3_TTS_API_KEY, this.baseEnv.AIR3_RTMP_KEY, this.baseEnv.AIR3_RTMP_URL, this.baseEnv.AIR3_RTSP_URL];
    // A running child may still emit the credential it started with after the
    // operator changes settings. Retain those spellings for this process life.
    for (const secret of current) if (typeof secret === 'string' && secret.length) this.knownSecrets.add(secret);
    return [...this.knownSecrets];
  }
  event(event, data = {}) {
    const safe = redactValue({ ...data, at: new Date(this.now()).toISOString(), event }, this.secrets());
    this.events.push(safe); if (this.events.length > 100) this.events.shift(); this.emit('event', safe);
    this.logChain = this.logChain.then(async () => {
      await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
      const file = resolve(this.config.dataDir, 'live-session.log');
      try { if ((await stat(file)).size > 2 * 1024 * 1024) await rename(file, file + '.1'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await appendFile(file, JSON.stringify(safe) + '\n', { mode: 0o600 });
    }).catch(() => {});
  }
  environment(mode, origin) { return buildLiveEnvironment(this.getSettings(), this.config, this.baseEnv, { mode, origin }); }
  async preflight(mode, origin, { signal } = {}) {
    if (signal?.aborted) throw cancelled();
    let b;
    try { b = loadBroadcastConfig(this.environment(mode, origin)); }
    catch (error) { if (error instanceof QueueError) throw error; throw new QueueError('BROADCAST_CONFIG_INVALID', 400); }
    await access(b.browserPath).catch(() => { throw new QueueError('BROWSER_NOT_INSTALLED', 503); });
    if (signal?.aborted) throw cancelled();
    await exec(b.ffmpeg, ['-version'], { timeout: 5000, maxBuffer: 64 * 1024, signal }).catch(() => { throw signal?.aborted ? cancelled() : new QueueError('FFMPEG_NOT_AVAILABLE', 503); });
    const encoder = await selectEncoder(b, { signal }).catch(() => { throw signal?.aborted ? cancelled() : new QueueError('ENCODER_PROBE_FAILED', 503); });
    return { ok: true, encoder, width: b.gateway.width, height: b.gateway.height, fps: b.gateway.fps,
      mode, hardwareRenderingRequired: b.requireHardware, rendererCheck: 'performed-on-start' };
  }
  async start(mode, origin) {
    if (this.closed) throw new QueueError('BROADCAST_CLOSED', 409);
    if (this.busy || this.child || this.stopTask) throw new QueueError('BROADCAST_ALREADY_ACTIVE', 409);
    this.busy = true;
    this.stopRequested = false;
    this.lastOrigin = origin;
    if (this.recoveryTimer) { clearTimeout(this.recoveryTimer); this.recoveryTimer = null; }
    const generation = ++this.generation, aborter = this.startAbort = new AbortController();
    let finishStart; this.startDone = new Promise(done => { finishStart = done; });
    const current = () => { if (aborter.signal.aborted || generation !== this.generation || this.closed) throw cancelled(); };
    this.state.phase = 'preflight'; this.state.error = null;
    this.secrets();
    try {
      const check = await abortable(this.preflight(mode, origin, { signal: aborter.signal }), aborter.signal);
      current();
      await abortable(mkdir(this.config.dataDir, { recursive: true, mode: 0o700 }), aborter.signal);
      current();
      const env = this.environment(mode, origin);
      this.state = { ...this.state, phase: 'starting', mode, startedAt: this.now(), encoder: check.encoder,
        frame: 0, fps: 0, renderFps: null, bitrate: null, elapsedSeconds: 0, lastProgressAt: null,
        error: null, attempt: 0, previewAt: null, recording: null };
      this.preview = null; this.previewRequestAt = null;
      const child = this.forkImpl(resolve(serviceRoot, 'src/broadcast.mjs'), [], { cwd: serviceRoot, env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, detached: process.platform !== 'win32' });
      this.child = child; let line = '', stderrLine = '', discardStderrLine = false;
      const stderrEvent = raw => {
        if (!raw.trim()) return;
        // Redact the complete line before truncating. A long credential or a
        // credential split across pipe chunks must not leak a partial prefix.
        this.event('runtime-message', { message: redactValue(raw, this.secrets()).slice(0, 2000) });
      };
      child.stdout.on('data', data => {
        if (this.child !== child) return;
        line = (line + data.toString()).slice(-128_000);
        let at; while ((at = line.indexOf('\n')) >= 0) {
          const part = line.slice(0, at); line = line.slice(at + 1);
          try { this.handleEvent(JSON.parse(part)); } catch { /* Only structured owned-process events. */ }
        }
      });
      child.stderr.on('data', data => {
        if (this.child !== child) return;
        stderrLine += data.toString();
        let at;
        while ((at = stderrLine.indexOf('\n')) >= 0) {
          const row = stderrLine.slice(0, at); stderrLine = stderrLine.slice(at + 1);
          if (!discardStderrLine && row.length <= 128_000) stderrEvent(row);
          discardStderrLine = false;
        }
        if (stderrLine.length > 128_000) { stderrLine = ''; discardStderrLine = true; }
      });
      child.on('message', message => {
        if (this.child !== child || this.state.phase === 'stopping') return;
        if (message?.type === 'preview' && typeof message.jpeg === 'string' && message.jpeg.length < 1_500_000 && /^[A-Za-z0-9+/=]+$/.test(message.jpeg)) {
          const bytes = Buffer.from(message.jpeg, 'base64');
          if (bytes.length > 8 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) { this.preview = bytes; this.state.previewAt = this.now(); }
        } else if (message?.type === 'command-result' && this.pending.has(message.id)) {
          this.pending.get(message.id)(redactValue(message, this.secrets())); this.pending.delete(message.id);
        }
      });
      child.once('error', () => { if (this.child === child && this.state.phase !== 'stopping') { this.state.error = 'BROADCAST_PROCESS_FAILED'; this.state.phase = 'failed'; } });
      this.ended = new Promise(done => {
        let finished = false;
        const finish = (code, signal) => {
          if (finished) return; finished = true; clearInterval(this.watchdog);
          if (!discardStderrLine) stderrEvent(stderrLine); stderrLine = '';
          const stopped = this.stopRequested || this.state.phase === 'stopping';
          this.state.phase = stopped || code === 0 ? 'stopped' : 'failed';
          if (!stopped && code !== 0) this.state.error ||= 'BROADCAST_PROCESS_FAILED';
          this.event('process-exited', { code, signal, expected: stopped }); this.child = null;
          this.rejectPending();
          done({ code, signal });
          if (!stopped && this.state.mode === 'live' && !this.closed && this.getSettings()?.stream?.autoRecovery !== false) {
            this.scheduleAutoRecovery();
          }
        };
        child.once('exit', finish); child.once('error', () => finish(-1, null));
      });
      this.watchdog = setInterval(() => {
        const age = this.now() - (this.state.lastProgressAt || this.state.startedAt);
        if (!this.child || this.state.phase === 'stopping') return;
        if (this.state.phase === 'running' && age > 15_000) this.state.phase = 'stalled';
        if (age > 150_000) { this.state.error = 'NO_ENCODER_PROGRESS'; void this.stop().catch(() => {}); }
      }, 2000); this.watchdog.unref?.();
      this.event('start-requested', { mode, profile: this.getSettings().stream.profile, provider: this.getSettings().stream.provider });
      return this.snapshot();
    } catch (error) {
      if (aborter.signal.aborted || generation !== this.generation || this.closed) {
        if (!this.child) this.state.phase = 'stopped';
        throw cancelled();
      }
      if (!this.child) { this.state.phase = 'failed'; this.state.error = error instanceof QueueError ? error.code : 'BROADCAST_START_FAILED'; }
      if (error instanceof QueueError) throw error;
      throw new QueueError('BROADCAST_START_FAILED', 503);
    } finally { this.busy = false; if (this.startAbort === aborter) this.startAbort = null; finishStart(); }
  }
  handleEvent(row) {
    if (!row || typeof row.event !== 'string') return;
    row = redactValue(row, this.secrets());
    if (row.event === 'encoder-progress') {
      const frame = Number(row.frame), seconds = Number(row.seconds);
      if (!Number.isFinite(frame) || !Number.isFinite(seconds) || frame < 0 || seconds < 0) return;
      const advancing = frame > this.state.frame || seconds > this.state.elapsedSeconds;
      Object.assign(this.state, { frame, elapsedSeconds: seconds, fps: Number.isFinite(Number(row.fps)) ? Number(row.fps) : 0, bitrate: typeof row.bitrate === 'string' ? row.bitrate.slice(0, 100) : null });
      if (advancing && frame > 0 && this.state.phase !== 'stopping' && !this.stopRequested) {
        this.state.phase = 'running'; this.state.lastProgressAt = this.now(); this.state.error = null;
      }
      return;
    }
    if (row.event === 'renderer-metrics') { this.state.renderFps = Number.isFinite(Number(row.fps)) ? Number(row.fps) : null; this.state.renderer = typeof row.gpuRenderer === 'string' ? row.gpuRenderer.slice(0, 300) : null; return; }
    if (row.event === 'encoder-selected') this.state.encoder = row.encoder;
    if (row.event === 'broadcast-running') { this.state.recording = row.recording ? String(row.recording).split(/[\\/]/).pop() : null;
      this.state.frame = 0; this.state.elapsedSeconds = 0; this.state.lastProgressAt = this.now(); }
    if (row.event === 'broadcast-error') { if (this.state.phase !== 'stopping' && !this.stopRequested) this.state.phase = 'reconnecting'; this.state.error = typeof row.message === 'string' ? row.message.slice(0, 2000) : 'BROADCAST_ERROR'; this.state.attempt = Number.isSafeInteger(row.attempt) ? row.attempt : 0; this.state.lastProgressAt = this.now(); }
    if (row.event === 'renderer-ready') this.state.renderer = row.diagnostics?.gpuRenderer;
    this.event(row.event, Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'event' && k !== 'at' && k !== 'diagnostics')));
  }
  async command(action) {
    if (!this.child?.connected || this.state.phase === 'stopping' || this.closed) throw new QueueError('BROADCAST_NOT_ACTIVE', 409);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new QueueError('COMMAND_TIMEOUT', 504)); }, 15_000);
      this.pending.set(id, result => { clearTimeout(timer); result.ok === true ? resolve(result) : reject(new QueueError(typeof result.error === 'string' && /^[A-Z0-9_]{1,80}$/.test(result.error) ? result.error : 'COMMAND_FAILED', 409)); });
      try {
        this.child.send({ type: 'command', id, action }, error => {
          if (error) { clearTimeout(timer); this.pending.delete(id); reject(new QueueError('COMMAND_FAILED', 409)); }
        });
      } catch { clearTimeout(timer); this.pending.delete(id); reject(new QueueError('COMMAND_FAILED', 409)); }
    });
  }
  requestPreview() {
    if (!this.child?.connected || this.state.phase === 'stopping' || this.closed) return false;
    if (this.previewRequestAt !== null && this.now() - this.previewRequestAt < 3000) return true;
    this.previewRequestAt = this.now();
    try { this.child.send({ type: 'preview-request' }, () => {}); return true; } catch { return false; }
  }
  rejectPending() { for (const done of this.pending.values()) done({ ok: false, error: 'BROADCAST_STOPPED' }); this.pending.clear(); }
  async killTree(child, force) {
    if (this.killTreeImpl) return this.killTreeImpl(child, force);
    if (this.forkImpl !== fork) { child.kill(force ? 'SIGKILL' : 'SIGTERM'); return; }
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return;
    if (process.platform === 'win32') {
      await exec('taskkill', ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true, timeout: this.killTimeoutMs, maxBuffer: 32 * 1024 }).catch(() => {});
    } else {
      // Chromium can create its own process group. Collect only descendants
      // of this owned child, without command lines or credential-bearing args,
      // before terminating the parent that links them together.
      const descendants = [];
      try {
        const { stdout } = await exec('ps', ['-eo', 'pid=,ppid='], { timeout: Math.min(2000, this.killTimeoutMs), maxBuffer: 1024 * 1024 });
        const rows = stdout.split('\n').map(line => line.trim().split(/\s+/).map(Number)).filter(([pid, ppid]) => Number.isSafeInteger(pid) && pid > 1 && Number.isSafeInteger(ppid));
        const children = new Map();
        for (const [pid, parent] of rows) { if (!children.has(parent)) children.set(parent, []); children.get(parent).push(pid); }
        const queue = [child.pid], seen = new Set(queue);
        while (queue.length && descendants.length < 10_000) for (const pid of children.get(queue.shift()) ?? []) {
          if (seen.has(pid) || pid === process.pid) continue; seen.add(pid); descendants.push(pid); queue.push(pid);
        }
      } catch { /* The owned process group remains the fallback. */ }
      if (this.child !== child) return;
      for (const pid of descendants.reverse()) { try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); } catch {} }
      try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
      catch { try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch {} }
    }
  }
  scheduleAutoRecovery() {
    if (this.recoveryTimer || this.closed || this.stopRequested || this.child || this.busy) return;
    const settings = this.getSettings?.();
    if (settings?.stream?.autoRecovery === false) return;
    this.restartAttempts = Math.min((this.restartAttempts || 0) + 1, 30);
    const delayMs = Math.min(60_000, 3000 * Math.pow(1.5, Math.min(this.restartAttempts - 1, 8)));
    this.state.phase = 'reconnecting';
    this.state.error = `AUTO_RECONNECTING_${this.restartAttempts}`;
    this.event('auto-recovery-scheduled', { attempt: this.restartAttempts, delayMs, mode: 'live' });
    this.recoveryTimer = setTimeout(async () => {
      this.recoveryTimer = null;
      if (this.closed || this.stopRequested || this.child || this.busy) return;
      try {
        await this.start('live', this.lastOrigin || `http://127.0.0.1:${this.config.port || 5890}`);
        this.event('auto-recovery-success', { attempt: this.restartAttempts });
      } catch (err) {
        this.event('auto-recovery-retry-failed', { error: err?.code || err?.message });
        if (!this.closed && !this.stopRequested) this.scheduleAutoRecovery();
      }
    }, delayMs);
    this.recoveryTimer.unref?.();
  }
  async stop() {
    if (this.recoveryTimer) { clearTimeout(this.recoveryTimer); this.recoveryTimer = null; }
    this.restartAttempts = 0;
    if (this.stopTask) return this.stopTask;
    this.generation++; this.stopRequested = true; this.startAbort?.abort(cancelled()); this.rejectPending();
    const task = (async () => {
      await this.startDone;
      if (!this.child) { if (this.state.phase === 'preflight') this.state.phase = 'stopped'; return this.snapshot(); }
      this.state.phase = 'stopping'; const child = this.child;
      try { if (child.connected) child.send({ type: 'stop' }, error => { if (error && this.child === child) void this.killTree(child, false).catch(() => {}); });
        else await this.killTree(child, false); }
      catch { await this.killTree(child, false); }
      if (!await endedWithin(this.ended, this.stopTimeoutMs) && this.child === child) {
        await this.killTree(child, true);
        if (!await endedWithin(this.ended, this.killTimeoutMs)) {
          // Retain ownership and block a new start when the OS did not confirm
          // exit. Never claim stopped while an encoder might still be alive.
          this.state.phase = 'failed'; this.state.error = 'BROADCAST_STOP_TIMEOUT';
          this.event('stop-timeout'); throw new QueueError('BROADCAST_STOP_TIMEOUT', 504);
        }
      }
      return this.snapshot();
    })();
    this.stopTask = task;
    try { return await task; } finally { if (this.stopTask === task) this.stopTask = null; }
  }
  async close() {
    this.closed = true;
    if (this.recoveryTimer) { clearTimeout(this.recoveryTimer); this.recoveryTimer = null; }
    try { await this.stop(); } finally { await this.logChain; }
  }
}
