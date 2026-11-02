import { createHash } from 'node:crypto';
import { isSafeId, QueueError } from './queue.mjs';
import{decodeEditorialChart,storeEditorialChart,pruneEditorialCharts}from'./editorial-chart.mjs';
import{newsTicker}from'./news-ticker.mjs';

const terminal = new Set(['completed', 'cancelled', 'expired', 'failed', 'superseded', 'playback_uncertain']);
const rank = { chat: 30, news: 20, filler: 10 };
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const hash = value => createHash('sha256').update(stable(value)).digest('hex');
const fail = (code, status = 400) => { throw new QueueError(code, status); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some(k => !allowed.includes(k))) fail('INVALID_EDITORIAL_FIELDS');
}
function line(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value) || (required && !value.trim())) fail('INVALID_EDITORIAL_TEXT');
  return value;
}

// Sentence boundaries do not split decimals. Long sentences stay intact rather
// than turning a negation, ticker or financial figure into an incomplete claim.
export function speechSegments(text, language = 'en', kind = 'filler') {
  const sentences = [...new Intl.Segmenter(language, { granularity: 'sentence' }).segment(text)]
    .map(v => v.segment.trim()).filter(Boolean);
  const result = [];
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > 600 || sentence.split(/\s+/u).length > 45) fail('SENTENCE_TOO_LONG');
    // First complete chat sentence starts promptly. Do not cut words or discard
    // the remaining answer; prefetch one following segment during playback.
    if(kind==='chat'&&!result.length&&!current){result.push(sentence);continue;}
    if (current && `${current} ${sentence}`.split(/\s+/u).length > 30) { result.push(current); current = ''; }
    current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) result.push(current);
  if (!result.length || result.length > 32) fail('INVALID_SEGMENTS');
  return result;
}

/** Additive tables in the existing locked SQLite DB. Old binaries ignore them.
 * The bearer-selected owner is supplied by the gateway, never by a request body.
 */
export class ProducerCoordinator {
  constructor(queue, { producerId, channelId, chartDir=null, retentionMs = 86400000, ttsPriority = false, environment = 'production' }, now = Date.now) {
    if (!isSafeId(producerId) || !/^\d{1,24}$/.test(channelId ?? '')) fail('INVALID_EDITORIAL_IDENTITY');
    this.queue = queue; this.db = queue.db; this.owner = producerId; this.channelId = channelId; this.now = now;
    this.retentionMs = Math.max(3600000, retentionMs);
    this.ttsPriority = ttsPriority;
    this.chartDir=chartDir;
    if(!['preview','production'].includes(environment))fail('INVALID_EDITORIAL_ENVIRONMENT');
    this.environment=environment;
    queue.enableEditorialTimeline();
    this.db.exec(`CREATE TABLE IF NOT EXISTS editorial_turns (
      owner TEXT NOT NULL, id TEXT NOT NULL, body TEXT, hash TEXT, phase TEXT NOT NULL,
      revision INTEGER NOT NULL, sequence INTEGER, expires INTEGER NOT NULL, updated INTEGER NOT NULL,
      PRIMARY KEY(owner,id));
      CREATE TABLE IF NOT EXISTS editorial_intents (
      owner TEXT NOT NULL, id TEXT NOT NULL, body TEXT, hash TEXT, kind TEXT NOT NULL,
      status TEXT NOT NULL, wanted TEXT, cursor INTEGER NOT NULL DEFAULT 0,
      expires INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(owner,id));
      CREATE TABLE IF NOT EXISTS editorial_segments (
      job TEXT PRIMARY KEY, owner TEXT NOT NULL, parent TEXT NOT NULL, idx INTEGER NOT NULL,
      UNIQUE(owner,parent,idx));
      CREATE TABLE IF NOT EXISTS editorial_news (
      owner TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL,
      hash TEXT NOT NULL, expires INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(owner,id));
      CREATE INDEX IF NOT EXISTS editorial_expiry ON editorial_intents(owner,expires);
      CREATE INDEX IF NOT EXISTS editorial_turn_expiry ON editorial_turns(owner,expires);`);
    this.reconcile();
  }

  capabilities() {
    return { schema: 'air3.producer.v1', environment:this.environment, producerId: this.owner, channelId: this.channelId,
      playerProtocol:'air3.editorial.player.v1',serverNow:this.now(),
      features: { turnReservation: true, immutableUtterances: true, tombstones: true,
        priority: true, segmentation: true, playbackInterruption: true, newsItems: true,
        monitorSnapshots: false, chartAttachments:!!this.chartDir, responseContinuity:true, ttsPriority: this.ttsPriority, physicalTtsCancellation: this.ttsPriority },
      limits: { maxTextChars: 8000, maxAgeMs: 300000, maxPendingChat: 10,
        maxLowPrefetch: 1, retentionMs: this.retentionMs, yieldPollMs: 500,maxChatPlaybackMs:180000 } };
  }
  source(value) {
    fields(value, ['platform', 'channelId', 'messageId', 'userId', 'receivedAt', 'publishedAt', 'url', 'name', 'metric', 'observedAt']);
    if (value.channelId !== this.channelId || !['twitch', 'rss', 'market'].includes(value.platform)) fail('EDITORIAL_SOURCE_FORBIDDEN', 403);
    if (stable(value).length > 4096) fail('SOURCE_TOO_LARGE');
    if (value.platform === 'twitch' && (!isSafeId(value.messageId) || !isSafeId(value.userId) || !Number.isSafeInteger(value.receivedAt))) fail('INVALID_CHAT_SOURCE');
    if (value.url !== undefined) {
      const u = (() => { try { return new URL(value.url); } catch { fail('INVALID_SOURCE_URL'); } })();
      if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || value.url.length > 2048) fail('INVALID_SOURCE_URL');
    }
  }
  deadline(value, max = 300000) {
    if (!Number.isSafeInteger(value) || value <= this.now() || value > this.now() + max) fail('EDITORIAL_EXPIRED', 410);
  }
  bounded(table, max) {
    if (this.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE owner=?`).get(this.owner).n >= max) fail('EDITORIAL_STORAGE_FULL', 429);
  }
  turn(id) { return this.db.prepare('SELECT * FROM editorial_turns WHERE owner=? AND id=?').get(this.owner, id); }
  intent(id) { return this.db.prepare('SELECT * FROM editorial_intents WHERE owner=? AND id=?').get(this.owner, id); }
  view(row) {
    if(!row)return null;
    const segments=row.cursor===undefined?null:this.db.prepare('SELECT job,idx FROM editorial_segments WHERE owner=? AND parent=? ORDER BY idx').all(this.owner,row.id)
      .map(link=>{const child=this.queue.row(link.job);const lip=child?.lip_sync_json?JSON.parse(child.lip_sync_json):null;return{id:link.job,index:link.idx,status:child?.status??'unknown',audioReadyAt:child?.ready_at??null,playerStartedAt:child?.started_at??null,playerEndedAt:child?.ended_at??null,lipSync:lip?.kind??null,synthesisMs:lip?.synthesisMs??null,alignmentMs:lip?.processingMs??null,error:child?.error??null};});
    return { id: row.id, status: row.status ?? row.phase, expiresAt: row.expires,
      updatedAt: row.updated, ...(segments?{completedSegments:row.cursor,segments}:{}) };
  }

  putTurn(id, input) {
    if (!isSafeId(id)) fail('INVALID_ID');
    fields(input, ['revision', 'phase', 'source', 'expiresAt', 'prepareStartedAt', 'prepareDeadlineAt', 'dispatchSequence']);
    this.source(input.source);
    if (input.source.platform !== 'twitch' || !['queued', 'preparing'].includes(input.phase) ||
      input.revision !== (input.phase === 'queued' ? 1 : 2)) fail('INVALID_TURN');
    return this.queue.transaction(() => {
      this.sweep();
      const old = this.turn(id); const digest = hash(input);
      if (old?.phase === 'cancelled') fail('TURN_CANCELLED', 410);
      if (old?.hash === digest) return { ...this.view(old), duplicate: true };
      if (old && ['ready', 'completed'].includes(old.phase)) {
        const original = JSON.parse(old.body);
        if (stable(original.source) !== stable(input.source) || original.expiresAt !== input.expiresAt) fail('TURN_CONFLICT', 409);
        return { ...this.view(old), duplicate: true };
      }
      if (old && ['expired', 'failed'].includes(old.phase)) fail('TURN_EXPIRED', 410);
      this.deadline(input.expiresAt, 90000);
      if (old && (input.revision <= old.revision || stable(JSON.parse(old.body).source) !== stable(input.source) || old.expires !== input.expiresAt)) fail('TURN_CONFLICT', 409);
      if (!old && input.phase !== 'queued') fail('TURN_NOT_RESERVED', 409);
      if (input.phase === 'preparing') {
        if (!Number.isSafeInteger(input.dispatchSequence) || input.dispatchSequence < 1 ||
          !Number.isSafeInteger(input.prepareStartedAt) || input.prepareStartedAt > this.now() + 1000 ||
          !Number.isSafeInteger(input.prepareDeadlineAt) || input.prepareDeadlineAt <= this.now() ||
          input.prepareDeadlineAt > input.expiresAt || input.prepareDeadlineAt > input.prepareStartedAt + 30000) fail('INVALID_PREPARATION');
        const duplicateSequence = this.db.prepare('SELECT id FROM editorial_turns WHERE owner=? AND sequence=? AND id<>?').get(this.owner, input.dispatchSequence, id);
        if (duplicateSequence) fail('SEQUENCE_CONFLICT', 409);
      }
      if (!old) {
        const active = this.db.prepare("SELECT body FROM editorial_turns WHERE owner=? AND phase IN ('queued','preparing','ready')").all(this.owner);
        if (active.length >= 10 || active.filter(v => JSON.parse(v.body).source.userId === input.source.userId).length >= 2) fail('CHAT_FULL', 429);
        this.bounded('editorial_turns', 10000);
      }
      this.db.prepare(`INSERT INTO editorial_turns(owner,id,body,hash,phase,revision,sequence,expires,updated)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET body=excluded.body,hash=excluded.hash,
        phase=excluded.phase,revision=excluded.revision,sequence=excluded.sequence,updated=excluded.updated`)
        .run(this.owner, id, stable(input), digest, input.phase, input.revision, input.dispatchSequence ?? null, input.expiresAt, this.now());
      // Filler is disposable, including work not yet spoken. NEWS may resume
      // only from a confirmed, not-yet-started segment after the chat.
      this.db.prepare("UPDATE editorial_intents SET status='cancelling',wanted='superseded',updated=? WHERE owner=? AND kind='filler' AND status IN ('ready','suspended')")
        .run(this.now(),this.owner);
      return this.view(this.turn(id));
    });
  }

  cancelTurn(id) {
    if (!isSafeId(id)) fail('INVALID_ID');
    this.queue.transaction(() => {
      if (!this.turn(id)) this.bounded('editorial_turns', 10000);
      this.db.prepare(`INSERT INTO editorial_turns(owner,id,phase,revision,expires,updated) VALUES(?,?,'cancelled',0,?,?)
        ON CONFLICT(owner,id) DO UPDATE SET phase='cancelled',updated=excluded.updated`).run(this.owner, id, this.now(), this.now());
    });
    for (const row of this.db.prepare('SELECT id,body FROM editorial_intents WHERE owner=? AND body IS NOT NULL').all(this.owner)) {
      if (JSON.parse(row.body).turnId === id) this.cancelIntent(row.id);
    }
    return this.view(this.turn(id));
  }

  putIntent(id, input) {
    if (!isSafeId(id)) fail('INVALID_ID');
    fields(input, ['schema', 'id', 'turnId', 'kind', 'source', 'language', 'speechText', 'createdAt', 'expiresAt', 'presentation', 'editorial','chart']);
    if (input.id !== id || input.schema !== 'air3.editorial-intent.v1' || !Object.hasOwn(rank, input.kind)) fail('INVALID_INTENT');
    this.source(input.source);
    if (!['en', 'it'].includes(input.language) || !Number.isSafeInteger(input.createdAt) || input.createdAt > this.now() + 1000) fail('INVALID_INTENT');
    if (typeof input.speechText !== 'string' || !input.speechText.trim() || input.speechText.length > 8000 || /[\u0000\u007f]/u.test(input.speechText)) fail('INVALID_TEXT');
    fields(input.presentation, ['intent', 'monitor', 'snapshotRef']);
    // Snapshot pinning is not yet advertised; fail rather than point at an unrelated graph.
    if (input.presentation.intent !== 'address_audience' || Object.keys(input.presentation).length !== 1) fail('PRESENTATION_NOT_QUALIFIED', 409);
    fields(input.editorial, ['title', 'topic', 'sourceRefs']);
    line(input.editorial.title, 120); line(input.editorial.topic, 80);
    if (!Array.isArray(input.editorial.sourceRefs) || input.editorial.sourceRefs.length > 8 || stable(input.editorial.sourceRefs).length > 4096) fail('INVALID_SOURCE_REFS');
    speechSegments(input.speechText, input.language, input.kind);
    const chart=input.chart?decodeEditorialChart(input.chart):null;
    if(chart&&input.kind!=='chat')fail('CHART_REQUIRES_CHAT_TURN');
    return this.queue.transaction(() => {
      this.sweep(); const old = this.intent(id); const digest = hash(input);
      if (old?.hash === digest) return { ...this.view(old), duplicate: true };
      if (old) fail(old.body ? 'IDEMPOTENCY_CONFLICT' : 'INTENT_CANCELLED', old.body ? 409 : 410);
      this.deadline(input.expiresAt);
      if (input.kind === 'chat') {
        const turn = this.turn(input.turnId);
        if (!turn || !['preparing'].includes(turn.phase)) fail('TURN_NOT_PREPARING', turn?.phase === 'cancelled' ? 410 : 409);
        const request = JSON.parse(turn.body);
        const playbackLimit=input.chart?Math.max(turn.expires,input.createdAt+180000):turn.expires;
        if (request.prepareDeadlineAt <= this.now() || input.expiresAt > playbackLimit || stable(request.source) !== stable(input.source)) fail('TURN_EXPIRED', 410);
        if (this.db.prepare("SELECT body FROM editorial_intents WHERE owner=? AND kind='chat' AND body IS NOT NULL").all(this.owner)
          .some(v => JSON.parse(v.body).turnId === input.turnId)) fail('TURN_ALREADY_HAS_INTENT', 409);
        this.db.prepare("UPDATE editorial_turns SET phase='ready',expires=?,updated=? WHERE owner=? AND id=?").run(input.expiresAt,this.now(), this.owner, input.turnId);
      } else {
        if (input.turnId !== undefined || input.source.platform === 'twitch') fail('INVALID_LOW_SOURCE');
        if (this.hasChat()) fail('CHAT_PRIORITY', 409);
        const low = this.db.prepare("SELECT id,kind FROM editorial_intents WHERE owner=? AND kind<>'chat' AND status NOT IN ('completed','cancelled','expired','failed','superseded','playback_uncertain')").all(this.owner);
        if (low.length && (input.kind !== 'news' || low.some(v => v.kind !== 'filler'))) fail('LOW_PREFETCH_FULL', 429);
        for (const previous of low) this.db.prepare("UPDATE editorial_intents SET status='cancelling',wanted='superseded',updated=? WHERE owner=? AND id=?")
          .run(this.now(),this.owner,previous.id);
      }
      this.bounded('editorial_intents', 10000);
      const stored=chart?{...input,chart:storeEditorialChart(this.chartDir,chart,input.expiresAt)}:input;
      this.db.prepare("INSERT INTO editorial_intents(owner,id,body,hash,kind,status,expires,updated) VALUES(?,?,?,?,?,'ready',?,?)")
        .run(this.owner, id, stable(stored), digest, input.kind, input.expiresAt, this.now());
      return this.view(this.intent(id));
    });
  }

  cancelIntent(id) {
    if (!isSafeId(id)) fail('INVALID_ID');
    const old = this.intent(id);
    if (!old) {
      this.bounded('editorial_intents', 10000);
      this.db.prepare("INSERT INTO editorial_intents(owner,id,kind,status,expires,updated) VALUES(?,?,'chat','cancelled',?,?)")
        .run(this.owner, id, this.now(), this.now());
    } else if (!terminal.has(old.status)) {
      this.db.prepare("UPDATE editorial_intents SET status='cancelling',wanted='cancelled',updated=? WHERE owner=? AND id=?")
        .run(this.now(), this.owner, id);
      this.cancelUnstarted(id);
    }
    this.reconcile(); return this.view(this.intent(id));
  }
  cancelUnstarted(parent) {
    for (const link of this.db.prepare('SELECT job FROM editorial_segments WHERE owner=? AND parent=?').all(this.owner, parent)) {
      const row = this.queue.row(link.job);
      if (row && !['leased', 'playing'].includes(row.status)) this.queue.cancel(link.job);
    }
  }
  hasChat() {
    return !!this.db.prepare("SELECT id FROM editorial_turns WHERE owner=? AND phase IN ('queued','preparing','ready') AND expires>?").get(this.owner, this.now());
  }
  sweep() {
    const now = this.now();
    this.db.prepare("UPDATE editorial_turns SET phase='expired',updated=? WHERE owner=? AND phase IN ('queued','preparing','ready') AND expires<=?").run(now, this.owner, now);
    for (const row of this.db.prepare("SELECT id,body FROM editorial_turns WHERE owner=? AND phase='preparing'").all(this.owner)) {
      if (JSON.parse(row.body).prepareDeadlineAt <= now) this.db.prepare("UPDATE editorial_turns SET phase='expired',updated=? WHERE owner=? AND id=?").run(now, this.owner, row.id);
    }
    this.db.prepare("UPDATE editorial_intents SET status='cancelling',wanted='expired',updated=? WHERE owner=? AND status NOT IN ('completed','cancelled','expired','failed','superseded','playback_uncertain','cancelling') AND expires<=?")
      .run(now, this.owner, now);
    // Tombstones outlive every permitted retry window. Parent link pruning is atomic.
    const cutoff = now - this.retentionMs;
    this.db.prepare('DELETE FROM editorial_segments WHERE owner=? AND parent IN (SELECT id FROM editorial_intents WHERE owner=? AND updated<? AND status IN (\'completed\',\'cancelled\',\'expired\',\'failed\',\'superseded\',\'playback_uncertain\'))').run(this.owner, this.owner, cutoff);
    this.db.prepare("DELETE FROM editorial_intents WHERE owner=? AND updated<? AND status IN ('completed','cancelled','expired','failed','superseded','playback_uncertain')").run(this.owner, cutoff);
    this.db.prepare("DELETE FROM editorial_turns WHERE owner=? AND updated<? AND phase IN ('completed','cancelled','expired','failed')").run(this.owner, cutoff);
    this.db.prepare('DELETE FROM editorial_news WHERE owner=? AND expires<?').run(this.owner, cutoff);
    if(this.chartDir&&this.now()>=(this.nextChartSweep??0)){
      this.nextChartSweep=this.now()+60000;
      const retained=new Set(this.db.prepare('SELECT body FROM editorial_intents WHERE body IS NOT NULL').all().map(row=>JSON.parse(row.body).chart?.sha256).filter(Boolean));
      pruneEditorialCharts(this.chartDir,retained,this.now());
    }
  }

  reconcile() {
    this.queue.sweep(); this.sweep();
    for (const parent of this.db.prepare('SELECT * FROM editorial_intents WHERE owner=? AND body IS NOT NULL').all(this.owner)) {
      if (terminal.has(parent.status)) continue;
      const input = JSON.parse(parent.body);
      const links = this.db.prepare('SELECT * FROM editorial_segments WHERE owner=? AND parent=? ORDER BY idx').all(this.owner, parent.id);
      let cursor = 0; let status = parent.status; let busy = false;
      for (const link of links) {
        const child = this.queue.row(link.job);
        if (!child) { status = 'playback_uncertain'; break; }
        if (child.status === 'finished') { cursor++; continue; }
        if (['leased', 'playing'].includes(child.status)) busy = true;
        if (['failed', 'expired', 'cancelled'].includes(child.status)) {
          status = parent.wanted ?? (child.error === 'PLAYBACK_INTERRUPTED' ? (parent.kind === 'filler' ? 'superseded' : 'playback_uncertain') :
            child.status === 'failed' && !child.started_at ? 'failed' : child.status === 'cancelled' ? 'cancelled' : 'playback_uncertain');
        }
        break;
      }
      if(cursor >= speechSegments(input.speechText, input.language, input.kind).length)status='completed';
      else if (parent.status === 'cancelling') {
        this.cancelUnstarted(parent.id);
        if (!busy) status = parent.wanted || 'cancelled';
      } else if (parent.kind === 'filler' && this.hasChat() && cursor && !busy) status = 'superseded';
      else if (parent.kind === 'news' && this.hasChat() && cursor && !busy) status = 'suspended';
      this.db.prepare('UPDATE editorial_intents SET cursor=?,status=?,updated=CASE WHEN status<>? OR cursor<>? THEN ? ELSE updated END WHERE owner=? AND id=?')
        .run(cursor, status, status, cursor, this.now(), this.owner, parent.id);
      if (terminal.has(status) && input.turnId) this.db.prepare('UPDATE editorial_turns SET phase=?,updated=? WHERE owner=? AND id=?')
        .run(status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed', this.now(), this.owner, input.turnId);
    }
  }

  selected() {
    const rows = this.db.prepare("SELECT * FROM editorial_intents WHERE owner=? AND status IN ('ready','suspended') ORDER BY rowid").all(this.owner);
    const firstTurn = this.db.prepare("SELECT * FROM editorial_turns WHERE owner=? AND phase IN ('preparing','ready') ORDER BY sequence LIMIT 1").get(this.owner);
    if (firstTurn) return rows.find(r => r.kind === 'chat' && JSON.parse(r.body).turnId === firstTurn.id) ?? null;
    if (this.hasChat()) return null;
    return rows.sort((a,b) => rank[b.kind] - rank[a.kind])[0] ?? null;
  }
  pump() {
    this.reconcile();
    const parent = this.selected(); if (!parent) return;
    const input = JSON.parse(parent.body);let index=parent.cursor;
    const currentId=`ed_${hash([this.owner,parent.id,index])}`;
    const current=this.queue.row(currentId);
    if(parent.kind==='chat'&&current?.status==='playing'&&current.started_at)index++;
    const text = speechSegments(input.speechText, input.language, input.kind)[index];
    if(!text)return;
    const id = `ed_${hash([this.owner, parent.id, index])}`;
    if (this.queue.row(id)) return;
    // Link before enqueue. A crash between these statements is reconciled as
    // uncertain, never replayed from a presumed not-found.
    this.db.prepare('INSERT OR IGNORE INTO editorial_segments(job,owner,parent,idx) VALUES(?,?,?,?)').run(id, this.owner, parent.id, index);
    try { this.queue.enqueue({ id, text, language: input.language, expiresAt: input.expiresAt, priority: rank[parent.kind] }); }
    catch (error) {
      if (error.code === 'QUEUE_FULL') this.db.prepare('DELETE FROM editorial_segments WHERE job=?').run(id);
      else this.db.prepare("UPDATE editorial_intents SET status='failed',updated=? WHERE owner=? AND id=?").run(this.now(), this.owner, parent.id);
      if (error.code !== 'QUEUE_FULL') throw error;
    }
  }
  jobParent(job) {
    const link = this.db.prepare('SELECT * FROM editorial_segments WHERE job=? AND owner=?').get(job, this.owner);
    return link ? this.intent(link.parent) : null;
  }
  allowed(job) {
    const parent = this.jobParent(job);
    if (!parent) return !this.hasChat();
    if (terminal.has(parent.status) || parent.status === 'cancelling') return false;
    return this.selected()?.id === parent.id;
  }
  control(job) {
    const parent = this.jobParent(job);
    if (parent?.status === 'cancelling' || terminal.has(parent?.status)) return { yield: true, reason: parent.wanted || parent.status };
    if (parent?.kind === 'chat') return { yield: false };
    if (this.hasChat()) return { yield: true, reason: 'chat_priority' };
    return { yield: false };
  }
  decorate(job) {
    const parent = this.jobParent(job.id); if (!parent?.body) return { ...job, editorialControl: true };
    const input = JSON.parse(parent.body);
    return { ...job, editorial: { parentId: parent.id, kind: parent.kind,
      title: input.editorial.title, segmentIndex: parent.cursor, expiresAt:input.expiresAt, ...(input.chart?{chart:input.chart}:{}), addressAudience: true },
      // No per-segment emotion override: preserve the operator's baseline.
      emotionExplicit: false };
  }
  putNews(id, input) {
    if (!isSafeId(id)) fail('INVALID_ID');
    fields(input, ['revision', 'title', 'source', 'publishedAt', 'expiresAt']);
    this.source(input.source); line(input.title, 240, true);
    if (!Number.isSafeInteger(input.revision) || input.revision < 1 || !Number.isSafeInteger(input.publishedAt) ||
      input.publishedAt > this.now() + 60000 || input.publishedAt < this.now() - 21600000) fail('NEWS_NOT_FRESH', 410);
    const old = this.db.prepare('SELECT * FROM editorial_news WHERE owner=? AND id=?').get(this.owner, id);
    if (old?.hash === hash(input)) return { id, duplicate: true };
    if (old && input.revision <= old.revision) fail('NEWS_REVISION_CONFLICT', 409);
    this.deadline(input.expiresAt, 21600000);
    if (input.expiresAt > input.publishedAt + 21600000) fail('NEWS_NOT_FRESH', 410);
    if (!old) this.bounded('editorial_news', 200);
    this.db.prepare(`INSERT INTO editorial_news(owner,id,revision,body,hash,expires,updated) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(owner,id) DO UPDATE SET revision=excluded.revision,body=excluded.body,hash=excluded.hash,expires=excluded.expires,updated=excluded.updated`)
      .run(this.owner, id, input.revision, stable(input), hash(input), input.expiresAt, this.now());
    return { id, revision: input.revision };
  }
  state() {
    this.reconcile();
    const pending = this.db.prepare("SELECT count(*) AS n FROM editorial_turns WHERE owner=? AND phase IN ('queued','preparing','ready')").get(this.owner).n;
    const low = this.db.prepare("SELECT count(*) AS n FROM editorial_intents WHERE owner=? AND kind<>'chat' AND status NOT IN ('completed','cancelled','expired','failed','superseded','playback_uncertain')").get(this.owner).n;
    const news = this.db.prepare("SELECT id FROM editorial_intents WHERE owner=? AND kind='news' AND status NOT IN ('completed','cancelled','expired','failed','superseded','playback_uncertain')").get(this.owner);
    const active=this.db.prepare(`SELECT i.id,i.kind,i.body,i.expires FROM editorial_intents i
      JOIN editorial_segments s ON s.owner=i.owner AND s.parent=i.id JOIN narrations n ON n.id=s.job
      WHERE i.owner=? AND i.status='ready' AND i.expires>? AND n.started_at IS NOT NULL
      GROUP BY i.id ORDER BY max(n.started_at) DESC LIMIT 1`).get(this.owner,this.now());
    const input=active?.body?JSON.parse(active.body):null;
    const activeResponse=input?{id:active.id,kind:active.kind,title:input.editorial.title,expiresAt:active.expires,...(input.chart?{chart:input.chart}:{})}:null;
    return { pendingChat: pending, activeResponse, lowCapacity: pending || low ? 0 : 1, newsCapacity: pending || news ? 0 : 1,
      dispatchSequence:this.db.prepare('SELECT coalesce(max(sequence),0) AS n FROM editorial_turns WHERE owner=?').get(this.owner).n,
      playerOnline:Number.isFinite(this.playerSeenAt)&&this.now()-this.playerSeenAt<5000, now: this.now() };
  }
  program() {
    const speaking = this.db.prepare("SELECT id FROM narrations WHERE status='playing' AND started_at IS NOT NULL LIMIT 1").get();
    const parent = speaking ? this.jobParent(speaking.id) : null;
    const input = parent?.body ? JSON.parse(parent.body) : null;
    const ticker=newsTicker(this.db.prepare("SELECT body FROM editorial_news WHERE owner=? AND expires>? ORDER BY json_extract(body,'$.publishedAt') DESC LIMIT 100").all(this.owner,this.now()).map(row=>JSON.parse(row.body)));
    return { enabled: !!input || ticker.length > 0, label: input?.kind === 'chat' ? 'AIR3 CHAT' : 'AIR3 LIVE',
      title: input?.editorial.title ?? '', subtitle: '', ticker, speed: 65, expiresAt: input?.expiresAt ?? null };
  }
}
