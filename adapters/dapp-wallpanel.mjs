#!/usr/bin/env node
// Optional server-to-server AIRTrack bridge. No dApp repository or wallet code
// is required; only the original public GET endpoints are read.
import { pathToFileURL } from 'node:url';
import { FEEDS, TIMEFRAMES, normalizeApiBase, normalizeTrades, normalizeCandles,
  normalizeReport, fetchJson } from '../studio-broadcast/public/pure.mjs';

const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_PANEL_BYTES = 128 * 1024;
const MAX_BACKOFF_MS = 30_000;

class BridgeError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function integer(env, key, fallback, min, max) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(String(raw))) throw new BridgeError(`INVALID_${key}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new BridgeError(`INVALID_${key}`);
  return value;
}

function httpBase(raw, key) {
  if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw)) throw new BridgeError(`INVALID_${key}`);
  let url;
  try { url = new URL(raw); } catch { throw new BridgeError(`INVALID_${key}`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new BridgeError(`INVALID_${key}`);
  }
  return url.href.replace(/\/+$/, '');
}

export function loadDappBridgeConfig(env = process.env) {
  if (!env.AIR3_DAPP_BASE_URL) throw new BridgeError('AIR3_DAPP_BASE_URL_REQUIRED');
  const dappBase = normalizeApiBase(httpBase(env.AIR3_DAPP_BASE_URL, 'AIR3_DAPP_BASE_URL'));
  const port = integer(env, 'AIR3_PORT', 5890, 1, 65535);
  const liveBase = httpBase(env.AIR3_LIVE_BASE_URL || `http://127.0.0.1:${port}`, 'AIR3_LIVE_BASE_URL');
  const token = env.AIR3_PRODUCER_TOKEN;
  if (typeof token !== 'string' || token.length < 32 || token.length > 512 || /\s|[\x00-\x1f\x7f]/.test(token)) {
    throw new BridgeError('AIR3_PRODUCER_TOKEN_REQUIRED');
  }
  const feed = env.AIR3_DAPP_FEED || 'track';
  if (!Object.hasOwn(FEEDS, feed)) throw new BridgeError('INVALID_AIR3_DAPP_FEED');
  const timeframe = env.AIR3_DAPP_TIMEFRAME || '1h';
  if (!TIMEFRAMES.includes(timeframe)) throw new BridgeError('INVALID_AIR3_DAPP_TIMEFRAME');
  return Object.freeze({
    dappBase, liveBase, producerToken: token, feed, timeframe,
    pollMs: integer(env, 'AIR3_DAPP_POLL_MS', 4000, 3000, 30_000),
    candlesMs: integer(env, 'AIR3_DAPP_CANDLES_MS', 15_000, 15_000, 300_000),
    reportMs: integer(env, 'AIR3_DAPP_REPORT_MS', 60_000, 60_000, 3_600_000),
    timeoutMs: integer(env, 'AIR3_DAPP_TIMEOUT_MS', 4000, 1000, 15_000),
    ttlSeconds: integer(env, 'AIR3_DAPP_BRIDGE_TTL_SECONDS', 30, 15, 300),
    rotateMs: integer(env, 'AIR3_DAPP_ROTATE_SECONDS', 12, 0, 300) * 1000,
  });
}

function validatedTrades(raw) {
  const rows = Array.isArray(raw) ? raw : raw?.items ?? raw?.trades;
  const trades = normalizeTrades(raw);
  // An empty response is legitimate; a nonempty but wholly malformed snapshot
  // must not erase the last usable panel or refresh its freshness indicator.
  if (rows.length && !trades.length) throw new BridgeError('DAPP_TRADES_INVALID');
  return trades;
}

function validatedCandles(raw) {
  const rows = Array.isArray(raw) ? raw : raw?.data;
  const candles = normalizeCandles(raw);
  if (rows.length && !candles.length) throw new BridgeError('DAPP_CANDLES_INVALID');
  return candles;
}

function validatedReport(raw) {
  const report = normalizeReport(raw);
  if (Object.values(report).every(value => value === null)) throw new BridgeError('DAPP_REPORT_INVALID');
  return report;
}

/** A single non-overlapping poller. The producer token is attached exclusively
 * to the configured live destination. Redirects are rejected on both sides.
 * Failed source refreshes never republish cached data as a fresh wallpanel. */
export function createDappWallpanelBridge({ config = loadDappBridgeConfig(), fetchImpl = fetch,
  now = Date.now, onStatus = () => {}, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  const feed = FEEDS[config.feed];
  let epoch = 0, running = false, timer = null, pending = null, aborter = null;
  let cache = { selectedId: null, candles: [], chartAt: 0, report: null, reportAt: 0, nextRotationAt: 0 };
  const state = { phase: 'idle', feed: config.feed, timeframe: config.timeframe,
    attempts: 0, failures: 0, lastAttemptAt: 0, lastPublishedAt: 0,
    selectedId: null, tradeCount: 0, candleCount: 0, nextDelayMs: 0, error: null };
  const status = () => ({ ...state, running });
  function emit() { try { onStatus(status()); } catch { /* Monitoring must not stop the bridge. */ } }
  function current(generation, signal) {
    if (generation !== epoch || signal.aborted) throw new BridgeError('STOPPED');
  }
  async function getSource(path, code, normalize, signal) {
    try {
      const raw = await fetchJson(`${config.dappBase}/${path}`, { method: 'GET', redirect: 'error', signal },
        { timeoutMs: config.timeoutMs, maxBytes: MAX_SOURCE_BYTES, fetchImpl });
      return normalize(raw);
    } catch (error) {
      if (signal.aborted) throw new BridgeError('STOPPED');
      // Do not expose provider bodies, URLs, credentials or parser excerpts.
      throw new BridgeError(error instanceof BridgeError ? error.code : code);
    }
  }
  async function cycle(generation, signal) {
    const trades = await getSource(`${feed.trades}?statuses=OPEN,PENDING&limit=50&page=1`,
      'DAPP_TRADES_FAILED', validatedTrades, signal);
    current(generation, signal);
    const sourceAt = now();
    const oldIndex = trades.findIndex(trade => trade.id === cache.selectedId);
    let selected = oldIndex >= 0 ? trades[oldIndex] : trades[0] ?? null;
    const rotate = config.rotateMs > 0 && oldIndex >= 0 && trades.length > 1 && sourceAt >= cache.nextRotationAt;
    if (rotate) selected = trades[(oldIndex + 1) % trades.length];
    const selectedId = selected?.id ?? null;
    const changed = selectedId !== cache.selectedId;
    const chartDue = !!selected && (changed || !cache.chartAt || sourceAt - cache.chartAt >= config.candlesMs);
    const reportDue = !cache.report || !cache.reportAt || sourceAt - cache.reportAt >= config.reportMs;
    // Wait for both independent reads before committing a consistent snapshot.
    const results = await Promise.allSettled([
      chartDue ? getSource(`${feed.trades}/${selectedId}/ohlcv?tf=${encodeURIComponent(config.timeframe)}`,
        'DAPP_CANDLES_FAILED', validatedCandles, signal) : Promise.resolve(selected ? cache.candles : []),
      reportDue ? getSource(`${feed.reports}?window=all`, 'DAPP_REPORT_FAILED', validatedReport, signal) : Promise.resolve(cache.report),
    ]);
    current(generation, signal);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    const candles = results[0].value, report = results[1].value;
    const fetchedAt = now();
    const chartAt = chartDue ? fetchedAt : selected ? cache.chartAt : 0;
    const reportAt = reportDue ? fetchedAt : cache.reportAt;
    const chartAge = chartAt ? Math.max(0, Math.floor((fetchedAt - chartAt) / 1000)) : null;
    const reportAge = Math.max(0, Math.floor((fetchedAt - reportAt) / 1000));
    const payload = { title: feed.label, source: `${feed.label} · dApp pubblica`,
      subtitle: `${config.timeframe} · candele ${chartAge === null ? 'non disponibili' : `${chartAge}s`} · riepilogo ${reportAge}s`,
      trades, candles, report, selectedId, sourceAt, ttlSeconds: config.ttlSeconds };
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > MAX_PANEL_BYTES) throw new BridgeError('WALLPANEL_TOO_LARGE');
    current(generation, signal);
    try {
      await fetchJson(`${config.liveBase}/api/live/wallpanel`, { method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.producerToken}` }, body },
      { timeoutMs: config.timeoutMs, maxBytes: MAX_PANEL_BYTES, fetchImpl });
    } catch {
      if (signal.aborted) throw new BridgeError('STOPPED');
      throw new BridgeError('LIVE_PUBLISH_FAILED');
    }
    current(generation, signal);
    cache = { selectedId, candles, chartAt, report, reportAt,
      nextRotationAt: changed || rotate || !cache.nextRotationAt ? fetchedAt + config.rotateMs : cache.nextRotationAt };
    return { selectedId, tradeCount: trades.length, candleCount: candles.length };
  }
  function runOnce() {
    if (pending) return pending;
    const generation = epoch, controller = new AbortController();
    aborter = controller;
    Object.assign(state, { phase: 'polling', attempts: state.attempts + 1, lastAttemptAt: now(), error: null });
    emit();
    const task = cycle(generation, controller.signal).then(result => {
      current(generation, controller.signal);
      Object.assign(state, result, { phase: 'ready', failures: 0, lastPublishedAt: now(), nextDelayMs: config.pollMs, error: null });
      emit();
      return { ok: true, ...result };
    }).catch(error => {
      if (generation !== epoch || controller.signal.aborted || error?.code === 'STOPPED') return { ok: false, error: 'STOPPED' };
      state.failures++;
      Object.assign(state, { phase: 'retrying', error: error instanceof BridgeError ? error.code : 'BRIDGE_FAILED',
        nextDelayMs: Math.min(MAX_BACKOFF_MS, config.pollMs * 2 ** Math.min(state.failures - 1, 10)) });
      emit();
      return { ok: false, error: state.error };
    }).finally(() => {
      if (aborter === controller) aborter = null;
      if (pending === task) pending = null;
    });
    pending = task;
    return task;
  }
  async function loop(generation) {
    await runOnce();
    if (!running || generation !== epoch) return;
    timer = setTimeoutImpl(() => { timer = null; void loop(generation); }, state.nextDelayMs);
  }
  function start() {
    if (running) return status();
    // A manual runOnce may already be in flight; join it without duplicating it.
    running = true;
    void loop(epoch);
    return status();
  }
  function stop() {
    running = false; epoch++;
    if (timer !== null) clearTimeoutImpl(timer);
    timer = null; aborter?.abort();
    Object.assign(state, { phase: 'stopped', nextDelayMs: 0 });
    emit();
    return status();
  }
  return Object.freeze({ start, stop, runOnce, status });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('AIR3 public dApp → standalone wallpanel bridge\n\n' +
      'node --env-file=studio-broadcast/.env adapters/dapp-wallpanel.mjs [--once]\n\n' +
      'Required: AIR3_DAPP_BASE_URL, AIR3_PRODUCER_TOKEN\n' +
      'Optional: AIR3_LIVE_BASE_URL (http://127.0.0.1:5890), AIR3_DAPP_FEED (track|auto),\n' +
      'AIR3_DAPP_TIMEFRAME (1h), AIR3_DAPP_ROTATE_SECONDS (12; 0 disables rotation).\n' +
      'See docs/DAPP_BRIDGE_3.0.md. Set the central monitor source to External in Live control.');
    return;
  }
  if (args.some(arg => arg !== '--once')) throw new BridgeError('UNKNOWN_ARGUMENT');
  let lastLogAt = 0, lastError = null;
  const bridge = createDappWallpanelBridge({ config: loadDappBridgeConfig(), onStatus: state => {
    if (state.phase === 'ready' && (Date.now() - lastLogAt >= 60_000 || lastError)) {
      console.log(JSON.stringify({ event: 'wallpanel-published', feed: state.feed, selectedId: state.selectedId,
        trades: state.tradeCount, candles: state.candleCount, at: state.lastPublishedAt }));
      lastLogAt = Date.now(); lastError = null;
    } else if (state.phase === 'retrying' && (state.error !== lastError || Date.now() - lastLogAt >= 60_000)) {
      console.error(JSON.stringify({ event: 'wallpanel-retry', error: state.error, retryMs: state.nextDelayMs }));
      lastError = state.error; lastLogAt = Date.now();
    }
  } });
  const shutdown = () => bridge.stop();
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  if (args.includes('--once')) {
    const result = await bridge.runOnce();
    bridge.stop();
    process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown);
    if (!result.ok) process.exitCode = 1;
  } else bridge.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify({ event: 'wallpanel-bridge-error', error: error instanceof BridgeError ? error.code : 'BRIDGE_FAILED' }));
    process.exitCode = 1;
  });
}
