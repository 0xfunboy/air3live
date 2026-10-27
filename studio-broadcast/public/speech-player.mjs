import { boundedFetch, fetchJson, safeAudioPath } from './pure.mjs';
import { normalizeMouthCues, mouthCueAt, mouthPoseWeightsAt } from './lip-sync.mjs';

const delay = (ms, signal) => new Promise((resolve) => {
  if (signal.aborted) return resolve();
  const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, ms);
  signal.addEventListener('abort', finish, { once: true });
});

export class SpeechPlayer {
  #token = null;
  #playerId = null;
  #session = null;
  #active = null;
  #epoch = 0;
  #context = null;
  #analyser = null;
  #samples = null;
  #loop = null;
  #silentSource = null;
  #silentGain = null;

  constructor(onChange = () => {}) {
    this.onChange = onChange;
    this.state = { phase: 'observer', connected: false, currentJob: null, text: '', error: '',
      audioState: 'not-created', elapsed: 0, duration: 0, amplitude: 0, lipSync: 'none', mouthCue: 'X', mouthWeights: null, presentation: null };
  }

  emit() { this.onChange({ ...this.state }); }
  diagnostics() {
    const state = this.sample();
    return { ...state, audioState: this.#context?.state ?? 'not-created', audioArmed: !!this.#silentSource };
  }

  // Called by the broadcaster before tab capture. Zero gain is inaudible and
  // does not claim a job, but keeps one stable audio graph alive for capture.
  async armAudio() {
    if (!this.#context) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) throw new Error('Web Audio is unavailable');
      this.#context = new AudioCtx({ latencyHint: 'playback' });
      this.#analyser = this.#context.createAnalyser();
      this.#analyser.fftSize = 512;
      this.#analyser.connect(this.#context.destination);
      this.#samples = new Float32Array(this.#analyser.fftSize);
      this.#silentGain = this.#context.createGain();
      this.#silentGain.gain.value = 0;
      this.#silentGain.connect(this.#context.destination);
      this.#silentSource = this.#context.createOscillator();
      this.#silentSource.connect(this.#silentGain);
      this.#silentSource.start();
    }
    await this.#context.resume();
    if (this.#context.state !== 'running') throw new Error('Audio is suspended; broadcaster must allow autoplay');
    this.state.audioState = 'running'; this.emit();
    return { audioState: 'running', audioArmed: true };
  }

  async connect({ token, playerId }) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 4096) throw new Error('Invalid player credential');
    if (typeof playerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(playerId)) throw new Error('Invalid player identifier');
    await this.disconnect({ keepAudio: true });
    const epoch = ++this.#epoch;
    this.#token = token;
    this.#playerId = playerId;
    this.#session = new AbortController();
    try {
      await this.armAudio();
      this.state = { ...this.state, phase: 'idle', connected: true, error: '', audioState: 'running' };
      this.emit();
      this.#loop = this.run(epoch);
      return { connected: true, audioState: 'running' };
    } catch (error) {
      await this.disconnect();
      this.state.error = error.message; this.emit();
      throw error;
    }
  }

  async request(path, body, signal = this.#session?.signal) {
    if (!this.#token) throw new Error('Player is disconnected');
    return fetchJson(path, { method: 'POST', signal,
      headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    { timeoutMs: 5000, maxBytes: 1024 * 1024 });
  }

  event(active, event, error, signal = active.controller.signal) {
    return this.request(`/api/player/${encodeURIComponent(active.job.id)}/events`, {
      playerId: this.#playerId, leaseToken: active.job.leaseToken, event,
      ...(error ? { error: String(error).slice(0, 160) } : {}),
    }, signal);
  }

  stopActive(reason) {
    const active = this.#active;
    if (!active) return;
    active.cancelled = true;
    active.reason = reason;
    active.controller.abort();
    clearTimeout(active.heartbeat);
    clearTimeout(active.watchdog);
    try { active.source?.stop(); } catch { /* Already ended. */ }
    active.finish?.();
    this.state.amplitude = 0;
    this.state.mouthCue = 'X';
    this.state.mouthWeights = null;
    this.state.presentation = null;
  }

  async disconnect({ keepAudio = false } = {}) {
    const active = this.#active;
    ++this.#epoch;
    this.stopActive('Player disconnected');
    this.#session?.abort();
    // A clean disconnect terminalizes owned work. Crash/restart safety belongs to
    // the durable gateway lease; no playback state is ever stored in the browser.
    if (active && this.#token) {
      try { await this.event(active, 'failed', 'Player disconnected', new AbortController().signal); } catch { /* Lease will expire. */ }
    }
    await this.#loop?.catch(() => {});
    this.#loop = null;
    this.#active = null;
    this.#token = this.#playerId = null;
    this.#session = null;
    if (!keepAudio) {
      this.#analyser?.disconnect();
      this.#analyser = this.#samples = null;
      if (this.#silentSource) { this.#silentSource.stop(); this.#silentSource.disconnect(); }
      this.#silentGain?.disconnect();
      this.#silentSource = this.#silentGain = null;
      if (this.#context) await this.#context.close().catch(() => {});
      this.#context = null;
    }
    this.state = { ...this.state, phase: 'observer', connected: false, currentJob: null,
      text: '', elapsed: 0, duration: 0, amplitude: 0, mouthCue: 'X', mouthWeights: null, presentation: null, lipSync: 'none', audioState: this.#context?.state ?? 'not-created' };
    this.emit();
  }

  async run(epoch) {
    const signal = this.#session.signal;
    while (!signal.aborted && epoch === this.#epoch) {
      try {
        if (this.#context?.state !== 'running') throw new Error('Audio context stopped');
        const response = await this.request('/api/player/claim', { playerId: this.#playerId }, signal);
        if (signal.aborted || epoch !== this.#epoch) break;
        if (response.job) await this.play(response.job, response.leaseMs, epoch);
        else await delay(1000, signal);
      } catch (error) {
        if (signal.aborted || epoch !== this.#epoch) break;
        this.state.phase = 'waiting'; this.state.error = `Player: ${error.message}`; this.emit();
        await delay(2000, signal);
      }
    }
  }

  renewLease(active, durationMs) {
    clearTimeout(active.watchdog);
    if (active.cancelled || active.finishing || this.#active !== active) return;
    // Stop conservatively before the confirmed lease deadline. An HTTP request
    // hanging beyond that deadline must not let local speech continue.
    active.watchdog = setTimeout(() => {
      if (active.finishing || active.cancelled || this.#active !== active) return;
      this.stopActive('Playback lease deadline reached');
      this.state.error = active.reason; this.emit();
    }, Math.max(0, durationMs - 50));
  }

  async heartbeat(active, leaseMs) {
    if (active.cancelled || active.finishing || this.#active !== active) return;
    try {
      if (this.#context?.state !== 'running') throw new Error('Audio context is not running');
      const sentAt = performance.now();
      const result = await this.event(active, 'heartbeat');
      if (active.cancelled || active.finishing || this.#active !== active) return;
      const confirmedMs = Number.isFinite(result.leaseMs) ? result.leaseMs : leaseMs;
      this.renewLease(active, confirmedMs - (performance.now() - sentAt));
      active.heartbeat = setTimeout(() => this.heartbeat(active, leaseMs), Math.max(100, Math.floor(Math.min(leaseMs, confirmedMs) / 3)));
    } catch {
      if (active.finishing) return;
      // Do not continue speaking on a lost lease, even after a transient outage.
      this.stopActive('Playback lease lost, cancelled or expired');
      this.state.error = active.reason; this.emit();
    }
  }

  async play(job, leaseMs, epoch) {
    const audioPath = safeAudioPath(job);
    if (!Number.isFinite(leaseMs) || leaseMs < 750) throw new Error('Invalid playback lease duration');
    const active = { job, controller: new AbortController(), source: null, startedAt: 0,
      heartbeat: null, watchdog: null, cancelled: false, finish: null, reason: '' };
    this.#active = active;
    this.renewLease(active, leaseMs);
    const abort = () => this.stopActive('Player session ended');
    const sessionSignal = this.#session.signal;
    sessionSignal.addEventListener('abort', abort, { once: true });
    this.state = { ...this.state, phase: 'decoding', currentJob: job.id, text: String(job.text ?? '').slice(0, 20000),
      duration: 0, elapsed: 0, amplitude: 0, mouthCue: 'X', mouthWeights: null,
      presentation: job.presentation ? { ...job.presentation } : null,
      lipSync: 'none', emotion: job.emotion ?? { name: 'neutral', intensity: .35 },
      emotionExplicit: job.emotionExplicit !== false, error: '' };
    this.emit();
    // Heartbeats cover download and decode as well as audible playout.
    active.heartbeat = setTimeout(() => this.heartbeat(active, leaseMs), Math.max(250, Math.floor(leaseMs / 3)));
    try {
      const bytes = await boundedFetch(audioPath, { signal: active.controller.signal,
        headers: { Authorization: `Bearer ${this.#token}`, Accept: 'audio/wav' } },
      { timeoutMs: 20_000, maxBytes: 64 * 1024 * 1024 });
      const buffer = await this.#context.decodeAudioData(bytes.buffer);
      if (active.cancelled || epoch !== this.#epoch) return;
      if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > 600) throw new Error('Invalid audio duration');
      active.mouthCues = job.lipSync?.kind === 'rhubarb' ? normalizeMouthCues(job.lipSync.mouthCues, buffer.duration) : null;
      this.state.lipSync = active.mouthCues ? `rhubarb:${job.lipSync.recognizer || 'phonetic'}` : 'amplitude';
      const sentAt = performance.now();
      const started = await this.event(active, 'started');
      if (active.cancelled || epoch !== this.#epoch) return;
      this.renewLease(active, (Number.isFinite(started.leaseMs) ? started.leaseMs : leaseMs) - (performance.now() - sentAt));
      const source = this.#context.createBufferSource();
      active.source = source;
      source.buffer = buffer;
      source.connect(this.#analyser);
      active.startedAt = this.#context.currentTime + 0.04;
      this.state.phase = 'playing'; this.state.duration = buffer.duration; this.state.error = ''; this.emit();
      await new Promise((resolve) => {
        active.finish = resolve;
        source.onended = resolve;
        source.start(active.startedAt);
      });
      active.finishing = true;
      clearTimeout(active.heartbeat);
      clearTimeout(active.watchdog);
      if (!active.cancelled && epoch === this.#epoch) await this.event(active, 'finished');
    } catch (error) {
      if (!active.cancelled) {
        this.state.error = `Narration stopped (${error.message})`;
        this.stopActive(this.state.error);
      }
      if (epoch === this.#epoch && this.#token) {
        try { await this.event(active, 'failed', active.reason || 'Audio playback failed', new AbortController().signal); } catch { /* Gateway owns terminal state. */ }
      }
    } finally {
      clearTimeout(active.heartbeat);
      clearTimeout(active.watchdog);
      sessionSignal.removeEventListener('abort', abort);
      if (active.source) {
        active.source.onended = null;
        try { active.source.stop(); } catch { /* Natural completion. */ }
        active.source.disconnect();
      }
      if (this.#active === active) this.#active = null;
      if (epoch === this.#epoch) {
        this.state = { ...this.state, phase: 'idle', currentJob: null, text: '', elapsed: 0, duration: 0, amplitude: 0, mouthCue: 'X', mouthWeights: null, presentation: null, lipSync: 'none', emotion: { name: 'neutral', intensity: .35 } };
        this.emit();
      }
    }
  }

  sample() {
    if (this.state.phase === 'playing' && this.#active && !this.#active.cancelled && this.#context && this.#analyser) {
      this.#analyser.getFloatTimeDomainData(this.#samples);
      let energy = 0;
      for (const value of this.#samples) energy += value * value;
      this.state.amplitude = Math.min(1, Math.sqrt(energy / this.#samples.length) * 8);
      this.state.elapsed = Math.max(0, Math.min(this.state.duration, this.#context.currentTime - this.#active.startedAt));
      this.state.mouthCue = this.#active.cancelled ? 'X' : this.#active.mouthCues ?
        mouthCueAt(this.#active.mouthCues, this.#context.currentTime - this.#active.startedAt, this.state.duration) : null;
      this.state.mouthWeights = this.#active.mouthCues ? mouthPoseWeightsAt(this.#active.mouthCues,
        this.#context.currentTime - this.#active.startedAt, this.state.duration) : null;
    } else { this.state.amplitude = 0; this.state.mouthCue = 'X'; this.state.mouthWeights = null; }
    this.state.audioState = this.#context?.state ?? 'not-created';
    return { ...this.state };
  }
}
