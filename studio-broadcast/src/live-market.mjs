import { mkdir, readFile, stat, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { finite, fetchJson, normalizeTrades, normalizeCandles, normalizeReport, reconnectDelay, timestamp } from '../public/pure.mjs';

// Read-only public feeds. No exchange credentials, orders, wallet, dApp server,
// or proprietary webpage scraping is involved. CoinGlass is opt-in via its API.
export const MARKET_DEFAULTS = Object.freeze({ enabled: true, provider: 'binance', symbol: 'BTCUSDT', range: '12h', wallpanelSource: 'market' });
export const MARKET_SYMBOLS = Object.freeze(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
const RANGE_MS = Object.freeze({ '12h': 43_200_000, '24h': 86_400_000, '3d': 259_200_000, '7d': 604_800_000 });
const KEEP_MS = 86_400_000, MAX_EVENTS = 100_000, MAX_CANDLES = 1_500;
const BINANCE_API = 'https://fapi.binance.com';
const COINGLASS_API = 'https://open-api-v4.coinglass.com/api/futures/liquidation/heatmap/model3';
const PERSIST_LIMIT = 32 * 1024 * 1024;
const copy = value => structuredClone(value);
const cleanText = (value, max = 160) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const positive = value => { const n = finite(value); return n !== null && n > 0 ? n : null; };
const timeValue = value => { const n = timestamp(value); return n !== null && n > 1_000_000_000_000 ? n : null; };
const intervalFor = range => range === '7d' ? '30m' : range === '3d' ? '15m' : '5m';
const intervalMs = interval => ({ '5m': 300_000, '15m': 900_000, '30m': 1_800_000 })[interval];

export function validateMarketConfig(input = {}, previous = MARKET_DEFAULTS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Market configuration must be an object');
  const value = { ...MARKET_DEFAULTS, ...previous };
  for (const key of ['enabled', 'provider', 'symbol', 'range', 'wallpanelSource', 'coinglassKey']) if (Object.hasOwn(input, key)) value[key] = input[key];
  if (typeof value.enabled !== 'boolean') throw new Error('Market enabled must be a boolean');
  if (!['binance', 'coinglass', 'demo'].includes(value.provider)) throw new Error('Unknown market provider');
  if (!MARKET_SYMBOLS.includes(value.symbol)) throw new Error('Unsupported market symbol');
  if (!Object.hasOwn(RANGE_MS, value.range)) throw new Error('Unsupported heatmap range');
  if (!['market', 'external'].includes(value.wallpanelSource)) throw new Error('Unknown wallpanel source');
  if (value.coinglassKey !== undefined && (typeof value.coinglassKey !== 'string' || value.coinglassKey.length > 512 || /[\s\x00-\x1f\x7f]/.test(value.coinglassKey))) {
    throw new Error('Invalid CoinGlass API key');
  }
  return value;
}

function candle(row) {
  if (!row || typeof row !== 'object') return null;
  const out = { time: timeValue(row.time), open: positive(row.open), high: positive(row.high), low: positive(row.low), close: positive(row.close) };
  if (Object.values(out).some(v => v === null) || out.high < Math.max(out.open, out.close, out.low) || out.low > Math.min(out.open, out.close, out.high)) return null;
  out.volume = Math.max(0, finite(row.volume) ?? 0);
  return out;
}
export function binanceCandles(raw) {
  if (!Array.isArray(raw)) throw new Error('Invalid Binance candle response');
  const byTime = new Map();
  for (const row of raw.slice(-MAX_CANDLES)) {
    const c = Array.isArray(row) && candle({ time: row[0], open: row[1], high: row[2], low: row[3], close: row[4], volume: row[5] });
    if (c) byTime.set(c.time, c);
  }
  if (raw.length && !byTime.size) throw new Error('Binance candles contain no valid prices');
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export function liquidationEvent(raw, now = Date.now()) {
  const data = raw?.data ?? raw, order = data?.o;
  if (data?.e !== 'forceOrder' || !order || order.X !== 'FILLED' || !MARKET_SYMBOLS.includes(order.s) || (data.st !== undefined && data.st !== 1)) return null;
  const time = timeValue(order.T ?? data.E), price = positive(order.ap);
  // Only executed notional. q is requested quantity and p is a limit, neither
  // may substitute a missing execution and make unfilled orders look executed.
  const quantity = positive(order.z);
  if (!time || time > now + 60_000 || time < now - KEEP_MS || !price || !quantity || !['SELL', 'BUY'].includes(order.S)) return null;
  const usd = quantity * price;
  if (!Number.isFinite(usd)) return null;
  return { id: `${order.s}:${time}:${order.S}:${price}:${quantity}`, symbol: order.s, time, price, quantity, usd,
    side: order.S === 'SELL' ? 'long' : 'short' };
}

function bounds(candles, points = []) {
  const values = [...candles.flatMap(c => [c.low, c.high]), ...points].filter(v => Number.isFinite(v) && v > 0);
  if (!values.length) return { minPrice: null, maxPrice: null };
  let min = Infinity, max = -Infinity;
  for (const v of values) { min = Math.min(min, v); max = Math.max(max, v); }
  const pad = Math.max((max - min) * .06, max * .001);
  return { minPrice: Math.max(Number.EPSILON, min - pad), maxPrice: max + pad };
}
function histogram(points, { from, to, minPrice, maxPrice, columns = 144, rows = 80, aggregation = 'sum' }) {
  if (!minPrice || !maxPrice || !(to > from)) return [];
  const bins = new Map();
  for (const p of points) {
    if (p.time < from || p.time > to || !(p.usd > 0)) continue;
    const x = Math.min(columns - 1, Math.max(0, Math.floor((p.time - from) / (to - from) * columns)));
    const y = Math.min(rows - 1, Math.max(0, Math.floor((p.price - minPrice) / (maxPrice - minPrice) * rows)));
    const index = y * columns + x;
    bins.set(index, aggregation === 'max' ? Math.max(bins.get(index) ?? 0, p.usd) : (bins.get(index) ?? 0) + p.usd);
  }
  return [...bins].map(([index, usd]) => [index % columns, Math.floor(index / columns), usd]);
}

export function observedHeatmap(events, candles, { symbol, range, now = Date.now(), collectedSince = null, lastEventAt = null, truncated = false, gaps = 0 } = {}) {
  const from = now - RANGE_MS[range], to = now, selected = events.filter(e => e.symbol === symbol && e.time >= from && e.time <= to);
  const prices = candles.filter(c => c.time >= from && c.time <= to);
  const rangeBounds = bounds(prices, selected.map(e => e.price));
  return { kind: 'observed-liquidations', title: 'LIQUIDAZIONI OSSERVATE', source: 'Binance USD-M · forceOrder', symbol, range,
    from, to, columns: 144, rows: 80, ...rangeBounds, candles: prices, cells: histogram(selected, { from, to, ...rangeBounds }),
    volumeUnit: 'USDT', count: selected.length, longUsd: selected.filter(e => e.side === 'long').reduce((s, e) => s + e.usd, 0),
    shortUsd: selected.filter(e => e.side === 'short').reduce((s, e) => s + e.usd, 0), collectedSince, lastEventAt,
    retainedFrom: Math.max(collectedSince ?? now, now - KEEP_MS, truncated && events.length ? events[0].time : 0), truncated, gaps,
    coverage: 'Ordini completati campionati: ultimo ordine per simbolo ogni 1 s; parziali esclusi. Non indica livelli futuri. Storico locale, massimo 24 h.' };
}

export function coinglassHeatmap(raw, { symbol, range, now = Date.now() } = {}) {
  if (String(raw?.code) !== '0' || !raw.data || !Array.isArray(raw.data.y_axis) || !Array.isArray(raw.data.liquidation_leverage_data) || !Array.isArray(raw.data.price_candlesticks)) {
    throw new Error('CoinGlass heatmap unavailable or invalid');
  }
  const source = raw.data;
  if (source.y_axis.length > 20_000 || source.price_candlesticks.length > 10_000 || source.liquidation_leverage_data.length > 500_000) throw new Error('CoinGlass response exceeds supported size');
  // Preserve source indices before filtering. Removing an invalid candle must
  // not shift every x coordinate onto the next candle.
  const indexedCandles = source.price_candlesticks.map(r => Array.isArray(r) ? candle({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }) : null);
  const candles = indexedCandles.filter(Boolean).sort((a, b) => a.time - b.time);
  if (!candles.length) throw new Error('CoinGlass returned no valid candles');
  const from = candles[0].time, step = candles.length > 1 ? Math.max(1, candles.at(-1).time - candles.at(-2).time) : 300_000;
  const to = candles.at(-1).time + step;
  const axis = source.y_axis.map(positive), rangeBounds = bounds(candles, axis);
  const points = [];
  for (const row of source.liquidation_leverage_data) {
    if (!Array.isArray(row) || !Number.isSafeInteger(row[0]) || !Number.isSafeInteger(row[1])) continue;
    const c = indexedCandles[row[0]], price = axis[row[1]], usd = positive(row[2]);
    if (c && price && usd) points.push({ time: c.time, price, usd });
  }
  return { kind: 'estimated-liquidation-levels', title: 'LIQUIDATION HEATMAP · MODEL 3', source: 'CoinGlass API · Model3', symbol, range,
    from, to, columns: 144, rows: 80, ...rangeBounds, candles: candles.slice(-1_500),
    cells: histogram(points, { from, to, ...rangeBounds, aggregation: 'max' }), volumeUnit: 'USD', count: null, longUsd: null, shortUsd: null,
    updatedAt: now, coverage: 'Livelli stimati dal modello CoinGlass, non liquidazioni eseguite. Accesso API Professional/Enterprise.' };
}

export function normalizeWallpanel(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Wallpanel payload must be an object');
  const out = { title: cleanText(input.title || 'WALLPANEL', 60), subtitle: cleanText(input.subtitle, 140), source: cleanText(input.source || 'Ingresso esterno', 80),
    updatedAt: now, sourceAt: timeValue(input.sourceAt ?? input.updatedAt), expiresAt: now + Math.min(86_400, Math.max(15, finite(input.ttlSeconds) ?? 300)) * 1_000,
    cards: [], rows: [], trades: [], candles: [], report: null, selected: null };
  if (Array.isArray(input.cards)) out.cards = input.cards.slice(0, 6).map(card => ({ label: cleanText(card?.label, 24),
    value: typeof card?.value === 'number' && Number.isFinite(card.value) ? String(card.value) : cleanText(card?.value, 32),
    tone: ['positive', 'negative', 'neutral'].includes(card?.tone) ? card.tone : 'neutral' })).filter(c => c.label);
  if (Array.isArray(input.rows)) out.rows = input.rows.slice(0, 8).map(row => ({ label: cleanText(row?.label, 40), value: cleanText(row?.value, 50),
    detail: cleanText(row?.detail, 100), tone: ['positive', 'negative', 'neutral'].includes(row?.tone) ? row.tone : 'neutral' })).filter(r => r.label);
  if (Array.isArray(input.trades) || Array.isArray(input.trades?.items)) out.trades = normalizeTrades((input.trades.items ?? input.trades).map(row => row && ({ ...row,
    entry_price: row.entry_price ?? row.entryPrice ?? row.entry, tp_price: row.tp_price ?? row.tpPrice ?? row.takeProfit,
    sl_price: row.sl_price ?? row.slPrice ?? row.stopLoss, unrealized_pnl_pct: row.unrealized_pnl_pct ?? row.pnlUnrealizedPct ?? row.pnl })));
  if (Array.isArray(input.candles) || Array.isArray(input.candles?.data)) out.candles = normalizeCandles(input.candles);
  if (input.report) out.report = normalizeReport(input.report.totals ? input.report : { totals: input.report, pnl_realized_pct_sum: input.report.pnlSum });
  const selectedId = finite(input.selectedId);
  out.selected = out.trades.find(t => t.id === selectedId) ?? out.trades[0] ?? null;
  // Do not accept an injected URL or HTML. The original AIRTrack DTO shapes
  // normalize through the same existing adapter used by the canvas wallboard.
  return out;
}

export function demoMarketSnapshot(now = Date.now(), symbol = 'BTCUSDT', range = '12h') {
  const center = { BTCUSDT: 82_000, ETHUSDT: 3_200, SOLUSDT: 175 }[symbol];
  const from = now - RANGE_MS[range], candles = [];
  for (let i = 0; i < 144; i++) {
    const o = center * (1 + .009 * Math.sin(i * .071) + .003 * Math.sin(i * .47));
    const c = o + center * .0014 * Math.sin(i * 1.4 + 1);
    candles.push({ time: from + i * RANGE_MS[range] / 144, open: o, close: c, high: Math.max(o, c) + center * .0007, low: Math.min(o, c) - center * .0007, volume: 0 });
  }
  const minPrice = center * .965, maxPrice = center * 1.035, cells = [];
  for (let y = 0; y < 80; y++) for (let x = 0; x < 144; x++) {
    const band = Math.pow(Math.max(0, Math.sin(y * .81 + Math.floor(x / 35) * .38)), 12);
    const level = band * (.24 + .76 * Math.pow(Math.cos(y * .19), 2)) * (1 + x / 144) * 2_000_000;
    if (level > 35_000) cells.push([x, y, level]);
  }
  return { kind: 'demo', title: 'HEATMAP · DEMO SINTETICA', source: 'DEMO · nessun dato di mercato', symbol, range, from, to: now,
    columns: 144, rows: 80, minPrice, maxPrice, candles, cells, volumeUnit: 'SIM', count: null, longUsd: null, shortUsd: null,
    updatedAt: now, coverage: 'Dati inventati esclusivamente per verificare grafica e regia. Non utilizzare per analisi di mercato.' };
}

export function createLiveMarketService(options = {}) { return new LiveMarketService(options); }
export class LiveMarketService {
  constructor({ dataDir, config = {}, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, now = Date.now, random = Math.random } = {}) {
    this.config = validateMarketConfig(config); this.fetchImpl = fetchImpl; this.WebSocketImpl = WebSocketImpl; this.now = now; this.random = random;
    this.file = dataDir ? resolve(dataDir, 'market-history.json') : null;
    this.events = []; this.eventIds = new Set(); this.tickers = new Map(); this.candles = new Map(); this.collectedSince = {};
    this.gaps = {}; this.truncated = false; this.externalWallpanel = null; this.cg = null;
    this.state = { status: 'stopped', error: '', connectedAt: null, lastMessageAt: null, lastCandleAt: null, lastEventAt: null, storageError: null };
    this.stopped = true; this.generation = 0; this.timers = new Set(); this.requests = new Map(); this.socket = null; this.loaded = false; this.saveQueue = Promise.resolve();
    this.startTask = null; this.configureQueue = Promise.resolve();
  }
  publicConfig() { const { coinglassKey, ...config } = this.config; return { ...config, coinglassConfigured: !!coinglassKey }; }
  schedule(fn, ms) { const timer = setTimeout(() => { this.timers.delete(timer); if (!this.stopped) Promise.resolve(fn()).catch(() => {}); }, ms); timer.unref?.(); this.timers.add(timer); return timer; }
  async load() {
    if (this.loaded) return; this.loaded = true;
    if (!this.file) return;
    try {
      if ((await stat(this.file)).size > PERSIST_LIMIT) throw new Error('market history too large');
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      if (raw?.schema !== 'air3.market-history.v1') throw new Error('unknown market history');
      const now = this.now();
      this.events = (Array.isArray(raw.events) ? raw.events : []).slice(-MAX_EVENTS).flatMap(e => {
        if (!e || !MARKET_SYMBOLS.includes(e.symbol) || !['long', 'short'].includes(e.side) || !positive(e.price) || !positive(e.quantity) || !timeValue(e.time) || e.time < now - KEEP_MS || e.time > now + 60_000) return [];
        const v = liquidationEvent({ e: 'forceOrder', o: { s: e.symbol, S: e.side === 'long' ? 'SELL' : 'BUY', X: 'FILLED', ap: e.price, z: e.quantity, T: e.time } }, now);
        return v ? [v] : [];
      });
      this.events.sort((a, b) => a.time - b.time);
      this.eventIds = new Set(this.events.map(e => e.id));
      this.events = [...new Map(this.events.map(e => [e.id, e])).values()];
      for (const symbol of MARKET_SYMBOLS) {
        if (timeValue(raw.collectedSince?.[symbol]) && raw.collectedSince[symbol] <= now) this.collectedSince[symbol] = raw.collectedSince[symbol];
        this.gaps[symbol] = Math.max(0, Math.min(1_000_000, finite(raw.gaps?.[symbol]) ?? 0));
      }
      this.truncated = !!raw.truncated;
      if (raw.wallpanel && raw.wallpanel.expiresAt > now) {
        this.externalWallpanel = normalizeWallpanel({ ...raw.wallpanel, selectedId: raw.wallpanel.selected?.id,
          ttlSeconds: (raw.wallpanel.expiresAt - now) / 1000 }, now);
        this.externalWallpanel.updatedAt = timeValue(raw.wallpanel.updatedAt) ?? now;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.state.storageError = 'Storico locale non leggibile; nuova raccolta avviata';
    }
  }
  prune() {
    const since = this.now() - KEEP_MS;
    this.events = this.events.filter(e => e.time >= since).sort((a, b) => a.time - b.time);
    if (this.events.length > MAX_EVENTS) { this.events = this.events.slice(-MAX_EVENTS); this.truncated = true; }
    this.eventIds = new Set(this.events.map(e => e.id));
  }
  async persist() {
    if (!this.file) return;
    this.prune();
    const payload = JSON.stringify({ schema: 'air3.market-history.v1', savedAt: this.now(), events: this.events,
      collectedSince: this.collectedSince, gaps: this.gaps, truncated: this.truncated, wallpanel: this.externalWallpanel });
    this.saveQueue = this.saveQueue.catch(() => {}).then(async () => {
      await mkdir(resolve(this.file, '..'), { recursive: true, mode: 0o700 });
      await writeFile(this.file + '.tmp', payload, { mode: 0o600 });
      await rename(this.file + '.tmp', this.file); this.state.storageError = null;
    }).catch(() => { this.state.storageError = 'Salvataggio storico non disponibile'; });
    return this.saveQueue;
  }
  async start() {
    if (this.startTask) return this.startTask;
    if (!this.stopped) return this.publicConfig();
    this.stopped = false; const generation = ++this.generation;
    const task = this.startAfterLoad(generation); this.startTask = task;
    try { return await task; } finally { if (this.startTask === task) this.startTask = null; }
  }
  async startAfterLoad(generation) {
    await this.load();
    if (this.stopped || this.generation !== generation) return this.publicConfig();
    this.state.error = '';
    if (!this.config.enabled) { this.state.status = 'disabled'; return this.publicConfig(); }
    const saveLoop = async () => { await this.persist(); this.schedule(saveLoop, 15_000); };
    this.schedule(saveLoop, 15_000);
    if (this.config.provider === 'demo') { this.state.status = 'demo'; return this.publicConfig(); }
    if (this.config.provider === 'coinglass') {
      this.state.status = this.config.coinglassKey ? 'connecting' : 'requires-key';
      if (!this.config.coinglassKey) { this.state.error = 'Inserire una chiave CoinGlass con accesso Model3'; return this.publicConfig(); }
      const poll = async () => { await this.refreshCoinGlass(); this.schedule(poll, 30_000); };
      void poll();
    } else { this.state.status = 'connecting'; this.openSocket(0); }
    const prices = async () => { await this.refreshPrices(); this.schedule(prices, 60_000); };
    void prices();
    return this.publicConfig();
  }
  async stop() {
    this.stopped = true; this.generation++;
    for (const timer of this.timers) clearTimeout(timer); this.timers.clear();
    for (const controller of this.requests.values()) controller.abort(); this.requests.clear();
    this.closeSocket(); this.state.status = 'stopped'; await this.startTask?.catch(() => {}); await this.persist();
  }
  closeSocket() {
    if (!this.socket) return;
    this.socket.onopen = this.socket.onmessage = this.socket.onerror = this.socket.onclose = null;
    try { this.socket.close(); } catch {} this.socket = null;
  }
  configure(input) {
    const task = this.configureQueue.then(async () => {
      const next = validateMarketConfig(input, this.config), running = !this.stopped, expectedGeneration = this.generation + 1;
      await this.stop(); this.config = next; this.cg = null;
      this.state = { ...this.state, status: 'stopped', error: '', connectedAt: null, lastMessageAt: null, lastCandleAt: null, lastEventAt: null };
      // A separate shutdown that happened while saving/loading must win over
      // this requested reconfiguration and prevent a late socket from opening.
      if (running && this.generation === expectedGeneration) await this.start();
      return this.publicConfig();
    });
    this.configureQueue = task.catch(() => {}); return task;
  }
  async setWallpanel(payload) { this.externalWallpanel = normalizeWallpanel(payload, this.now()); await this.persist(); return copy(this.externalWallpanel); }
  async request(key, url, headers, apply) {
    if (this.stopped || this.requests.has(key)) return;
    const gen = this.generation, controller = new AbortController(); this.requests.set(key, controller);
    try {
      const raw = await fetchJson(url, { headers, signal: controller.signal, redirect: 'error' }, { fetchImpl: this.fetchImpl, timeoutMs: 10_000, maxBytes: key === 'coinglass' ? 20 * 1024 * 1024 : 2 * 1024 * 1024 });
      if (this.stopped || gen !== this.generation || controller.signal.aborted) return;
      apply(raw);
    } catch (error) {
      if (this.stopped || gen !== this.generation || controller.signal.aborted) return;
      if (key === 'coinglass') { this.state.status = 'error'; this.state.error = /401|403/.test(error.message) ? 'Chiave o piano CoinGlass non abilitato a Model3' : 'CoinGlass non disponibile; dati precedenti marcati come non aggiornati'; }
      else this.state.error = 'Prezzi Binance non disponibili: verificare rete e disponibilità regionale';
    } finally { if (this.requests.get(key) === controller) this.requests.delete(key); }
  }
  async refreshPrices() {
    const symbol = this.config.symbol, interval = intervalFor(this.config.range), limit = Math.min(1_500, Math.ceil(RANGE_MS[this.config.range] / intervalMs(interval)) + 1);
    await Promise.allSettled([
      this.request('candles', `${BINANCE_API}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, {}, raw => {
        const rows = binanceCandles(raw), key = `${symbol}:${interval}`, existing = this.candles.get(key) ?? [];
        // An HTTP snapshot can complete after a newer WS candle. Merge by time;
        // do not overwrite the actively updating final candle with an old one.
        const byTime = new Map(rows.map(c => [c.time, c]));
        for (const c of existing) if (c.time >= (rows.at(-1)?.time ?? 0)) byTime.set(c.time, c);
        this.candles.set(key, [...byTime.values()].sort((a, b) => a.time - b.time).slice(-MAX_CANDLES)); this.state.lastCandleAt = this.now();
      }),
      ...MARKET_SYMBOLS.map(s => this.request('ticker:' + s, `${BINANCE_API}/fapi/v1/ticker/24hr?symbol=${s}`, {}, raw => this.applyTicker(raw, s))),
    ]);
  }
  applyTicker(raw, expected = raw?.s) {
    if (!MARKET_SYMBOLS.includes(expected) || ((raw?.symbol ?? raw?.s) !== expected)) return;
    const price = positive(raw.lastPrice ?? raw.c), changePct = finite(raw.priceChangePercent ?? raw.P);
    if (!price) return;
    this.tickers.set(expected, { symbol: expected, price, changePct, high: positive(raw.highPrice ?? raw.h), low: positive(raw.lowPrice ?? raw.l),
      volume: positive(raw.quoteVolume ?? raw.q), updatedAt: this.now(), source: 'Binance USD-M' });
  }
  async refreshCoinGlass() {
    if (!this.config.coinglassKey) return;
    const { symbol, range, coinglassKey } = this.config;
    await this.request('coinglass', `${COINGLASS_API}?exchange=Binance&symbol=${symbol}&range=${range}`, { 'CG-API-KEY': coinglassKey }, raw => {
      this.cg = coinglassHeatmap(raw, { symbol, range, now: this.now() }); this.state.status = 'connected'; this.state.error = ''; this.state.lastMessageAt = this.now();
    });
  }
  ingestBinance(raw) {
    const data = raw?.data ?? raw;
    if (!data || typeof data !== 'object') return;
    this.state.lastMessageAt = this.now();
    if (data.e === 'forceOrder') {
      const e = liquidationEvent(data, this.now());
      if (!e || e.symbol !== this.config.symbol || this.eventIds.has(e.id)) return;
      this.events.push(e); this.eventIds.add(e.id); this.state.lastEventAt = e.time;
      if (this.events.length > MAX_EVENTS) this.prune();
    } else if (data.e === 'kline' && data.s === this.config.symbol && data.k?.i === intervalFor(this.config.range)) {
      const k = data.k, c = candle({ time: k.t, open: k.o, high: k.h, low: k.l, close: k.c, volume: k.v });
      if (!c || c.time > this.now() + 60_000) return;
      const key = `${data.s}:${k.i}`, list = this.candles.get(key) ?? [], index = list.findIndex(old => old.time === c.time);
      if (index < 0) list.push(c); else list[index] = c;
      this.candles.set(key, list.sort((a, b) => a.time - b.time).slice(-MAX_CANDLES)); this.state.lastCandleAt = this.now();
    } else if (data.e === '24hrTicker') this.applyTicker(data);
  }
  openSocket(attempt) {
    if (this.stopped || this.config.provider !== 'binance') return;
    const gen = this.generation, streams = [`${this.config.symbol.toLowerCase()}@forceOrder`, `${this.config.symbol.toLowerCase()}@kline_${intervalFor(this.config.range)}`,
      ...MARKET_SYMBOLS.map(s => `${s.toLowerCase()}@ticker`)];
    let socket, lastActivity = this.now(), opened = false, reconnectScheduled = false;
    const reconnect = () => {
      if (reconnectScheduled || this.stopped || gen !== this.generation) return; reconnectScheduled = true;
      this.closeSocket(); this.state.status = 'retrying'; this.state.error = 'Feed Binance interrotto; riconnessione in corso';
      if (opened) this.gaps[this.config.symbol] = (this.gaps[this.config.symbol] ?? 0) + 1;
      this.schedule(() => this.openSocket(opened ? 0 : Math.min(attempt + 1, 8)), reconnectDelay(attempt, this.random));
    };
    try {
      // Current official USD-M streams namespace. No credentials in this URL.
      socket = new this.WebSocketImpl('wss://fstream.binance.com/market/stream?streams=' + streams.join('/'));
    } catch { reconnect(); return; }
    this.socket = socket;
    socket.onopen = () => {
      if (this.stopped || gen !== this.generation) return;
      opened = true; lastActivity = this.now(); this.state.status = 'connected'; this.state.error = ''; this.state.connectedAt = this.now();
      this.collectedSince[this.config.symbol] ??= this.now();
    };
    socket.onmessage = event => {
      if (this.stopped || gen !== this.generation || socket !== this.socket) return;
      lastActivity = this.now();
      if (typeof event.data !== 'string' || event.data.length > 512_000) return;
      try { const message = JSON.parse(event.data); if (message?.code !== undefined) { reconnect(); return; } this.ingestBinance(message); } catch {}
    };
    socket.onerror = reconnect; socket.onclose = reconnect;
    const heartbeat = () => {
      if (this.stopped || gen !== this.generation || socket !== this.socket) return;
      // Tickers/kline arrive at least once per few seconds even when there are
      // no liquidations. Native WebSocket answers protocol PING automatically.
      if (this.now() - lastActivity > (opened ? 45_000 : 15_000)) { reconnect(); return; }
      this.schedule(heartbeat, 5_000);
    };
    this.schedule(heartbeat, 5_000);
  }
  snapshot() {
    const now = this.now(), { provider, symbol, range, wallpanelSource } = this.config;
    const candles = (this.candles.get(`${symbol}:${intervalFor(range)}`) ?? []).slice();
    let heatmap;
    if (provider === 'demo') heatmap = demoMarketSnapshot(now, symbol, range);
    else if (provider === 'coinglass') heatmap = this.cg ? copy(this.cg) : { kind: 'estimated-liquidation-levels', title: 'LIQUIDATION HEATMAP · MODEL 3',
      source: 'CoinGlass API · Model3', symbol, range, columns: 144, rows: 80, cells: [], candles, minPrice: null, maxPrice: null,
      from: now - RANGE_MS[range], to: now, coverage: 'In attesa di dati CoinGlass autorizzati; nessun dato dimostrativo automatico.' };
    else heatmap = observedHeatmap(this.events, candles, { symbol, range, now, collectedSince: this.collectedSince[symbol] ?? null,
      lastEventAt: this.events.filter(e => e.symbol === symbol).at(-1)?.time ?? null, truncated: this.truncated, gaps: this.gaps[symbol] ?? 0 });
    const tickers = MARKET_SYMBOLS.map(s => this.tickers.get(s) ?? { symbol: s, price: null, changePct: null, updatedAt: null, source: 'Binance USD-M' });
    const stale = !this.config.enabled || this.stopped || (provider === 'binance' ? (this.state.status !== 'connected' || !this.state.lastMessageAt || now - this.state.lastMessageAt > 45_000)
      : provider === 'coinglass' ? (!heatmap.updatedAt || now - heatmap.updatedAt > 90_000 || this.state.status !== 'connected') : false);
    const wallpanel = wallpanelSource === 'external' ? { mode: 'external', ...copy(this.externalWallpanel ?? { title: 'WALLPANEL', source: 'Ingresso esterno', cards: [], rows: [], trades: [], candles: [], selected: null }),
      stale: !this.externalWallpanel || this.externalWallpanel.expiresAt <= now }
      : { mode: 'market', title: 'MARKET WALLPANEL', source: provider === 'demo' ? 'DEMO SINTETICA' : 'Binance USD-M',
        tickers: provider === 'demo' ? [] : tickers, candles: provider === 'demo' ? heatmap.candles : candles, symbol, updatedAt: this.state.lastCandleAt, stale: provider !== 'demo' && (!this.state.lastCandleAt || now - this.state.lastCandleAt > 90_000) };
    return { schema: 'air3.live-market.v1', generatedAt: now, provider, demo: provider === 'demo', config: this.publicConfig(),
      connection: { ...this.state, stale }, tickers: provider === 'demo' ? [] : copy(tickers), heatmap: { ...heatmap, stale }, wallpanel };
  }
}
