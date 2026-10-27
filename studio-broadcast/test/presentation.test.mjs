import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NarrationQueue, normalizePresentation } from '../src/queue.mjs';

const config = { maxTextChars: 2000, maxPending: 10, maxAgeMs: 60000, leaseMs: 10000, retentionMs: 60000 };

test('presentation accepts only supported monitor/home actions and rejects malformed or extra fields', () => {
  assert.equal(normalizePresentation(undefined), null);
  assert.deepEqual(normalizePresentation({ action: 'home' }), { action: 'home' });
  for (const monitor of ['left', 'center', 'right']) assert.deepEqual(normalizePresentation({ monitor, action: 'monitor' }), { action: 'monitor', monitor });
  for (const value of [null, [], 'home', {}, { action: 'monitor' }, { action: 'monitor', monitor: 'unknown' },
    { action: 'walk', monitor: 'left' }, { action: 'home', monitor: 'left' }, { action: 'monitor', monitor: 'left', position: [0, 0, 0] },
    { action: 'home', arbitrary: true }, Object.assign(Object.create({ action: 'home' }), { arbitrary: true })]) {
    assert.throws(() => normalizePresentation(value), { code: 'INVALID_PRESENTATION' });
  }
});

test('presentation survives database restart, participates in idempotency and reaches the existing lease', async t => {
  const root = await mkdtemp(join(tmpdir(), 'air3-presentation-')), filename = join(root, 'queue.sqlite'); let queue;
  t.after(async () => { queue?.close(); await rm(root, { recursive: true, force: true }); });
  queue = new NarrationQueue(filename, config);
  const input = { id: 'monitor.note', text: 'Look at this chart.', presentation: { action: 'monitor', monitor: 'right' } };
  assert.equal(queue.enqueue(input).duplicate, false);
  assert.equal(queue.enqueue({ ...input, presentation: { monitor: 'right', action: 'monitor' } }).duplicate, true);
  assert.throws(() => queue.enqueue({ ...input, presentation: { action: 'monitor', monitor: 'left' } }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => queue.enqueue({ id: input.id, text: input.text }), { code: 'IDEMPOTENCY_CONFLICT' });
  queue.takeForGeneration(); queue.markReady(input.id, 'audio.wav', 1000);
  queue.close(); queue = new NarrationQueue(filename, config);
  const { job } = queue.claim('renderer');
  assert.deepEqual(job.presentation, input.presentation);
  assert.equal(queue.claim('another-renderer').job, null, 'Presentation does not alter exclusive playout ownership');
  queue.playerEvent(job.id, { playerId: 'renderer', leaseToken: job.leaseToken, event: 'started' });
  queue.playerEvent(job.id, { playerId: 'renderer', leaseToken: job.leaseToken, event: 'finished' });
  assert.equal(queue.get(job.id).status, 'finished');
});

test('additive migration preserves hashes and retries from a pre-presentation database', async t => {
  const root = await mkdtemp(join(tmpdir(), 'air3-presentation-old-')), filename = join(root, 'queue.sqlite'); let queue;
  t.after(async () => { queue?.close(); await rm(root, { recursive: true, force: true }); });
  const now = Date.now(), text = 'An existing narration with no stage cue.';
  const legacyHash = createHash('sha256').update(JSON.stringify({ text, language: 'en', priority: 0, expiresAt: null })).digest('hex');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`CREATE TABLE narrations (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, content_hash TEXT NOT NULL,
    text TEXT NOT NULL, language TEXT NOT NULL, priority INTEGER NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    status TEXT NOT NULL, audio_file TEXT, duration_ms REAL, error TEXT,
    lease_owner TEXT, lease_token TEXT, lease_expires_at INTEGER,
    lip_sync_json TEXT, emotion_json TEXT
  )`);
  legacy.prepare(`INSERT INTO narrations (id, content_hash, text, language, priority, created_at, expires_at, updated_at, status)
    VALUES (?, ?, ?, 'en', 0, ?, ?, ?, 'queued')`).run('old.note', legacyHash, text, now, now + 60000, now);
  legacy.close();
  queue = new NarrationQueue(filename, config, () => now);
  assert.equal(queue.enqueue({ id: 'old.note', text }).duplicate, true);
  assert.equal(queue.row('old.note').content_hash, legacyHash);
  assert.equal(queue.row('old.note').presentation_json, null);
  queue.takeForGeneration(); queue.markReady('old.note', 'audio.wav', 1000);
  const { job } = queue.claim('renderer');
  assert.equal(job.presentation, null);
  assert.equal(job.emotionExplicit, false, 'An existing NULL emotion remains unspecified after migration');
  assert.deepEqual(job.emotion, { name: 'neutral', intensity: .35 }, 'The additive flag preserves the legacy emotion payload');
});
