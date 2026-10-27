import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMouthCues, mouthCueAt } from '../public/lip-sync.mjs';
import { generateLipSync, bundledRhubarb } from '../src/lip-sync.mjs';
import { NarrationQueue } from '../src/queue.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('audio clock chooses a cue at exact boundaries and closes during silence and after end', () => {
  const cues = normalizeMouthCues([{ start: 0, end: .2, value: 'A' }, { start: .2, end: .4, value: 'D' }, { start: .5, end: 1, value: 'F' }], 1);
  assert.equal(mouthCueAt(cues, -.01, 1), 'X'); assert.equal(mouthCueAt(cues, 0, 1), 'A');
  assert.equal(mouthCueAt(cues, .2, 1), 'D'); assert.equal(mouthCueAt(cues, .45, 1), 'X');
  assert.equal(mouthCueAt(cues, .999, 1), 'F'); assert.equal(mouthCueAt(cues, 1, 1), 'X');
});
test('malformed, overlapping and unbounded timelines are rejected', () => {
  for (const cues of [[{ start: 0, end: 2, value: 'A' }], [{ start: 0, end: 1, value: 'INVALID' }],
    [{ start: NaN, end: 1, value: 'A' }], [{ start: -.1, end: 1, value: 'A' }],
    [{ start: 0, end: .7, value: 'A' }, { start: .6, end: 1, value: 'B' }]]) assert.throws(() => normalizeMouthCues(cues, 1));
  assert.throws(() => normalizeMouthCues(new Array(6001), 1));
});
test('missing aligner has an explicit fallback; required mode fails and cancellation is respected', async () => {
  const input = { audioPath: 'unused.wav', durationMs: 1000, language: 'it' };
  assert.deepEqual(await generateLipSync({ mode: 'off' }, input), { kind: 'amplitude', reason: 'disabled' });
  const fallback = await generateLipSync({ mode: 'auto', binary: join(tmpdir(), 'air3-nonexistent-aligner') }, input);
  assert.deepEqual(fallback, { kind: 'amplitude', reason: 'alignment-unavailable' });
  await assert.rejects(generateLipSync({ mode: 'required', binary: join(tmpdir(), 'air3-nonexistent-aligner') }, input), { code: 'TTS_LIPSYNC_UNAVAILABLE' });
  await assert.rejects(generateLipSync({ mode: 'auto' }, input, { signal: AbortSignal.abort() }), { code: 'TTS_CANCELLED' });
  assert.equal(bundledRhubarb('linux', 'arm64'), null);
});
test('aligned cues persist across a gateway restart and travel with the audio lease', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'air3-lipsync-queue-')); let queue;
  t.after(async () => { queue?.close(); await rm(root, { recursive: true, force: true }); });
  const file = join(root, 'queue.sqlite'), config = { maxTextChars: 2000, maxPending: 10, maxAgeMs: 60000, leaseMs: 10000, retentionMs: 60000 };
  queue = new NarrationQueue(file, config); queue.enqueue({ id: 'aligned.test', text: 'Hello.', emotion: { name: 'warm', intensity: .4 } }); queue.takeForGeneration();
  const timeline = { kind: 'rhubarb', recognizer: 'phonetic', mouthCues: [{ start: 0, end: 1, value: 'D' }] };
  queue.markReady('aligned.test', 'audio.wav', 1000, timeline); queue.close(); queue = new NarrationQueue(file, config);
  const claimed = queue.claim('renderer').job;
  assert.deepEqual(claimed.lipSync, timeline); assert.deepEqual(claimed.emotion, { name: 'warm', intensity: .4 });
  assert.equal(claimed.emotionExplicit, true, 'The explicit emotion remains explicit after a database restart');
  assert.throws(() => queue.enqueue({ text: 'No', emotion: { name: 'warm', intensity: 4 } }), { code: 'INVALID_EMOTION' });
  assert.throws(() => queue.enqueue({ text: 'No', emotion: 'not-an-emotion' }), { code: 'INVALID_EMOTION' });
});
