import { FEEDS, TIMEFRAMES, normalizeApiBase, normalizeTrades, normalizeCandles, normalizeReport,
  websocketUrl, reconnectDelay, fetchJson } from './pure.mjs';

// GET-only data adapter. No trading mutation or wallet code is imported here.
// Existing dApp GET report/OHLCV handlers can persist derived metadata; this
// client does not change those handlers or assert that their DB path is pure.
export class MarketData {
  constructor(config, onChange) {
    this.base = normalizeApiBase(config.dappBaseUrl);
    this.onChange = onChange;
    this.state = { mode: 'track', timeframe: TIMEFRAMES.includes(config.defaultTimeframe) ? config.defaultTimeframe : '1h',
      trades: [], selected: null, candles: [], report: null, connection: 'disabled',
      fetchedAt: 0, chartAt: 0, reportAt: 0, error: '', chartError: '' };
    this.generation = 0;
    this.stopped = true;
    this.requests = new Map();
    this.timers = new Set();
    this.rotationPaused = false;
    this.nextRotationAt = Date.now() + 12_000;
  }

  emit() { this.onChange({ ...this.state }); }
  schedule(fn, ms) {
    const timer = setTimeout(() => { this.timers.delete(timer); if (!this.stopped) fn(); }, ms);
    this.timers.add(timer);
    return timer;
  }

  start(mode = this.state.mode) {
    this.stop();
    this.stopped = false;
    this.state = { ...this.state, mode: FEEDS[mode] ? mode : 'track', trades: [], selected: null, candles: [],
      report: null, fetchedAt: 0, chartAt: 0, reportAt: 0, error: '', chartError: '' };
    if (!this.base) { this.state.connection = 'disabled'; this.emit(); return; }
    this.state.connection = 'connecting';
    this.emit();
    this.refreshTrades();
    this.refreshReports();
    this.openSocket(0);
    const poll = () => { this.refreshTrades(); this.refreshReports(); this.schedule(poll, 30_000); };
    const chartPoll = () => { this.refreshChart(); this.schedule(chartPoll, 10_000); };
    const rotate = () => {
      if (!this.rotationPaused && Date.now() >= this.nextRotationAt) this.advance();
      this.schedule(rotate, 1000);
    };
    this.nextRotationAt = Date.now() + 12_000;
    this.schedule(poll, 30_000);
    this.schedule(chartPoll, 10_000);
    this.schedule(rotate, 1000);
  }

  stop() {
    this.stopped = true;
    this.generation++;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const controller of this.requests.values()) controller.abort();
    this.requests.clear();
    if (this.socket) {
      this.socket.onclose = this.socket.onmessage = this.socket.onerror = this.socket.onopen = null;
      this.socket.close();
      this.socket = null;
    }
  }

  async request(key, path, apply) {
    if (!this.base || this.stopped || this.requests.has(key)) return;
    const gen = this.generation;
    const controller = new AbortController();
    this.requests.set(key, controller);
    try {
      const data = await fetchJson(`${this.base}/${path}`, { signal: controller.signal });
      if (gen !== this.generation || controller.signal.aborted) return;
      apply(data);
      if (key !== 'chart') this.state.error = '';
      this.emit();
    } catch (error) {
      if (gen !== this.generation || controller.signal.aborted) return;
      if (key === 'chart') this.state.chartError = `OHLCV unavailable (${error.message})`;
      else this.state.error = `Public dApp request failed (${error.message})`;
      this.emit();
    } finally {
      if (this.requests.get(key) === controller) this.requests.delete(key);
    }
  }

  refreshTrades() {
    return this.request('trades', `${FEEDS[this.state.mode].trades}?statuses=OPEN,PENDING&limit=50&page=1`, (raw) => this.applyTrades(raw));
  }
  refreshReports() {
    return this.request('reports', `${FEEDS[this.state.mode].reports}?window=all`, (raw) => {
      this.state.report = normalizeReport(raw); this.state.reportAt = Date.now();
    });
  }

  applyTrades(raw) {
    this.state.trades = normalizeTrades(raw);
    this.state.fetchedAt = Date.now();
    const next = this.state.trades.find((t) => t.id === this.state.selected?.id) ?? this.state.trades[0] ?? null;
    this.select(next);
  }

  select(trade) {
    const changed = this.state.selected?.id !== trade?.id;
    this.state.selected = trade;
    if (changed) {
      this.requests.get('chart')?.abort(); this.requests.delete('chart');
      // Never pair the previous symbol's candles with a new trade label.
      this.state.candles = []; this.state.chartAt = 0; this.state.chartError = '';
      this.refreshChart();
    }
    this.emit();
  }

  advance() {
    const list = this.state.trades;
    if (list.length) {
      const index = list.findIndex((t) => t.id === this.state.selected?.id);
      this.select(list[(index + 1) % list.length]);
    }
    this.nextRotationAt = Date.now() + 12_000;
  }

  setPaused(paused) { this.rotationPaused = paused; this.nextRotationAt = Date.now() + 12_000; }
  setTimeframe(tf) {
    if (!TIMEFRAMES.includes(tf) || tf === this.state.timeframe) return;
    this.state.timeframe = tf;
    this.requests.get('chart')?.abort(); this.requests.delete('chart');
    this.state.candles = []; this.state.chartAt = 0;
    this.emit(); this.refreshChart();
  }
  refreshChart() {
    const selected = this.state.selected;
    if (!selected) return;
    const tf = this.state.timeframe;
    return this.request('chart', `${FEEDS[this.state.mode].trades}/${selected.id}/ohlcv?tf=${encodeURIComponent(tf)}`, (raw) => {
      if (selected.id !== this.state.selected?.id || tf !== this.state.timeframe) return;
      this.state.candles = normalizeCandles(raw); this.state.chartAt = Date.now(); this.state.chartError = '';
    });
  }

  openSocket(attempt) {
    if (this.stopped) return;
    const gen = this.generation;
    let ws;
    try { ws = new WebSocket(websocketUrl(this.base)); } catch {
      this.state.connection = 'retrying'; this.emit();
      this.schedule(() => this.openSocket(attempt + 1), reconnectDelay(attempt)); return;
    }
    this.socket = ws;
    ws.onopen = () => { if (gen === this.generation) { this.state.connection = 'connected'; this.emit(); this.refreshTrades(); } };
    ws.onmessage = ({ data }) => {
      if (gen !== this.generation || typeof data !== 'string' || data.length > 2 * 1024 * 1024) return;
      try {
        const message = JSON.parse(data);
        if (message.type === FEEDS[this.state.mode].event) {
          this.applyTrades(message.payload);
          // Coalesce refreshes; totals must follow snapshots during long broadcasts.
          this.refreshReports();
        }
      } catch { this.state.error = 'Ignored malformed market update'; this.emit(); }
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      if (gen !== this.generation || this.stopped) return;
      this.state.connection = 'retrying'; this.emit();
      this.schedule(() => this.openSocket(Math.min(attempt + 1, 8)), reconnectDelay(attempt));
    };
  }
}
