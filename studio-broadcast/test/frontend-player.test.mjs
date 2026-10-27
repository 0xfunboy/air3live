import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechPlayer } from '../public/speech-player.mjs';

const until = async (fn, timeout = 2500) => {
  const start = Date.now();
  while (!fn()) { if (Date.now() - start > timeout) throw new Error('Condition timed out'); await new Promise((r) => setTimeout(r, 10)); }
};

function mockAudio(duration = .04) {
  const stats = { sources: 0, active: 0, maxActive: 0, stopped: 0, contexts: 0, oscillators: 0 };
  class Node {
    connect() {} disconnect() {}
    stop() {}
  }
  class AudioContext {
    constructor() { stats.contexts++; this.state = 'suspended'; this.destination = {}; this.epoch = Date.now(); }
    get currentTime() { return (Date.now() - this.epoch) / 1000; }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
    createGain() { return Object.assign(new Node(), { gain: { value: 1 } }); }
    createOscillator() { stats.oscillators++; return Object.assign(new Node(), { start() {} }); }
    createAnalyser() { return Object.assign(new Node(), { fftSize: 512, getFloatTimeDomainData(array) { array.fill(.05); } }); }
    async decodeAudioData() { return { duration }; }
    createBufferSource() {
      stats.sources++;
      const n = new Node(); let timer, done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); stats.active--; n.onended?.(); };
      n.start = () => { stats.active++; stats.maxActive = Math.max(stats.maxActive, stats.active); timer = setTimeout(finish, duration * 1000 + 40); };
      n.stop = () => { if (!done) stats.stopped++; finish(); };
      return n;
    }
  }
  return { stats, AudioContext };
}

function installMock(t, { jobs = 1, duration = .04, heartbeatFails = false, heartbeatHangs = false, presentation = null,
  lipSync = { kind: 'amplitude' } } = {}) {
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
  const { stats, AudioContext } = mockAudio(duration); globalThis.window = { AudioContext };
  const events = [], requests = []; let claimed = 0;
  globalThis.fetch = async (path, options) => {
    requests.push(path);
    if (path === '/api/player/claim') {
      claimed++;
      return Response.json({ job: claimed <= jobs ? { id: `test.${claimed}`, text: 'Test narration', audioPath: `/api/audio/test.${claimed}`,
        leaseToken: 'fake-lease-secret', lipSync, presentation } : null, leaseMs: 900 });
    }
    if (path.startsWith('/api/audio/')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/wav' } });
    const event = JSON.parse(options.body); events.push(event);
    if (event.event === 'heartbeat' && heartbeatFails) return new Response('{}', { status: 409 });
    if (event.event === 'heartbeat' && heartbeatHangs) return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('Request aborted')), { once: true });
    });
    return Response.json({ status: 'ok' });
  };
  t.after(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow; });
  return { stats, events, requests };
}

test('manual observer neither creates audio nor claims narration', async (t) => {
  const { stats, requests } = installMock(t);
  const player = new SpeechPlayer();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(requests.length, 0); assert.equal(stats.contexts, 0);
  assert.equal(player.diagnostics().phase, 'observer');
  await player.disconnect();
});

test('armAudio prepares a silent graph reused for serialized playout; secrets stay private', async (t) => {
  const { stats, events, requests } = installMock(t, { jobs: 2 });
  const player = new SpeechPlayer(); t.after(() => player.disconnect());
  await player.armAudio();
  assert.equal(requests.length, 0); assert.equal(stats.oscillators, 1);
  await player.connect({ token: 'test-player-token-123456789', playerId: 'broadcaster.test' });
  await until(() => events.filter((e) => e.event === 'finished').length === 2);
  assert.equal(stats.contexts, 1); assert.equal(stats.maxActive, 1); assert.equal(stats.sources, 2);
  const diagnostic = JSON.stringify(player.diagnostics());
  assert.ok(!diagnostic.includes('test-player-token')); assert.ok(!diagnostic.includes('fake-lease-secret'));
  assert.deepEqual(events.filter((e) => e.event === 'started' || e.event === 'finished').map((e) => e.event), ['started', 'finished', 'started', 'finished']);
});

test('failed lease heartbeat immediately stops audio and never finishes the utterance', async (t) => {
  const { stats, events } = installMock(t, { duration: 3, heartbeatFails: true });
  const player = new SpeechPlayer(); t.after(() => player.disconnect());
  await player.connect({ token: 'test-player-token-123456789', playerId: 'broadcaster.test' });
  await until(() => events.some((e) => e.event === 'heartbeat'));
  await until(() => stats.stopped > 0);
  assert.equal(stats.active, 0); assert.equal(events.filter((e) => e.event === 'finished').length, 0);
  assert.equal(stats.sources, 1);
});

test('disconnect stops the current source and terminalizes it without replay', async (t) => {
  const { stats, events } = installMock(t, { duration: 3 });
  const player = new SpeechPlayer();
  await player.connect({ token: 'test-player-token-123456789', playerId: 'broadcaster.test' });
  await until(() => player.diagnostics().phase === 'playing');
  await player.disconnect();
  assert.equal(stats.active, 0); assert.equal(stats.sources, 1);
  assert.ok(events.some((e) => e.event === 'failed'));
  assert.equal(player.diagnostics().phase, 'observer'); assert.equal(player.diagnostics().audioArmed, false);
});

test('a hanging heartbeat cannot extend local speech past the last confirmed lease', async (t) => {
  const { stats, events } = installMock(t, { duration: 3, heartbeatHangs: true });
  const player = new SpeechPlayer(); t.after(() => player.disconnect());
  await player.connect({ token: 'test-player-token-123456789', playerId: 'broadcaster.test' });
  await until(() => player.diagnostics().phase === 'playing');
  const began = Date.now();
  await until(() => stats.stopped > 0, 1500);
  assert.ok(Date.now() - began < 1100, 'local watchdog stopped speech within the 900ms lease');
  assert.equal(stats.active, 0); assert.equal(events.filter((e) => e.event === 'finished').length, 0);
});

test('leased presentation and coarticulation accompany speech, then clear on cancellation', async (t) => {
  const presentation = { action: 'monitor', monitor: 'left' };
  const { stats } = installMock(t, { duration: 3, presentation,
    lipSync: { kind: 'rhubarb', recognizer: 'phonetic', mouthCues: [{ start: 0, end: 3, value: 'D' }] } });
  const player = new SpeechPlayer(); t.after(() => player.disconnect());
  await player.connect({ token: 'test-player-token-123456789', playerId: 'broadcaster.test' });
  await until(() => player.sample().phase === 'playing' && player.sample().elapsed > .1);
  const sample = player.sample();
  assert.deepEqual(sample.presentation, presentation);
  assert.equal(sample.mouthCue, 'D'); assert.equal(sample.mouthWeights.D, 1);
  player.stopActive('Explicit test cancellation');
  assert.equal(player.sample().presentation, null); assert.equal(player.sample().mouthWeights, null);
  assert.equal(stats.active, 0);
  await player.disconnect(); assert.equal(player.sample().presentation, null);
});

test('finished narration clears presentation metadata before the next job', async (t) => {
  const { events } = installMock(t, { duration: .08, presentation: { action: 'home' } });
  const player = new SpeechPlayer(); t.after(() => player.disconnect());
  await player.connect({ token: 'test-player-token-123456789', playerId: 'broadcaster.test' });
  await until(() => player.sample().phase === 'playing');
  assert.deepEqual(player.sample().presentation, { action: 'home' });
  await until(() => events.some(event => event.event === 'finished') && player.sample().phase === 'idle');
  assert.equal(player.sample().presentation, null);
});
