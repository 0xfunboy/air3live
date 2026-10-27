import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MARKET_DEFAULTS, createLiveMarketService, validateMarketConfig, liquidationEvent, binanceCandles,
  observedHeatmap, coinglassHeatmap, normalizeWallpanel, demoMarketSnapshot } from '../src/live-market.mjs';
import { createLiveMarketClient } from '../public/live-market-client.mjs';
import { heatColor } from '../public/market-panels.mjs';

const NOW = 1_793_100_000_000;
const fill = (patch = {}) => ({ e: 'forceOrder', E: NOW, o: { s: 'BTCUSDT', S: 'SELL', X: 'FILLED', T: NOW, ap: '80000', z: '.5', l: '.1', q: '4', p: '81000', ...patch } });
const prices = [[NOW - 600_000, '80000', '80400', '79900', '80200', '32'], [NOW - 300_000, '80200', '80300', '80100', '80250', '24']];
const flush = () => new Promise(resolve => setImmediate(resolve));
function fakeSocket() {
  return class Socket {
    static instances = [];
    constructor(url) { this.url = url; this.readyState = 0; this.constructor.instances.push(this); }
    open() { this.readyState = 1; this.onopen?.({}); }
    message(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
    fail() { this.onerror?.({}); }
    close() { this.readyState = 3; this.closed = true; }
  };
}
function fixtures(url) {
  if (url.includes('klines')) return Response.json(prices);
  const s = new URL(url).searchParams.get('symbol');
  return Response.json({ symbol: s, lastPrice: '80250', priceChangePercent: '1.25', highPrice: '81000', lowPrice: '79000', quoteVolume: '90000000' });
}

test('market defaults are real Binance; enum, enabled and key fields reject invalid input and never accept arbitrary endpoints', () => {
  assert.equal(MARKET_DEFAULTS.provider, 'binance'); assert.equal(MARKET_DEFAULTS.enabled, true);
  for (const input of [{ provider: 'scrape' }, { symbol: '../../x' }, { range: 'forever' }, { enabled: 'false' }, { wallpanelSource: 'iframe' }, { coinglassKey: 'key\r\nHeader: bad' }]) assert.throws(() => validateMarketConfig(input));
  const c = validateMarketConfig({ endpoint: 'http://127.0.0.1/secret', coinglassKey: 'test-only-key' });
  assert.equal(c.endpoint, undefined); assert.equal(c.coinglassKey, 'test-only-key');
});

test('liquidation snapshots use completed execution price × executed quantity, correct long/short, and exclude partial/request-only orders', () => {
  const e = liquidationEvent(fill(), NOW);
  assert.equal(e.usd, 40_000); assert.equal(e.side, 'long');
  assert.equal(liquidationEvent(fill({ S: 'BUY' }), NOW).side, 'short');
  for (const patch of [{ X: 'PARTIALLY_FILLED' }, { X: 'NEW' }, { z: 0 }, { ap: 0 }, { ap: 'NaN' }, { s: 'BTCUSD_PERP' }, { S: 'UNKNOWN' }, { T: NOW + 100_000 }]) assert.equal(liquidationEvent(fill(patch), NOW), null);
  assert.equal(liquidationEvent({ ...fill(), st: 2 }, NOW), null);
});

test('Binance candle normalization preserves actual values, order, and rejects impossible OHLC instead of synthesizing data', () => {
  const c = binanceCandles([...prices.slice().reverse(), [NOW, 10, 1, 12, 5, 1]]);
  assert.equal(c.length, 2); assert.equal(c[0].close, 80200); assert.equal(c[1].time, NOW - 300_000);
  assert.deepEqual(binanceCandles([]), []); assert.throws(() => binanceCandles({ code: -1 }));
});

test('observed heatmap bins only matching real executed events and distinguishes empty collection from a predicted-level model', () => {
  const events = [liquidationEvent(fill({ T: NOW - 10_000 }), NOW), liquidationEvent(fill({ T: NOW - 9_000, S: 'BUY' }), NOW),
    liquidationEvent(fill({ T: NOW - 8_000, s: 'ETHUSDT', ap: '3000' }), NOW)];
  const h = observedHeatmap(events, binanceCandles(prices), { symbol: 'BTCUSDT', range: '12h', now: NOW, collectedSince: NOW - 20_000 });
  assert.equal(h.kind, 'observed-liquidations'); assert.equal(h.count, 2); assert.equal(h.longUsd, 40000); assert.equal(h.shortUsd, 40000);
  assert.equal(h.cells.reduce((sum, row) => sum + row[2], 0), 80000);
  assert.ok(h.coverage.includes('non indica') || h.coverage.includes('Non indica'));
  const empty = observedHeatmap([], [], { symbol: 'BTCUSDT', range: '12h', now: NOW });
  assert.deepEqual(empty.cells, []); assert.equal(empty.minPrice, null); assert.equal(empty.count, 0);
});

test('CoinGlass adapter maps source axes, keeps missing-index alignment, and never falls back to an invented model', () => {
  const raw = { code: '0', data: { y_axis: [79000, 80000, 81000], price_candlesticks: [
    [NOW / 1000 - 600, '80000', '80400', '79900', '80200', 0], [NOW / 1000 - 300, 1, 0, 3, 2, 0],
    [NOW / 1000, '80200', '80400', '80100', '80300', 0]],
    liquidation_leverage_data: [[0, 0, 10000], [1, 1, 999999], [2, 2, 20000], [100, 1, 60000]] } };
  const h = coinglassHeatmap(raw, { symbol: 'BTCUSDT', range: '12h', now: NOW });
  assert.equal(h.kind, 'estimated-liquidation-levels'); assert.equal(h.candles.length, 2); assert.equal(h.cells.length, 2);
  assert.equal(h.cells.reduce((s, c) => s + c[2], 0), 30000);
  assert.equal(h.longUsd, null); assert.equal(h.count, null);
  assert.throws(() => coinglassHeatmap({ code: 401 }, { symbol: 'BTCUSDT', range: '12h' }));
});

test('wallpanel validates original AIRTrack DTO, caps supplied content, ignores HTML/URL transport, preserves nulls and marks expiry', () => {
  const w = normalizeWallpanel({ title: 'AIRTrack', source: 'API dApp', ttlSeconds: 30,
    trades: [{ id: 7, symbol: 'ETH', side: 'LONG', status: 'OPEN', entry_price: 3000, tp_price: 3200, sl_price: 2900, unrealized_pnl_pct: null }],
    selectedId: 7, candles: [{ time: NOW, open: 3000, high: 3010, low: 2990, close: 3005 }],
    report: { totals: { open: 1, pending: 0, closed: 8 }, pnl_realized_pct_sum: 12.4 }, iframe: 'https://example.test', html: '<script>bad</script>' }, NOW);
  assert.equal(w.selected.entry, 3000); assert.equal(w.selected.pnl, null); assert.equal(w.report.pnlSum, 12.4);
  assert.equal(w.expiresAt, NOW + 30_000); assert.equal(w.iframe, undefined); assert.equal(w.html, undefined);
  const limited = normalizeWallpanel({ cards: Array.from({ length: 20 }, () => ({ label: 'x'.repeat(100), value: 'test' })), rows: Array.from({ length: 20 }, () => ({ label: 'x' })) }, NOW);
  assert.equal(limited.cards.length, 6); assert.equal(limited.cards[0].label.length, 24); assert.equal(limited.rows.length, 8);
});

test('disabled service opens no feed, HTTP request or scheduled timer', async () => {
  let calls = 0; const Socket = fakeSocket();
  const service = createLiveMarketService({ config: { enabled: false }, WebSocketImpl: Socket, fetchImpl: async () => { calls++; throw new Error('not expected'); }, now: () => NOW });
  await service.start(); assert.equal(service.snapshot().connection.status, 'disabled'); assert.equal(service.snapshot().connection.stale, true);
  assert.equal(calls, 0); assert.equal(Socket.instances.length, 0); assert.equal(service.timers.size, 0); await service.stop();
});

test('stopping during local history load prevents a late market connection', async () => {
  let release, calls = 0; const Socket = fakeSocket();
  const service = createLiveMarketService({ WebSocketImpl: Socket, fetchImpl: async () => { calls++; return Response.json([]); } });
  service.load = () => new Promise(done => { release = done; });
  const starting = service.start(), stopping = service.stop(); release();
  await Promise.all([starting, stopping]); assert.equal(calls, 0); assert.equal(Socket.instances.length, 0); assert.equal(service.state.status, 'stopped');
});

test('queued market reconfiguration applies changes in order and keeps disabled mode offline', async () => {
  const Socket = fakeSocket(), service = createLiveMarketService({ config: { enabled: false }, WebSocketImpl: Socket });
  await service.start();
  await Promise.all([service.configure({ symbol: 'ETHUSDT' }), service.configure({ range: '24h' }), service.configure({ symbol: 'SOLUSDT' })]);
  assert.equal(service.publicConfig().symbol, 'SOLUSDT'); assert.equal(service.publicConfig().range, '24h'); assert.equal(Socket.instances.length, 0); await service.stop();
});

test('missing CoinGlass key is explicit and never leaks a secret or generates demo values', async () => {
  let calls = 0; const service = createLiveMarketService({ config: { provider: 'coinglass' }, fetchImpl: async () => { calls++; throw new Error('not expected'); } });
  await service.start(); const s = service.snapshot();
  assert.equal(s.connection.status, 'requires-key'); assert.deepEqual(s.heatmap.cells, []); assert.equal(s.demo, false); assert.equal(calls, 0);
  await service.configure({ coinglassKey: 'test-only-secret', enabled: false });
  assert.equal(JSON.stringify(service.snapshot()).includes('test-only-secret'), false); assert.equal(service.publicConfig().coinglassConfigured, true);
  await service.stop();
});

test('real provider never substitutes demo during source failure and marks retained data stale', async () => {
  const Socket = fakeSocket(), service = createLiveMarketService({ WebSocketImpl: Socket, fetchImpl: async () => Response.json({ denied: true }, { status: 451 }), now: () => NOW });
  await service.start(); await flush(); await flush(); Socket.instances[0].fail();
  const s = service.snapshot(); assert.equal(s.demo, false); assert.deepEqual(s.heatmap.cells, []); assert.equal(s.connection.stale, true); assert.equal(s.connection.status, 'retrying');
  await service.stop();
});

test('Binance reconnect closes old socket, ignores duplicate executions and late callbacks after stop', async () => {
  const Socket = fakeSocket(), service = createLiveMarketService({ WebSocketImpl: Socket, fetchImpl: async url => fixtures(url), now: () => NOW, random: () => .5 });
  const jobs = []; service.schedule = (fn, ms) => jobs.push({ fn, ms });
  await service.start(); const socket = Socket.instances[0];
  assert.ok(socket.url.startsWith('wss://fstream.binance.com/market/stream?streams='));
  socket.open(); socket.message(fill()); socket.message(fill());
  assert.equal(service.snapshot().heatmap.count, 1);
  const oldMessage = socket.onmessage; socket.fail(); assert.equal(socket.closed, true);
  const retry = jobs.find(j => j.ms === 750); assert.ok(retry); retry.fn(); assert.equal(Socket.instances.length, 2);
  await service.stop(); oldMessage({ data: JSON.stringify(fill({ T: NOW - 1000 })) }); assert.equal(service.events.length, 1);
  assert.equal(service.snapshot().connection.stale, true);
});

test('market heartbeat detects frozen ticker socket without mistaking quiet liquidation activity for disconnect', async () => {
  let now = NOW; const Socket = fakeSocket(), service = createLiveMarketService({ WebSocketImpl: Socket, fetchImpl: async url => fixtures(url), now: () => now });
  const jobs = []; service.schedule = (fn, ms) => jobs.push({ fn, ms });
  await service.start(); const socket = Socket.instances[0]; socket.open();
  now += 40_000; socket.message({ e: '24hrTicker', s: 'BTCUSDT', c: '80300', P: '1' });
  jobs.find(j => j.ms === 5000).fn(); assert.equal(service.state.status, 'connected');
  now += 46_000; jobs.filter(j => j.ms === 5000).at(-1).fn(); assert.equal(service.state.status, 'retrying');
  assert.equal(service.gaps.BTCUSDT, 1); await service.stop();
});

test('provider/symbol changes abort old requests and cannot relabel old candles or prices', async () => {
  let release; const Socket = fakeSocket(), service = createLiveMarketService({ WebSocketImpl: Socket, fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
    release = resolve; signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }), now: () => NOW });
  await service.start(); await service.configure({ enabled: false, symbol: 'ETHUSDT' });
  release?.(Response.json(prices)); await flush();
  assert.equal(service.snapshot().heatmap.symbol, 'ETHUSDT'); assert.deepEqual(service.snapshot().heatmap.candles, []);
  await service.stop();
});

test('bounded local history survives restart with original wallpanel values and no API key; duplicates and expired rows are filtered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'air3-market-'));
  try {
    const service = createLiveMarketService({ dataDir: dir, config: { enabled: false, coinglassKey: 'never-save-this-key', wallpanelSource: 'external' }, now: () => NOW });
    await service.start(); service.ingestBinance(fill()); service.ingestBinance(fill());
    await service.setWallpanel({ title: 'AIRTrack', ttlSeconds: 120, trades: [{ id: 1, symbol: 'ETH', side: 'LONG', status: 'OPEN', entry_price: 3000 }],
      report: { totals: { open: 1, closed: 4 }, pnl_realized_pct_sum: 2.5 } }); await service.stop();
    const bytes = await readFile(join(dir, 'market-history.json'), 'utf8'); assert.equal(bytes.includes('never-save-this-key'), false);
    const restored = createLiveMarketService({ dataDir: dir, config: { enabled: false, wallpanelSource: 'external' }, now: () => NOW + 1000 });
    await restored.start(); const s = restored.snapshot(); assert.equal(s.heatmap.count, 1); assert.equal(s.wallpanel.selected.entry, 3000); assert.equal(s.wallpanel.report.pnlSum, 2.5);
    assert.equal(s.wallpanel.stale, false); await restored.stop();
    const expired = createLiveMarketService({ dataDir: dir, config: { enabled: false, wallpanelSource: 'external' }, now: () => NOW + 86_401_000 });
    await expired.start(); assert.equal(expired.snapshot().heatmap.count, 0); assert.equal(expired.snapshot().wallpanel.stale, true); await expired.stop();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid persisted history cannot supply future or synthetic-looking real records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'air3-market-invalid-'));
  try {
    await writeFile(join(dir, 'market-history.json'), JSON.stringify({ schema: 'air3.market-history.v1', events: [
      { symbol: 'BTCUSDT', time: NOW + 1e9, price: 9, quantity: 1, side: 'long' }, { symbol: 'OTHER', time: NOW, price: 9, quantity: 1, side: 'long' }] }));
    const service = createLiveMarketService({ dataDir: dir, config: { enabled: false }, now: () => NOW });
    await service.start(); assert.deepEqual(service.snapshot().heatmap.cells, []); await service.stop();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('demo is a separate explicit mode, watermarked in provenance, and never persists synthetic liquidation events', async () => {
  const service = createLiveMarketService({ config: { provider: 'demo' }, now: () => NOW });
  await service.start(); const s = service.snapshot(); assert.equal(s.demo, true); assert.equal(s.heatmap.kind, 'demo'); assert.ok(s.heatmap.cells.length > 100);
  assert.ok(s.heatmap.source.includes('DEMO')); assert.deepEqual(s.tickers, []); assert.equal(service.events.length, 0); await service.stop();
  assert.equal(demoMarketSnapshot(NOW).candles.length, 144); assert.notEqual(heatColor(0), heatColor(1)); assert.equal(heatColor(-1), heatColor(0));
});

test('renderer market client keeps prior real snapshot marked stale on failure, sends auth only to same-origin API, and disposes', async () => {
  const service = createLiveMarketService({ config: { enabled: false }, now: () => NOW }), snapshot = service.snapshot(), updates = [];
  let fail = false, lastHeaders;
  const client = createLiveMarketClient({ token: 'renderer-only-test', onUpdate: x => updates.push(x), pollMs: 100000,
    fetchImpl: async (url, opts) => { assert.equal(url, '/api/live/market'); lastHeaders = opts.headers; return fail ? Response.json({}, { status: 503 }) : Response.json(snapshot); } });
  client.start(); await flush(); await flush(); assert.equal(updates.length, 1); assert.equal(lastHeaders.Authorization, 'Bearer renderer-only-test');
  fail = true; await client.refresh(); assert.equal(updates.at(-1).connection.stale, true); assert.equal(updates.at(-1).demo, false); assert.equal(client.state().connected, false);
  client.stop(); assert.throws(() => createLiveMarketClient({ endpoint: 'https://evil.example/api', onUpdate() {} }));
});

test('renderer market client does not deliver a late response after teardown', async () => {
  let release, called = 0;
  const client = createLiveMarketClient({ onUpdate() { called++; }, fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  client.start(); client.stop(); release(Response.json(createLiveMarketService({ config: { enabled: false } }).snapshot())); await flush();
  assert.equal(called, 0); assert.equal(client.state().connected, false);
});
