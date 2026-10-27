import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { QueueError } from './queue.mjs';

export const DEFAULT_TITLES = Object.freeze({ enabled: false, label: '#AIR3 LIVE', title: '', subtitle: '',
  ticker: [], speed: 65, ttlSeconds: 0, expiresAt: null, updatedAt: null });
function line(v, max) {
  if (typeof v !== 'string' || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) throw new QueueError('INVALID_TITLE', 400);
  return v.trim();
}
export function normalizeTitles(patch, previous = DEFAULT_TITLES, now = Date.now()) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k => !['enabled', 'label', 'title', 'subtitle', 'ticker', 'speed', 'ttlSeconds'].includes(k))) throw new QueueError('INVALID_TITLES', 400);
  const v = { ...structuredClone(previous), ...patch };
  if (typeof v.enabled !== 'boolean') throw new QueueError('INVALID_TITLES', 400);
  v.label = line(v.label, 32); v.title = line(v.title, 120); v.subtitle = line(v.subtitle, 220);
  if (typeof v.ticker === 'string') v.ticker = v.ticker.split(/\r?\n/).filter(s => s.trim());
  if (!Array.isArray(v.ticker) || v.ticker.length > 12) throw new QueueError('INVALID_TICKER', 400);
  v.ticker = v.ticker.map(s => line(s, 240)).filter(Boolean);
  if (!Number.isFinite(v.speed) || v.speed < 20 || v.speed > 160 || !Number.isInteger(v.ttlSeconds) || v.ttlSeconds < 0 || v.ttlSeconds > 86400) throw new QueueError('INVALID_TITLES', 400);
  v.updatedAt = now; v.expiresAt = v.ttlSeconds ? now + v.ttlSeconds * 1000 : null;
  return v;
}
export async function createEditorialStore(dataDir, { now = Date.now } = {}) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = resolve(dataDir, 'live-titles.json');
  let state = structuredClone(DEFAULT_TITLES), chain = Promise.resolve();
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    const { updatedAt, expiresAt, ...input } = saved;
    state = normalizeTitles(input, DEFAULT_TITLES, Number(updatedAt) || now());
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('LIVE_TITLES_UNREADABLE'); }
  return {
    get() { return { ...structuredClone(state), enabled: state.enabled && (!state.expiresAt || state.expiresAt > now()) }; },
    update(patch) {
      const task = chain.then(async () => {
        const next = normalizeTitles(patch, state, now()), temp = file + '.tmp-' + randomUUID();
        await writeFile(temp, JSON.stringify(next) + '\n', { flag: 'wx', mode: 0o600 });
        await rename(temp, file); state = next; return structuredClone(state);
      }); chain = task.catch(() => {}); return task;
    },
  };
}
