import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

const TERMINAL = new Set(['finished', 'failed', 'cancelled', 'expired']);
const ACTIVE_SQL = "('queued','generating','ready','leased','playing')";
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
export const EMOTION_NAMES = Object.freeze(['neutral', 'happy', 'sad', 'surprised', 'warm', 'focused', 'concerned']);
export const EMOTION_ALIASES = Object.freeze({
  felice: 'happy', triste: 'sad', stupita: 'surprised', sorpresa: 'surprised',
  neutra: 'neutral', cordiale: 'warm', concentrata: 'focused', preoccupata: 'concerned'
});
const EMOTIONS = new Set([...EMOTION_NAMES, ...Object.keys(EMOTION_ALIASES)]);
// Reserve a small delivery/transition margin before the producer's hard deadline.
const PLAYBACK_START_MARGIN_MS = 2000;

export class QueueError extends Error {
  constructor(code, statusCode = 400) {
    super(code);
    this.name = 'QueueError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const isSafeId = (value) => typeof value === 'string' && ID.test(value);
export function normalizePresentation(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'action')) throw new QueueError('INVALID_PRESENTATION');
  const keys = Object.keys(value);
  if (value.action === 'home' && keys.length === 1) return { action: 'home' };
  if (value.action === 'monitor' && keys.length === 2 && Object.hasOwn(value, 'monitor') &&
      ['left', 'center', 'right'].includes(value.monitor)) return { action: 'monitor', monitor: value.monitor };
  throw new QueueError('INVALID_PRESENTATION');
}
const hash = (value) => createHash('sha256').update(value).digest('hex');
const apiJob = (row) => row ? ({ id: row.id, status: row.status,
  createdAt: row.created_at, expiresAt: row.expires_at,
  ...(row.error ? { error: row.error } : {}) }) : null;

/** SQLite is the source of truth; all lease decisions are atomic transactions. */
export class NarrationQueue {
  constructor(filename, config, now = Date.now) {
    this.config = config;
    this.now = now;
    // Keep an OS-managed lock on a separate SQLite file. Unlike PID files, this
    // releases on crash and works when container restarts reuse the same PID.
    try {
      this.lockDb = new DatabaseSync(`${filename}.lock`);
      this.lockDb.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
    } catch (error) {
      this.lockDb?.close();
      throw new QueueError(error.errcode === 5 || error.errcode === 6 ? 'GATEWAY_ALREADY_RUNNING' : 'GATEWAY_LOCK_UNAVAILABLE', 503);
    }
    try {
      this.db = new DatabaseSync(filename);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      this.db.exec(`CREATE TABLE IF NOT EXISTS narrations (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL, content_hash TEXT NOT NULL, text TEXT NOT NULL,
      language TEXT NOT NULL, priority INTEGER NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      status TEXT NOT NULL, audio_file TEXT, duration_ms REAL, error TEXT,
      lease_owner TEXT, lease_token TEXT, lease_expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS narration_status_order ON narrations(status, priority DESC, seq);
    CREATE INDEX IF NOT EXISTS narration_expiry ON narrations(expires_at);
    CREATE INDEX IF NOT EXISTS narration_retention ON narrations(updated_at);`);
      const columns = this.db.prepare('PRAGMA table_info(narrations)').all();
      if (!columns.some((column) => column.name === 'lip_sync_json')) this.db.exec('ALTER TABLE narrations ADD COLUMN lip_sync_json TEXT');
      if (!columns.some((column) => column.name === 'emotion_json')) this.db.exec('ALTER TABLE narrations ADD COLUMN emotion_json TEXT');
      if (!columns.some((column) => column.name === 'presentation_json')) this.db.exec('ALTER TABLE narrations ADD COLUMN presentation_json TEXT');
      this.recover();
    } catch (error) {
      this.db?.close();
      this.lockDb.close();
      throw error;
    }
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recover() {
    const now = this.now();
    this.transaction(() => {
      // A process cannot know how much was already spoken. Never replay.
      this.db.prepare(`UPDATE narrations SET status='expired', error='PLAYBACK_INTERRUPTED_BY_RESTART',
        updated_at=?, lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
        WHERE status IN ('leased','playing')`).run(now);
      this.db.prepare("UPDATE narrations SET status='queued',updated_at=? WHERE status='generating'").run(now);
      this.sweep();
    });
  }

  sweep() {
    const now = this.now();
    this.db.prepare(`UPDATE narrations SET status='expired',error='NARRATION_EXPIRED',updated_at=?,
      lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
      WHERE status IN ${ACTIVE_SQL} AND expires_at<=?`).run(now, now);
    this.db.prepare(`UPDATE narrations SET status='expired',error='PLAYBACK_LEASE_LOST',updated_at=?,
      lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
      WHERE status IN ('leased','playing') AND lease_expires_at<=?`).run(now, now);
  }

  enqueue(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new QueueError('INVALID_REQUEST');
    const { text } = input;
    if (typeof text !== 'string' || !text.trim() || text.length > this.config.maxTextChars || text.includes('\u0000')) {
      throw new QueueError('INVALID_TEXT');
    }
    const id = input.id === undefined ? randomUUID() : input.id;
    if (!isSafeId(id)) throw new QueueError('INVALID_ID');
    const language = input.language ?? 'en';
    if (!['en', 'it'].includes(language)) throw new QueueError('INVALID_LANGUAGE');
    let emotion = null;
    if (input.emotion !== undefined) {
      const raw = typeof input.emotion === 'string' ? input.emotion : input.emotion?.name;
      const intensity = typeof input.emotion === 'string' ? .35 : input.emotion?.intensity ?? .35;
      if (!EMOTIONS.has(raw) || !Number.isFinite(intensity) || intensity < 0 || intensity > 1) throw new QueueError('INVALID_EMOTION');
      const name = EMOTION_ALIASES[raw] || raw;
      emotion = { name, intensity };
    }
    const priority = input.priority ?? 0;
    if (!Number.isInteger(priority) || priority < -100 || priority > 100) throw new QueueError('INVALID_PRIORITY');
    if (input.expiresAt !== undefined && !Number.isSafeInteger(input.expiresAt)) throw new QueueError('INVALID_EXPIRY');
    const presentation = normalizePresentation(input.presentation);
    // Do not add a null field to the legacy hash: old producer retries must
    // retain their existing idempotency keys after the additive migration.
    const contentHash = hash(JSON.stringify({ text, language, priority, expiresAt: input.expiresAt ?? null,
      ...(emotion ? { emotion } : {}), ...(presentation ? { presentation } : {}) }));
    return this.transaction(() => {
      this.sweep();
      const existing = this.db.prepare('SELECT * FROM narrations WHERE id=?').get(id);
      if (existing) {
        if (existing.content_hash !== contentHash) throw new QueueError('IDEMPOTENCY_CONFLICT', 409);
        return { ...apiJob(existing), duplicate: true };
      }
      const now = this.now();
      const expiresAt = input.expiresAt ?? now + this.config.maxAgeMs;
      if (expiresAt <= now || expiresAt > now + this.config.maxAgeMs) throw new QueueError('INVALID_EXPIRY');
      const { count } = this.db.prepare(`SELECT count(*) AS count FROM narrations WHERE status IN ${ACTIVE_SQL}`).get();
      if (count >= this.config.maxPending) throw new QueueError('QUEUE_FULL', 429);
      this.db.prepare(`INSERT INTO narrations
        (id,content_hash,text,language,priority,created_at,expires_at,updated_at,status,emotion_json,presentation_json)
        VALUES (?,?,?,?,?,?,?,?,'queued',?,?)`).run(id, contentHash, text, language, priority, now, expiresAt, now,
          emotion ? JSON.stringify(emotion) : null, presentation ? JSON.stringify(presentation) : null);
      return { id, status: 'queued', createdAt: now, expiresAt, duplicate: false };
    });
  }

  get(id) { this.sweep(); return apiJob(this.row(id)); }
  row(id) { return this.db.prepare('SELECT * FROM narrations WHERE id=?').get(id) ?? null; }

  cancel(id) {
    this.sweep();
    const existing = this.row(id);
    if (!existing) throw new QueueError('NOT_FOUND', 404);
    if (!TERMINAL.has(existing.status)) {
      this.db.prepare(`UPDATE narrations SET status='cancelled',error=NULL,updated_at=?,
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=?`).run(this.now(), id);
    }
    return apiJob(this.row(id));
  }

  takeForGeneration() {
    return this.transaction(() => {
      this.sweep();
      const row = this.db.prepare("SELECT * FROM narrations WHERE status='queued' ORDER BY priority DESC,seq ASC LIMIT 1").get();
      if (!row) return null;
      this.db.prepare("UPDATE narrations SET status='generating',updated_at=? WHERE id=?").run(this.now(), row.id);
      return { id: row.id, text: row.text, language: row.language, expiresAt: row.expires_at };
    });
  }

  markReady(id, audioFile, durationMs, lipSync = { kind: 'amplitude' }) {
    this.sweep();
    return this.db.prepare(`UPDATE narrations SET status='ready',audio_file=?,duration_ms=?,lip_sync_json=?,updated_at=?
      WHERE id=? AND status='generating'`).run(audioFile, durationMs, JSON.stringify(lipSync), this.now(), id).changes === 1;
  }

  markFailed(id, error = 'TTS_FAILED') {
    this.sweep();
    const safe = typeof error === 'string' && /^TTS_[A-Z0-9_]{1,64}$/.test(error) ? error : 'TTS_FAILED';
    this.db.prepare("UPDATE narrations SET status='failed',error=?,updated_at=? WHERE id=? AND status='generating'")
      .run(safe, this.now(), id);
  }

  claim(playerId) {
    if (!isSafeId(playerId)) throw new QueueError('INVALID_PLAYER_ID');
    return this.transaction(() => {
      this.sweep();
      if (this.db.prepare("SELECT id FROM narrations WHERE status IN ('leased','playing') LIMIT 1").get()) {
        return { job: null };
      }
      const now = this.now();
      this.db.prepare(`UPDATE narrations SET status='expired',error='PLAYBACK_DEADLINE_TOO_CLOSE',updated_at=?
        WHERE status='ready' AND duration_ms+?>=expires_at-?`)
        .run(now, PLAYBACK_START_MARGIN_MS, now);
      const row = this.db.prepare("SELECT * FROM narrations WHERE status='ready' ORDER BY priority DESC,seq ASC LIMIT 1").get();
      if (!row) return { job: null };
      const leaseToken = randomUUID();
      const leaseExpiresAt = Math.min(now + this.config.leaseMs, row.expires_at);
      this.db.prepare(`UPDATE narrations SET status='leased',lease_owner=?,lease_token=?,lease_expires_at=?,updated_at=?
        WHERE id=?`).run(playerId, leaseToken, leaseExpiresAt, now, row.id);
      return { job: { id: row.id, text: row.text, audioPath: `/api/audio/${encodeURIComponent(row.id)}`,
        durationMs: row.duration_ms, leaseToken, lipSync: row.lip_sync_json ? JSON.parse(row.lip_sync_json) : { kind: 'amplitude' },
        emotion: row.emotion_json ? JSON.parse(row.emotion_json) : { name: 'neutral', intensity: .35 },
        emotionExplicit: !!row.emotion_json,
        presentation: row.presentation_json ? JSON.parse(row.presentation_json) : null },
      leaseMs: leaseExpiresAt - now };
    });
  }

  playerEvent(id, input) {
    if (!input || !isSafeId(input.playerId) || typeof input.leaseToken !== 'string' ||
        !['started', 'heartbeat', 'finished', 'failed'].includes(input.event)) throw new QueueError('INVALID_PLAYER_EVENT');
    const result = this.transaction(() => {
      this.sweep();
      const row = this.row(id);
      if (!row) throw new QueueError('NOT_FOUND', 404);
      if (!['leased', 'playing'].includes(row.status) || row.lease_owner !== input.playerId || row.lease_token !== input.leaseToken) {
        throw new QueueError('LEASE_INVALID', 409);
      }
      const now = this.now();
      if (input.event === 'started' && row.status === 'leased' &&
          row.duration_ms + PLAYBACK_START_MARGIN_MS >= row.expires_at - now) {
        this.db.prepare(`UPDATE narrations SET status='expired',error='PLAYBACK_DEADLINE_TOO_CLOSE',updated_at=?,
          lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=?`).run(now, id);
        // Commit the terminal state before rejecting the attempted start.
        return new QueueError('PLAYBACK_DEADLINE_TOO_CLOSE', 409);
      }
      if (input.event === 'finished' || input.event === 'failed') {
        if (input.event === 'finished' && row.status !== 'playing') throw new QueueError('PLAYBACK_NOT_STARTED', 409);
        const status = input.event === 'finished' ? 'finished' : 'failed';
        this.db.prepare(`UPDATE narrations SET status=?,error=?,updated_at=?,lease_owner=NULL,lease_token=NULL,
          lease_expires_at=NULL WHERE id=?`).run(status, status === 'failed' ? 'PLAYBACK_FAILED' : null, now, id);
      } else {
        const status = input.event === 'started' ? 'playing' : row.status;
        this.db.prepare('UPDATE narrations SET status=?,lease_expires_at=?,updated_at=? WHERE id=?')
          .run(status, Math.min(now + this.config.leaseMs, row.expires_at), now, id);
      }
      return { id, status: this.row(id).status, leaseMs: Math.max(0, Math.min(this.config.leaseMs, row.expires_at - now)) };
    });
    if (result instanceof QueueError) throw result;
    return result;
  }

  audioRecord(id) {
    this.sweep();
    const row = this.row(id);
    if (!row || !['leased', 'playing'].includes(row.status) || !row.audio_file) throw new QueueError('AUDIO_NOT_AVAILABLE', 404);
    return row;
  }

  prune() {
    const cutoff = this.now() - this.config.retentionMs;
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT id,audio_file FROM narrations WHERE status NOT IN ${ACTIVE_SQL} AND updated_at<?`).all(cutoff);
      this.db.prepare(`DELETE FROM narrations WHERE status NOT IN ${ACTIVE_SQL} AND updated_at<?`).run(cutoff);
      return rows;
    });
  }

  counts() {
    this.sweep();
    const rows = this.db.prepare('SELECT status,count(*) AS count FROM narrations GROUP BY status').all();
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  referencedAudioFiles() {
    return new Set(this.db.prepare('SELECT audio_file FROM narrations WHERE audio_file IS NOT NULL').all().map((row) => row.audio_file));
  }

  close() {
    try { this.db.close(); }
    finally { this.lockDb.close(); }
  }
}
