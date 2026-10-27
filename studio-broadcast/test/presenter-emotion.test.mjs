import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NarrationQueue } from '../src/queue.mjs';
import { resolvePresenterEmotion } from '../public/presenter-emotion.mjs';

const happy = Object.freeze({ name: 'happy', intensity: 1 });

test('plain agent text keeps the current operator expression during narration', () => {
  const state = Object.freeze({ phase: 'playing', emotion: Object.freeze({ name: 'neutral', intensity: .35 }), emotionExplicit: false });
  assert.equal(resolvePresenterEmotion(state, happy), happy);
  const chosen = Object.freeze({ name: 'focused', intensity: .6 });
  assert.equal(resolvePresenterEmotion(state, chosen), chosen, 'A later operator choice must also survive an implicit neutral placeholder');
  assert.deepEqual(state.emotion, { name: 'neutral', intensity: .35 }, 'The compatibility payload is not rewritten');
});

test('explicit neutral and warm narration emotions override the operator while playing', () => {
  for (const emotion of [Object.freeze({ name: 'neutral', intensity: 0 }), Object.freeze({ name: 'warm', intensity: .4 })]) {
    const state = Object.freeze({ phase: 'playing', emotion, emotionExplicit: true });
    assert.equal(resolvePresenterEmotion(state, happy), emotion);
  }
});

test('idle, paused, finished and cancelled playback restore the current operator choice', () => {
  const explicit = Object.freeze({ name: 'warm', intensity: .4 });
  for (const phase of ['observer', 'idle', 'loading', 'paused', 'finished', 'cancelled', 'error', 'disconnected']) {
    const state = Object.freeze({ phase, emotion: explicit, emotionExplicit: true });
    assert.equal(resolvePresenterEmotion(state, happy), happy, phase);
  }
});

test('legacy claims without emotionExplicit retain their prior emotion behaviour', () => {
  const emotion = Object.freeze({ name: 'neutral', intensity: .35 });
  assert.equal(resolvePresenterEmotion(Object.freeze({ phase: 'playing', emotion }), happy), emotion);
  assert.equal(resolvePresenterEmotion(Object.freeze({ phase: 'idle', emotion }), happy), happy);
});

test('absent playback or absent emotion falls back without inventing an emotion', () => {
  for (const state of [undefined, null, {}, { phase: 'playing' }, { phase: 'playing', emotion: null, emotionExplicit: true }]) {
    assert.equal(resolvePresenterEmotion(state, happy), happy);
  }
});

test('real queue leases distinguish omitted emotion from explicit neutral and warm without changing legacy payloads', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'air3-presenter-emotion-'));
  const queue = new NarrationQueue(join(folder, 'queue.sqlite'), { maxTextChars: 2000, maxPending: 10, maxAgeMs: 60000, leaseMs: 10000, retentionMs: 60000 });
  t.after(async () => { queue.close(); await rm(folder, { recursive: true, force: true }); });
  for (const [id, emotion] of [['plain', undefined], ['neutral', { name: 'neutral', intensity: 0 }], ['warm', { name: 'warm', intensity: .4 }]]) {
    const input = { id, text: 'A short market update.', ...(emotion ? { emotion } : {}) };
    queue.enqueue(input); queue.takeForGeneration(); queue.markReady(id, 'audio.wav', 1000);
    const { job } = queue.claim('renderer');
    assert.equal(job.emotionExplicit, emotion !== undefined);
    assert.deepEqual(job.emotion, emotion ?? { name: 'neutral', intensity: .35 });
    assert.deepEqual(resolvePresenterEmotion({ phase: 'playing', ...job }, happy), emotion ?? happy);
    queue.playerEvent(id, { playerId: 'renderer', leaseToken: job.leaseToken, event: 'started' });
    queue.playerEvent(id, { playerId: 'renderer', leaseToken: job.leaseToken, event: 'finished' });
  }
});
