import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NarrationQueue } from '../src/queue.mjs';
import { ProducerCoordinator, speechSegments } from '../src/producer-coordinator.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'air3-editorial-'));
  let now = 1800000000000;
  const config = { maxTextChars: 8000, maxPending: 20, maxAgeMs: 300000, leaseMs: 15000, retentionMs: 3600000 };
  let q = new NarrationQueue(join(dir, 'test.sqlite'), config, () => now);
  let c = new ProducerCoordinator(q, { producerId: 'fixture', channelId: '123' }, () => now);
  t.after(async () => { q.close(); await rm(dir, { recursive: true, force: true }); });
  return { get q() { return q; }, get c() { return c; }, get now() { return now; }, advance(ms) { now += ms; },
    restart() { q.close(); q = new NarrationQueue(join(dir, 'test.sqlite'), config, () => now); c = new ProducerCoordinator(q, { producerId: 'fixture', channelId: '123' }, () => now); },
    turn(id, sequence = 1) {
      const base = { source: { platform: 'twitch', channelId: '123', messageId: id, userId: `u_${id}`, receivedAt: now }, expiresAt: now + 90000 };
      c.putTurn(id, { ...base, revision: 1, phase: 'queued' });
      const preparing = { ...base, revision: 2, phase: 'preparing', prepareStartedAt: now, prepareDeadlineAt: now + 20000, dispatchSequence: sequence };
      c.putTurn(id, preparing); return preparing;
    },
    intent(id, kind = 'filler', turn) {
      return { schema: 'air3.editorial-intent.v1', id, kind,
        ...(turn ? { turnId: turn.source.messageId } : {}),
        source: turn?.source ?? { platform: 'market', channelId: '123' }, language: 'en',
        speechText: 'Bitcoin rose by 2.5 percent. This is not a prediction of future returns.',
        createdAt: now, expiresAt: turn?.expiresAt ?? now + 180000,
        presentation: { intent: 'address_audience' }, editorial: { title: 'Verified fixture', topic: 'market', sourceRefs: [] } };
    },
    ready(id) { c.pump(); const row = q.db.prepare("SELECT * FROM narrations WHERE status='queued' LIMIT 1").get(); assert.ok(row, id); const job = q.takeForGeneration(v => c.allowed(v)); assert.ok(job); q.markReady(job.id, '0'.repeat(64) + '.wav', 1000); return job; },
    claim() { return q.claim('player', id => c.allowed(id)).job; },
    event(job, event) { return q.playerEvent(job.id, { event, playerId: 'player', leaseToken: job.leaseToken }, { editorial: true }); } };
}

test('segmentation preserves decimals, negations, currency and original facts', () => {
  const text = 'BTC is not up 2.5 percent. The value is 123.45 USDC. No profit has been realized.';
  assert.equal(speechSegments(text).join(' '), text);
  assert.throws(() => speechSegments('x'.repeat(601)), /SENTENCE_TOO_LONG/);
  const chat=speechSegments(text,'en','chat');assert.equal(chat[0],'BTC is not up 2.5 percent.');assert.equal(chat.join(' '),text);
});
test('chat prefetch is limited to one segment ahead, and cancellation retires that child',async t=>{
  const f=await fixture(t);const turn=f.turn('q');const input=f.intent('answer','chat',turn);
  input.speechText='A short first sentence. Another complete sentence. Final information stays intact.';
  f.c.putIntent('answer',input);f.ready('answer');const current=f.claim();f.event(current,'started');
  f.c.pump();f.c.pump();
  assert.equal(f.q.counts().queued,1);
  const links=f.q.db.prepare('SELECT job FROM editorial_segments ORDER BY idx').all();assert.equal(links.length,2);
  f.c.cancelIntent('answer');assert.equal(f.q.row(links[1].job).status,'cancelled');
  assert.equal(f.c.control(current.id).yield,true);
});
test('parent remains active during the gap between response segments and clears only at completion',async t=>{
 const f=await fixture(t),turn=f.turn('continuity');const input=f.intent('answer','chat',turn);input.speechText='First complete sentence. Final complete sentence.';
 f.c.putIntent('answer',input);f.ready('first');const first=f.claim();f.event(first,'started');
 assert.equal(f.c.state().activeResponse.id,'answer');f.event(first,'finished');f.c.pump();
 assert.equal(f.c.state().activeResponse.id,'answer');assert.equal(f.c.program().title,'');
 f.ready('last');const last=f.claim();f.event(last,'started');f.event(last,'finished');
 assert.equal(f.c.state().activeResponse,null);
});
test('immutable intent retry survives restart and changed payload conflicts', async t => {
  const f = await fixture(t); const input = f.intent('one');
  f.c.putIntent('one', input); f.restart();
  assert.equal(f.c.putIntent('one', input).duplicate, true);
  assert.throws(() => f.c.putIntent('one', { ...input, speechText: 'Different.' }), /IDEMPOTENCY_CONFLICT/);
});
test('cancel before turn and intent creation persists a tombstone', async t => {
  const f = await fixture(t); f.c.cancelTurn('turn'); f.c.cancelIntent('late'); f.restart();
  assert.throws(() => f.turn('turn'), /TURN_CANCELLED/);
  assert.throws(() => f.c.putIntent('late', f.intent('late')), /INTENT_CANCELLED/);
});
test('reservation precedes text, blocks lower news and releases on fixed preparation deadline', async t => {
  const f = await fixture(t); f.c.putIntent('low', f.intent('low','news')); f.ready('low');
  f.turn('question');
  assert.equal(f.claim(), null); assert.equal(f.c.state().pendingChat, 1);
  f.advance(20001); f.c.reconcile();
  assert.equal(f.c.state().pendingChat, 0); assert.ok(f.claim());
});
test('chat utterance requires the reserved preparing turn and same immutable source', async t => {
  const f = await fixture(t); const turn = f.turn('question'); const input = f.intent('answer', 'chat', turn);
  assert.throws(() => f.c.putIntent('answer', { ...input, source: { ...input.source, userId: 'other' } }), /TURN_EXPIRED/);
  assert.equal(f.c.putIntent('answer', input).status, 'ready');
  assert.equal(f.c.putTurn('question', turn).status, 'ready');
  assert.equal(f.c.putIntent('answer', input).duplicate, true);
});
test('second chat never interrupts first and selected sequence prevents TTS overtaking', async t => {
  const f = await fixture(t); const a = f.turn('a', 1); const b = f.turn('b', 2);
  f.c.putIntent('b-answer', f.intent('b-answer', 'chat', b)); f.c.pump();
  assert.equal(f.q.counts().queued ?? 0, 0);
  f.c.putIntent('a-answer', f.intent('a-answer', 'chat', a)); f.ready('a');
  const job = f.claim(); assert.ok(job); f.event(job, 'started');
  assert.equal(f.c.control(job.id).yield, false);
  f.event(job, 'finished'); f.c.pump();
  assert.equal(f.c.selected().id,'a-answer');
  f.ready('a-second');const second=f.claim();f.event(second,'started');f.event(second,'finished');f.c.pump();
  assert.equal(f.c.view(f.c.intent('a-answer')).status, 'completed');
  assert.equal(f.c.selected().id, 'b-answer');
});
test('playing filler yields but retains authority until stop acknowledgement', async t => {
  const f = await fixture(t); f.c.putIntent('low', f.intent('low')); f.ready('low');
  const job = f.claim(); f.event(job, 'started'); f.turn('question');
  assert.equal(f.c.control(job.id).yield, true); assert.equal(f.claim(), null);
  f.event(job, 'interrupted'); f.c.reconcile();
  assert.equal(f.c.intent('low').status, 'superseded');
});
test('fresh news supersedes a disposable filler but cannot outrank a chat reservation',async t=>{
  const f=await fixture(t);f.c.putIntent('low',f.intent('low'));f.ready('low');
  f.c.putIntent('news',f.intent('news','news'));f.c.reconcile();assert.equal(f.c.intent('low').status,'superseded');assert.equal(f.c.selected().id,'news');
  f.turn('q');assert.equal(f.c.selected(),null);assert.throws(()=>f.c.putIntent('other',f.intent('other','news')),/CHAT_PRIORITY/);
});
test('partial news and crash during playback are uncertain, never automatically replayed', async t => {
  const f = await fixture(t); f.c.putIntent('news', f.intent('news', 'news')); f.ready('news');
  const job = f.claim(); f.event(job, 'started'); f.restart();
  assert.equal(f.c.intent('news').status, 'playback_uncertain');
  f.c.pump(); assert.equal(f.claim(), null);
});
test('cancel playing parent does not release its lease before the player stops', async t => {
  const f = await fixture(t); f.c.putIntent('one', f.intent('one')); f.ready('one');
  const job = f.claim(); f.event(job, 'started');
  assert.equal(f.c.cancelIntent('one').status, 'cancelling'); assert.equal(f.claim(), null);
  assert.equal(f.c.control(job.id).yield, true);
  f.event(job, 'interrupted'); f.c.reconcile(); assert.equal(f.c.intent('one').status, 'cancelled');
});
test('turn admission is bounded, identities scoped and priorities cannot be supplied by the LLM', async t => {
  const f = await fixture(t); const input = f.intent('one');
  assert.throws(() => f.c.putIntent('one', { ...input, priority: 100 }), /INVALID_EDITORIAL_FIELDS/);
  assert.throws(() => f.c.putIntent('one', { ...input, source: { ...input.source, channelId: '456' } }), /EDITORIAL_SOURCE_FORBIDDEN/);
  assert.throws(() => f.c.putIntent('one', { ...input, presentation: { intent: 'explain_monitor', monitor: 'center' } }), /PRESENTATION_NOT_QUALIFIED/);
  for (let i = 1; i <= 10; i++) f.turn(`turn${i}`, i);
  assert.throws(() => f.turn('overflow', 11), /CHAT_FULL/);
});
test('news catalog revisions never renew expiry on retry or revive stale news', async t => {
  const f = await fixture(t);
  const item = { revision: 1, title: 'Verified news', source: { platform: 'rss', channelId: '123', url: 'https://example.org/story' },
    publishedAt: f.now - 1000, expiresAt: f.now + 2000 };
  f.c.putNews('story', item); f.advance(1000); assert.equal(f.c.putNews('story', item).duplicate, true);
  assert.throws(() => f.c.putNews('story', { ...item, title: 'Changed' }), /NEWS_REVISION_CONFLICT/);
  f.advance(1001); assert.deepEqual(f.c.program().ticker, []);
});
