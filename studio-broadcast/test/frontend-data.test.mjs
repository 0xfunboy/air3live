import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandles, normalizeTrades, normalizeReport, normalizeApiBase, websocketUrl,
  reconnectDelay, isStale, safeAudioPath, boundedFetch } from '../public/pure.mjs';
import { MarketData } from '../public/data.mjs';

test('missing financial values stay unknown; invalid trades are rejected', () => {
  const rows = normalizeTrades([{ id: 1, symbol: 'ETH', status: 'OPEN', side: 'LONG', entry_price: null },
    { id: 2, symbol: 'BTC', status: 'CLOSED' }, { id: 1, status: 'OPEN' }, { id: 'bad', status: 'OPEN' }]);
  assert.equal(rows.length, 1); assert.equal(rows[0].entry, null); assert.equal(rows[0].pnl, null);
  assert.equal(normalizeReport({ totals: { open: 0 } }).open, 0);
  assert.equal(normalizeReport({ totals: { open: 0 } }).pnlSum, null);
  assert.equal(normalizeReport({ totals: { open: 0 } }).closed, null);
});

test('OHLCV accepts valid candles only, deduplicates time and sorts without invented prices', () => {
  const time = 1_790_000_000_000;
  const rows = normalizeCandles({ data: [
    { time: time + 60_000, open: 10, high: 12, low: 9, close: 11 },
    { time, open: 10, high: 11, low: 9, close: 10 },
    { time, open: 11, high: 13, low: 10, close: 12 },
    { time: time + 1, open: 10, high: 1, low: 9, close: 11 },
    { time: time + 2, open: null, high: 12, low: 9, close: 11 },
    { time: 'invalid', open: 10, high: 12, low: 9, close: 11 },
  ] });
  assert.equal(rows.length, 2); assert.equal(rows[0].time, time); assert.equal(rows[0].close, 12);
  assert.equal(rows[1].time, time + 60_000);
});

test('dApp base and socket endpoints preserve prefix and never accept embedded credentials', () => {
  assert.equal(normalizeApiBase('https://example.com'), 'https://example.com/api');
  assert.equal(normalizeApiBase('https://example.com/'), 'https://example.com/api');
  assert.equal(normalizeApiBase('https://example.com/prefix/'), 'https://example.com/prefix/api');
  assert.equal(websocketUrl('https://example.com/prefix/api'), 'wss://example.com/prefix/ws');
  assert.equal(normalizeApiBase(null), null);
  for (const value of ['https://secret@example.com', 'file:///x', 'https://example.com?token=bad']) assert.throws(() => normalizeApiBase(value));
});

test('staleness and backoff have finite predictable bounds', () => {
  assert.equal(isStale(0, 50_000), true); assert.equal(isStale(10_000, 50_000), false);
  assert.equal(isStale(10_000, 56_000), true);
  assert.equal(reconnectDelay(0, () => .5), 750); assert.equal(reconnectDelay(100, () => .5), 30_000);
});

test('narration audio is restricted to the exact same-origin job path', () => {
  const job = { id: 'eliza.1-abc', leaseToken: 'lease-12345678', audioPath: '/api/audio/eliza.1-abc' };
  assert.equal(safeAudioPath(job), job.audioPath);
  assert.throws(() => safeAudioPath({ ...job, audioPath: 'https://foreign.example/a.wav' }));
  assert.throws(() => safeAudioPath({ ...job, id: '../other' }));
});

test('bounded fetch rejects an oversized chunked response before reading the full body', async () => {
  const fetchImpl = async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(100)); c.enqueue(new Uint8Array(100)); c.close(); },
  }));
  await assert.rejects(boundedFetch('/x', {}, { fetchImpl, maxBytes: 120 }), /too large/);
});

test('selection and timeframe changes clear previous candles before new data arrives', () => {
  const adapter = new MarketData({ dappBaseUrl: 'https://example.test', defaultTimeframe: '1h' }, () => {});
  adapter.refreshChart = () => {};
  adapter.state.selected = { id: 1 }; adapter.state.candles = [{ close: 100 }]; adapter.state.chartAt = 5;
  adapter.select({ id: 2 });
  assert.deepEqual(adapter.state.candles, []); assert.equal(adapter.state.chartAt, 0);
  adapter.state.candles = [{ close: 101 }]; adapter.setTimeframe('4h');
  assert.deepEqual(adapter.state.candles, []); assert.equal(adapter.state.timeframe, '4h');
  adapter.stop();
});

test('stopped data adapter cannot apply a late network response', async () => {
  const original = globalThis.fetch;
  let resolveResponse;
  globalThis.fetch = () => new Promise((resolve) => { resolveResponse = resolve; });
  const adapter = new MarketData({ dappBaseUrl: 'https://example.test' }, () => {});
  adapter.stopped = false;
  const request = adapter.refreshTrades();
  adapter.stop();
  resolveResponse(Response.json({ items: [{ id: 1, status: 'OPEN', symbol: 'OLD' }] }));
  await request;
  assert.deepEqual(adapter.state.trades, []);
  globalThis.fetch = original;
});

test('adapter accepts the original dApp HTTP and WebSocket DTO forms without changing report semantics', () => {
  // Matches server/src/index.ts toClientTrade, both GET listings and WS payloads.
  const trade = { id: 41, symbol: 'ETH', quote: 'USD', side: 'SHORT', status: 'PENDING',
    entry_price: 2500, tp_price: 2400, sl_price: 2550, pnl_unrealized_pct: -1.25,
    created_at: '2026-10-24T03:00:00.000Z', updated_at: '2026-10-24T03:01:00.000Z' };
  assert.deepEqual(normalizeTrades({ items: [trade], total: 1 }), normalizeTrades([trade]));
  const result = normalizeTrades([trade])[0];
  assert.equal(result.entry, 2500); assert.equal(result.pnl, -1.25);
  assert.equal(result.updatedAt, Date.parse(trade.updated_at));
  const candle = { time: 1_790_000_000_000, open: 2500, high: 2600, low: 2400, close: 2520, volume: 100 };
  assert.equal(normalizeCandles({ symbol: 'ETH', tf: '1h', data: [candle] })[0].close, 2520);
  const totals = { open: 2, pending: 1, closed: 8, discarded: 3 };
  assert.equal(normalizeReport({ totals, pnl_realized_pct_sum: 4.5 }).pnlSum, 4.5);
  // Auto uses a size-normalized cumulative metric under the legacy *_sum key.
  assert.equal(normalizeReport({ totals, pnl_realized_pct_sum: 3.7, pnl_realized_pct_weighted_avg: .4625,
    pnl_realized_usd_sum: 100, pnl_realized_size_usd_sum: 21621.62 }).pnlSum, 3.7);
});
