import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { loadDappBridgeConfig, createDappWallpanelBridge } from '../../adapters/dapp-wallpanel.mjs';
import { normalizeWallpanel } from '../src/live-market.mjs';

const TOKEN = 'test-producer-bridge-private-01234567890123456789';
const START = 1_800_000_000_000;
const trade = (id = 7, symbol = 'BTCUSDT') => ({ id, symbol, status: 'OPEN', side: 'LONG',
  entry_price: '64200.5', tp_price: '66000', sl_price: '62000', unrealized_pnl_pct: null, updated_at: 1_800_000_000 });
const candles = price => [{ time: 1_800_000_000, open: price, high: price + 20, low: price - 10, close: price + 5 }];
const REPORT = { totals: { open: 1, pending: 0, closed: 3, discarded: 0 }, pnl_realized_pct_sum: '4.2' };
const json = (value, options = {}) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' }, ...options });
const env = (patch = {}) => ({ AIR3_DAPP_BASE_URL: 'https://dapp.fixture/base', AIR3_LIVE_BASE_URL: 'http://127.0.0.1:5890', AIR3_PRODUCER_TOKEN: TOKEN, ...patch });

function fixture({ vars = {}, hook, clock = START, timers = false } = {}) {
  let time = clock, serial = 0;
  const calls = [], posts = [], scheduled = new Map(), events = [];
  const source = { trades: [trade()], candles: candles(64000), report: REPORT };
  const config = loadDappBridgeConfig(env(vars));
  const fetchImpl = async (url, options) => {
    const entry = { url: String(url), options, headers: new Headers(options.headers) }; calls.push(entry);
    const custom = await hook?.(entry, source); if (custom !== undefined) return custom;
    const parsed = new URL(url);
    if (options.method === 'POST') { const payload = JSON.parse(options.body); posts.push(payload); return json(normalizeWallpanel(payload, time)); }
    if (/\/(trades|trades-auto)$/.test(parsed.pathname)) return json({ items: source.trades });
    if (parsed.pathname.endsWith('/ohlcv')) return json({ data: source.candles });
    if (/\/(reports|reports-auto)$/.test(parsed.pathname)) return json(source.report);
    throw new Error('Unexpected fixture path');
  };
  const bridge = createDappWallpanelBridge({ config, fetchImpl, now: () => time, onStatus: status => events.push(status),
    ...(timers ? { setTimeoutImpl: (fn, ms) => { const id = ++serial; scheduled.set(id, { fn, ms }); return id; },
      clearTimeoutImpl: id => scheduled.delete(id) } : {}) });
  return { bridge, config, source, calls, posts, events, scheduled, advance: ms => { time += ms; },
    async fire() { const [id, timer] = scheduled.entries().next().value; scheduled.delete(id); time += timer.ms; timer.fn(); await nextTurn(); return timer.ms; } };
}

test('bridge configuration requires explicit public source and producer role, with bounded polling defaults', () => {
  const c = loadDappBridgeConfig(env());
  assert.equal(c.dappBase, 'https://dapp.fixture/base/api'); assert.equal(c.feed, 'track'); assert.equal(c.timeframe, '1h');
  assert.equal(c.pollMs, 4000); assert.equal(c.candlesMs, 15000); assert.equal(c.reportMs, 60000); assert.equal(c.ttlSeconds, 30); assert.equal(c.timeoutMs, 4000);
  assert.equal(loadDappBridgeConfig(env({ AIR3_DAPP_BASE_URL: 'https://dapp.fixture/api/' })).dappBase, 'https://dapp.fixture/api');
  assert.equal(loadDappBridgeConfig(env({ AIR3_LIVE_BASE_URL: '', AIR3_PORT: '6000' })).liveBase, 'http://127.0.0.1:6000');
  for (const patch of [
    { AIR3_DAPP_BASE_URL: '' }, { AIR3_DAPP_BASE_URL: 'file:///tmp/data' }, { AIR3_DAPP_BASE_URL: '/api' },
    { AIR3_DAPP_BASE_URL: 'https://name:password@dapp.fixture' }, { AIR3_DAPP_BASE_URL: 'https://dapp.fixture?token=secret' },
    { AIR3_LIVE_BASE_URL: 'https://live.fixture#key' }, { AIR3_PRODUCER_TOKEN: 'GENERATE_PRODUCER_TOKEN' },
    { AIR3_PRODUCER_TOKEN: TOKEN + '\n' }, { AIR3_DAPP_FEED: '__proto__' }, { AIR3_DAPP_FEED: 'unknown' },
    { AIR3_DAPP_TIMEFRAME: '2m' }, { AIR3_DAPP_POLL_MS: '0' }, { AIR3_DAPP_TIMEOUT_MS: 'Infinity' },
    { AIR3_DAPP_BRIDGE_TTL_SECONDS: '301' }, { AIR3_DAPP_ROTATE_SECONDS: '-1' },
  ]) assert.throws(() => loadDappBridgeConfig(env(patch)));
});

test('AIRTrack snapshots preserve actual prices and nulls; credentials go only to the bounded live POST', async () => {
  const f = fixture();
  f.source.trades.push({ id: 99, status: 'CLOSED' }, { id: 'invalid', status: 'OPEN' });
  f.source.candles.push({ time: 1_800_000_001, open: 10, high: 1, low: 2, close: 5 });
  assert.equal((await f.bridge.runOnce()).ok, true);
  assert.equal(f.calls.length, 4); assert.equal(f.posts.length, 1);
  const panel = f.posts[0];
  assert.equal(panel.title, 'AIRTrack'); assert.equal(panel.selectedId, 7); assert.equal(panel.trades.length, 1);
  assert.equal(panel.trades[0].entry, 64200.5); assert.equal(panel.trades[0].pnl, null);
  assert.equal(panel.trades[0].updatedAt, START); assert.equal(panel.candles.length, 1); assert.equal(panel.candles[0].close, 64005);
  assert.deepEqual(panel.report, { open: 1, pending: 0, closed: 3, discarded: 0, pnlSum: 4.2 });
  assert.equal(panel.sourceAt, START); assert.equal(panel.ttlSeconds, 30);
  const normalized = normalizeWallpanel(panel, START);
  assert.equal(normalized.selected.symbol, 'BTCUSDT'); assert.equal(normalized.selected.entry, 64200.5); assert.equal(normalized.report.pnlSum, 4.2);
  assert.ok(Buffer.byteLength(JSON.stringify(panel)) < 128 * 1024);
  for (const call of f.calls) {
    assert.equal(call.options.redirect, 'error'); assert.equal(call.options.credentials, 'omit'); assert.equal(call.options.cache, 'no-store');
    if (call.options.method === 'GET') { assert.equal(call.headers.has('Authorization'), false); assert.equal(call.url.startsWith(f.config.dappBase), true); }
    else { assert.equal(call.url, 'http://127.0.0.1:5890/api/live/wallpanel'); assert.equal(call.headers.get('Authorization'), 'Bearer ' + TOKEN); }
  }
  assert.match(f.calls[0].url, /trades\?statuses=OPEN,PENDING&limit=50&page=1$/);
  assert.ok(f.calls.some(c => c.url.endsWith('/reports?window=all')));
  assert.ok(f.calls.some(c => c.url.endsWith('/trades/7/ohlcv?tf=1h')));
  assert.equal(JSON.stringify(f.bridge.status()).includes(TOKEN), false);
});

test('auto feed is explicit and never falls back to AIRTrack on failure', async () => {
  let fail = false;
  const f = fixture({ vars: { AIR3_DAPP_FEED: 'auto' }, hook: call => fail && call.options.method === 'GET' ? new Response('private-provider-body', { status: 503 }) : undefined });
  assert.equal((await f.bridge.runOnce()).ok, true); assert.equal(f.posts[0].title, 'Auto-trading');
  assert.ok(f.calls.some(c => c.url.includes('/trades-auto/7/ohlcv'))); assert.ok(f.calls.some(c => c.url.includes('/reports-auto?')));
  fail = true; f.advance(4000); assert.equal((await f.bridge.runOnce()).ok, false); assert.equal(f.posts.length, 1);
  assert.equal(f.calls.some(c => /\/trades(?:\?|\/)/.test(c.url)), false);
  assert.equal(JSON.stringify(f.events).includes('private-provider-body'), false);
});

test('trade polling reuses candles for 15 seconds and reports for 60 seconds, with their ages disclosed', async () => {
  const f = fixture({ vars: { AIR3_DAPP_ROTATE_SECONDS: '0' } });
  await f.bridge.runOnce(); f.advance(4000); await f.bridge.runOnce();
  const chartCalls = () => f.calls.filter(c => c.url.includes('/ohlcv')).length;
  const reportCalls = () => f.calls.filter(c => c.url.includes('/reports?')).length;
  assert.equal(chartCalls(), 1); assert.equal(reportCalls(), 1); assert.match(f.posts[1].subtitle, /candele 4s · riepilogo 4s/);
  f.advance(12000); await f.bridge.runOnce(); assert.equal(chartCalls(), 2); assert.equal(reportCalls(), 1);
  f.advance(45000); await f.bridge.runOnce(); assert.equal(chartCalls(), 3); assert.equal(reportCalls(), 2);
  assert.equal(f.posts.length, 4);
});

test('a changed selection waits for its own candles; failure leaves the old snapshot to expire', async () => {
  let failNew = true;
  const f = fixture({ vars: { AIR3_DAPP_ROTATE_SECONDS: '0' }, hook: call => {
    if (call.url.includes('/trades/8/ohlcv') && failNew) return new Response('unavailable', { status: 502 });
  } });
  await f.bridge.runOnce(); const published = f.bridge.status().lastPublishedAt;
  f.source.trades = [trade(8, 'ETHUSDT')]; f.source.candles = candles(3000); f.advance(4000);
  assert.equal((await f.bridge.runOnce()).error, 'DAPP_CANDLES_FAILED'); assert.equal(f.posts.length, 1);
  assert.equal(f.bridge.status().lastPublishedAt, published); assert.equal(f.bridge.status().selectedId, 7);
  failNew = false; f.advance(4000); assert.equal((await f.bridge.runOnce()).ok, true);
  assert.equal(f.posts[1].selectedId, 8); assert.equal(f.posts[1].trades[0].symbol, 'ETHUSDT'); assert.equal(f.posts[1].candles[0].open, 3000);
  assert.equal(f.posts[1].candles.some(c => c.open === 64000), false);
  f.source.trades = []; f.advance(4000); await f.bridge.runOnce();
  assert.equal(f.posts[2].selectedId, null); assert.deepEqual(f.posts[2].candles, []); assert.deepEqual(f.posts[2].trades, []);
});

test('the default 12-second rotation retrieves candles for each newly selected signal', async () => {
  const f = fixture(); f.source.trades.push(trade(8, 'ETHUSDT'));
  await f.bridge.runOnce(); f.advance(8000); await f.bridge.runOnce(); f.advance(4000); await f.bridge.runOnce();
  assert.deepEqual(f.posts.map(p => p.selectedId), [7, 7, 8]);
  assert.ok(f.calls.some(c => c.url.endsWith('/trades/8/ohlcv?tf=1h')));
});

test('malformed, oversized or non-JSON source data never renews the wallpanel TTL', async () => {
  const cases = [
    { target: 'trades', response: () => json({ unexpected: [] }) },
    { target: 'trades', response: () => json([{ id: 'bad', status: 'OPEN' }]) },
    { target: 'trades', response: () => new Response('{private:malformed}') },
    { target: 'trades', response: () => new Response('[]', { headers: { 'content-length': '1048577' } }) },
    { target: 'trades', response: () => new Response(' '.repeat(1048577)) },
    { target: 'ohlcv', response: () => json([{ time: START, open: 10, close: 11, high: 1, low: 5 }]) },
    { target: 'reports', response: () => json({ totals: {} }) },
    { target: 'reports', response: () => json({ bad: 'provider-private-value' }) },
  ];
  for (const entry of cases) {
    const f = fixture({ hook: call => {
      const route = new URL(call.url).pathname;
      if (call.options.method === 'GET' && (entry.target === 'trades' ? route.endsWith('/trades') : route.includes(entry.target))) return entry.response();
    } });
    const result = await f.bridge.runOnce(); assert.equal(result.ok, false); assert.equal(f.posts.length, 0); assert.equal(f.bridge.status().lastPublishedAt, 0);
    assert.equal(JSON.stringify(f.events).includes('private'), false);
  }
});

test('failures back off 4/8/16/30 seconds, recover to normal cadence, and do not overlap requests', async () => {
  let failing = true, active = 0, maximum = 0;
  const f = fixture({ timers: true, hook: async call => {
    if (call.url.includes('/trades?')) { active++; maximum = Math.max(maximum, active); await nextTurn(); active--; if (failing) return new Response('', { status: 503 }); }
  } });
  const settled = async () => { for (let i = 0; i < 15 && !f.scheduled.size; i++) await nextTurn(); assert.equal(f.scheduled.size, 1); };
  f.bridge.start(); await settled(); const delays = [];
  for (let i = 0; i < 4; i++) { delays.push([...f.scheduled.values()][0].ms); await f.fire(); await settled(); }
  assert.deepEqual(delays, [4000, 8000, 16000, 30000]); assert.equal(maximum, 1); assert.equal(f.posts.length, 0);
  failing = false; await f.fire(); await settled(); assert.equal(f.bridge.status().failures, 0); assert.equal([...f.scheduled.values()][0].ms, 4000); assert.equal(f.posts.length, 1);
  f.bridge.stop(); assert.equal(f.scheduled.size, 0); assert.equal(f.bridge.status().phase, 'stopped');
});

test('manual poll calls join one in-flight cycle and stop prevents a late source response from publishing', async () => {
  let release;
  const f = fixture({ timers: true, hook: call => call.url.includes('/trades?') ? new Promise(resolve => { release = resolve; }) : undefined });
  const first = f.bridge.runOnce(), second = f.bridge.runOnce(); assert.equal(first, second);
  f.bridge.start(); f.bridge.stop();
  release(json({ items: [trade()] })); assert.equal((await first).error, 'STOPPED'); await nextTurn();
  assert.equal(f.posts.length, 0); assert.equal(f.calls.length, 1); assert.equal(f.scheduled.size, 0); assert.equal(f.bridge.status().phase, 'stopped');
});

test('request timeout aborts the source and destination errors expose only controlled codes', async () => {
  let aborted = false;
  const bridge = createDappWallpanelBridge({ config: { ...loadDappBridgeConfig(env()), timeoutMs: 20 },
    fetchImpl: (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('provider-secret-body')); }, { once: true })) });
  assert.equal((await bridge.runOnce()).error, 'DAPP_TRADES_FAILED'); assert.equal(aborted, true);
  const f = fixture({ hook: call => { if (call.options.method === 'POST') throw new Error('do not log ' + TOKEN); } });
  assert.equal((await f.bridge.runOnce()).error, 'LIVE_PUBLISH_FAILED'); assert.equal(f.bridge.status().lastPublishedAt, 0);
  assert.equal(JSON.stringify(f.events).includes(TOKEN), false); assert.equal(f.calls.filter(c => c.options.method === 'POST').length, 1);
});

test('real HTTP redirects are rejected before any destination can receive a forwarded producer token', async t => {
  let sinks = 0, sourceRedirect = false, posts = 0;
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    if (path === '/sink') { sinks++; res.end('{}'); return; }
    if (path === '/api/live/wallpanel') { posts++; res.writeHead(307, { Location: '/sink' }); res.end(); return; }
    if (sourceRedirect && path === '/api/trades') { res.writeHead(302, { Location: '/sink' }); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    if (path === '/api/trades') res.end(JSON.stringify({ items: [trade()] }));
    else if (path === '/api/reports') res.end(JSON.stringify(REPORT));
    else if (path === '/api/trades/7/ohlcv') res.end(JSON.stringify(candles(64000)));
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const bridge = createDappWallpanelBridge({ config: loadDappBridgeConfig(env({ AIR3_DAPP_BASE_URL: base, AIR3_LIVE_BASE_URL: base })) });
  assert.equal((await bridge.runOnce()).error, 'LIVE_PUBLISH_FAILED'); assert.equal(posts, 1); assert.equal(sinks, 0);
  sourceRedirect = true; assert.equal((await bridge.runOnce()).error, 'DAPP_TRADES_FAILED'); assert.equal(posts, 1); assert.equal(sinks, 0);
});
