// Shared, side-effect-free validation for public market data and player payloads.
export const TIMEFRAMES = Object.freeze(['1m', '5m', '15m', '30m', '1h', '4h', '1d']);
export const FEEDS = Object.freeze({
  track: { label: 'AIRTrack', trades: 'trades', reports: 'reports', event: 'tradeUpdate' },
  auto: { label: 'Auto-trading', trades: 'trades-auto', reports: 'reports-auto', event: 'autoTradeUpdate' },
});

export function finite(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function timestamp(value) {
  const n = finite(value);
  if (n !== null && n > 0) return n < 1e11 ? n * 1000 : n;
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isFinite(t) && t > 0 ? t : null;
}

export function normalizeTrades(raw) {
  const rows = Array.isArray(raw) ? raw : raw?.items ?? raw?.trades;
  if (!Array.isArray(rows)) throw new Error('Invalid trade snapshot');
  const seen = new Set();
  return rows.slice(0, 2000).flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const id = finite(row.id);
    const status = String(row.status ?? '').toUpperCase();
    const side = String(row.side ?? '').toUpperCase();
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id) || !['OPEN', 'PENDING'].includes(status)) return [];
    seen.add(id);
    return [{
      id,
      symbol: String(row.symbol ?? '').slice(0, 64) || 'Unknown symbol',
      side: ['LONG', 'SHORT'].includes(side) ? side : 'UNKNOWN',
      status,
      entry: finite(row.entry_price ?? row.entryPrice),
      takeProfit: finite(row.tp_price ?? row.tpPrice),
      stopLoss: finite(row.sl_price ?? row.slPrice),
      pnl: finite(row.unrealized_pnl_pct ?? row.pnl_unrealized_pct ?? row.pnlUnrealizedPct),
      updatedAt: timestamp(row.updated_at ?? row.updatedAt),
    }];
  }).slice(0, 50);
}

export function normalizeCandles(raw) {
  const rows = Array.isArray(raw) ? raw : raw?.data;
  if (!Array.isArray(rows)) throw new Error('Invalid OHLCV response');
  const byTime = new Map();
  for (const row of rows.slice(-2000)) {
    const time = timestamp(row?.time);
    const open = finite(row?.open), high = finite(row?.high), low = finite(row?.low), close = finite(row?.close);
    if (time === null || [open, high, low, close].some((v) => v === null || v <= 0)) continue;
    if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) continue;
    byTime.set(time, { time, open, high, low, close });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-100);
}

export function normalizeReport(raw) {
  if (!raw || typeof raw !== 'object' || !raw.totals || typeof raw.totals !== 'object') {
    throw new Error('Invalid report response');
  }
  const count = (key) => {
    const n = finite(raw.totals[key]);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  };
  return { open: count('open'), pending: count('pending'), closed: count('closed'),
    discarded: count('discarded'), pnlSum: finite(raw.pnl_realized_pct_sum) };
}

export function normalizeApiBase(value) {
  if (!value) return null;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('dApp URL must be an HTTP(S) base without credentials, query or fragment');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/api') ? path : `${path}/api`;
  return url.href.replace(/\/$/, '');
}

export function websocketUrl(base) {
  const url = new URL(base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = url.pathname.replace(/\/api$/, '') + '/ws';
  return url.href;
}

export function reconnectDelay(attempt, random = Math.random) {
  const capped = Math.min(30_000, 750 * 2 ** Math.min(8, Math.max(0, attempt)));
  return Math.round(capped * (0.8 + 0.4 * random()));
}

export function isStale(updatedAt, now = Date.now(), maxAge = 45_000) {
  return !Number.isFinite(updatedAt) || updatedAt <= 0 || now - updatedAt > maxAge;
}

export function safeAudioPath(job) {
  if (!job || typeof job.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(job.id)) {
    throw new Error('Invalid narration identifier');
  }
  const expected = `/api/audio/${encodeURIComponent(job.id)}`;
  if (job.audioPath !== expected) throw new Error('Untrusted audio path');
  if (typeof job.leaseToken !== 'string' || job.leaseToken.length < 8) throw new Error('Invalid playback lease');
  return expected;
}

export function numberLabel(value, options = {}) {
  if (value === null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: value !== 0 && Math.abs(value) < 1 ? 6 : 2, ...options }).format(value);
}

export function ageLabel(updatedAt, now = Date.now()) {
  if (!updatedAt) return 'never received';
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
  return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`;
}

export async function boundedFetch(url, options = {}, { timeoutMs = 8000, maxBytes = 2 * 1024 * 1024, fetchImpl = fetch } = {}) {
  const aborter = new AbortController();
  const external = options.signal;
  const abort = () => aborter.abort(external?.reason);
  if (external?.aborted) abort();
  else external?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => aborter.abort(new Error('Request timeout')), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: aborter.signal, credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length'));
    if (declared > maxBytes) throw new Error('Response too large');
    const chunks = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel(); throw new Error('Response too large'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', abort);
  }
}

export async function fetchJson(url, options = {}, bounds = {}) {
  const bytes = await boundedFetch(url, { ...options, headers: { Accept: 'application/json', ...options.headers } }, bounds);
  return JSON.parse(new TextDecoder().decode(bytes));
}
