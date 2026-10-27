import { ageLabel, numberLabel } from './pure.mjs';

const C = { bg: '#070c17', panel: '#111c2b', line: '#213346', text: '#eef6ff', muted: '#8fa4bd', cyan: '#64dceb', green: '#50d5ad', red: '#ff6f96', amber: '#f2cb80' };
const font = (size = 22, weight = 400) => `${weight} ${size}px system-ui, sans-serif`;
const compact = value => Number.isFinite(value) ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value) : '—';
const utc = time => time ? new Date(time).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) : '—';
const date = time => time ? new Date(time).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) : '—';
function text(ctx, value, x, y, size = 22, color = C.text, weight = 400, maxWidth) {
  ctx.font = font(size, weight); ctx.fillStyle = color;
  let label = String(value ?? '');
  if (maxWidth) while (label.length > 1 && ctx.measureText(label).width > maxWidth) label = label.slice(0, -2) + '…';
  ctx.fillText(label, x, y);
}
function frame(ctx, title, badge = '', tone = C.cyan) {
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, 1024, 576);
  const gradient = ctx.createLinearGradient(0, 0, 1024, 160); gradient.addColorStop(0, '#132435'); gradient.addColorStop(1, C.bg);
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1024, 94);
  ctx.fillStyle = C.cyan; ctx.fillRect(30, 25, 4, 28);
  text(ctx, title, 49, 48, 25, C.text, 700, 740);
  if (badge) { ctx.fillStyle = tone + '20'; ctx.fillRect(820, 23, 174, 36); text(ctx, badge, 834, 48, 17, tone, 700, 150); }
  ctx.fillStyle = C.line; ctx.fillRect(30, 76, 964, 1);
}
function status(snapshot) { return snapshot?.demo ? ['DEMO', C.amber] : snapshot?.connection?.status === 'disabled' ? ['DISATTIVATO', C.muted]
  : snapshot?.connection?.stale ? ['DATI SCADUTI', C.amber] : ['DATI LIVE', C.green]; }
function empty(ctx, title, note, x = 54, y = 280, width = 900) {
  text(ctx, title, x, y, 28, C.text, 650, width); text(ctx, note, x, y + 38, 19, C.muted, 400, width);
}
function multiline(ctx, value, x, y, width, lines = 4, size = 22, color = C.text) {
  ctx.font = font(size); const words = String(value ?? '').split(/\s+/); let line = '', row = 0;
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > width && line) { text(ctx, line, x, y + row * (size + 9), size, color, 400, width); row++; line = word; }
    else line = next;
    if (row >= lines - 1) { text(ctx, [line, ...words.slice(index + 1)].join(' '), x, y + row * (size + 9), size, color, 400, width); return; }
  }
  if (line) text(ctx, line, x, y + row * (size + 9), size, color, 400, width);
}
function line(ctx, x1, y1, x2, y2, color = C.line, width = 1) { ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }

function chart(ctx, candles, rect, { minPrice, maxPrice, from, to, levels = [], axes = true, grid = true } = {}) {
  const rows = (candles ?? []).filter(c => Number.isFinite(c?.time) && [c.open, c.high, c.low, c.close].every(Number.isFinite));
  if (!rows.length) return false;
  let min = minPrice ?? Math.min(...rows.map(c => c.low)), max = maxPrice ?? Math.max(...rows.map(c => c.high));
  if (!Number.isFinite(min) || !Number.isFinite(max)) return false;
  const pad = Math.max((max - min) * .08, max * .0005);
  if (minPrice == null) min -= pad; if (maxPrice == null) max += pad;
  if (!(max > min)) return false;
  const first = from ?? rows[0].time, last = to ?? rows.at(-1).time + (rows.length > 1 ? rows[1].time - rows[0].time : 300_000);
  if (!(last > first)) return false;
  const { x, y, w, h } = rect, px = time => x + (time - first) / (last - first) * w, py = price => y + h - (price - min) / (max - min) * h;
  if (grid || axes) for (let n = 0; n <= 4; n++) {
    const yy = y + h * n / 4, p = max - (max - min) * n / 4;
    if (grid) line(ctx, x, yy, x + w, yy);
    if (axes) text(ctx, numberLabel(p, { maximumFractionDigits: p > 1000 ? 0 : 2 }), x + w + 8, yy + 5, 15, C.muted);
  }
  if (axes) for (let n = 0; n <= 4; n++) text(ctx, utc(first + (last - first) * n / 4), x + w * n / 4 - 16, y + h + 23, 14, C.muted);
  const body = Math.max(1, Math.min(7, w / rows.length * .58));
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  for (const c of rows) {
    const xx = px(c.time), color = c.close >= c.open ? C.green : C.red;
    line(ctx, xx, py(c.high), xx, py(c.low), '#061019', 3.2);
    line(ctx, xx, py(c.high), xx, py(c.low), color, 1.2);
    ctx.fillStyle = '#061019'; ctx.fillRect(xx - body / 2 - 1, py(Math.max(c.open, c.close)) - 1, body + 2, Math.max(2, Math.abs(py(c.open) - py(c.close))) + 2);
    ctx.fillStyle = color; ctx.fillRect(xx - body / 2, py(Math.max(c.open, c.close)), body, Math.max(2, Math.abs(py(c.open) - py(c.close))));
  }
  for (const l of levels) {
    if (!Number.isFinite(l.value) || l.value < min || l.value > max) continue;
    ctx.setLineDash([6, 5]); line(ctx, x, py(l.value), x + w, py(l.value), l.color, 1.2); ctx.setLineDash([]);
    text(ctx, `${l.name} ${numberLabel(l.value)}`, x + 8, py(l.value) - 5, 14, l.color);
  }
  ctx.restore();
  return true;
}

export function heatColor(intensity) {
  const palette = [[41, 4, 66], [67, 28, 111], [44, 96, 140], [32, 159, 137], [112, 207, 87], [241, 235, 52]];
  const x = Math.max(0, Math.min(1, Number.isFinite(intensity) ? intensity : 0)) * (palette.length - 1), i = Math.min(palette.length - 2, Math.floor(x)), f = x - i;
  return `rgb(${palette[i].map((v, n) => Math.round(v + (palette[i + 1][n] - v) * f)).join(',')})`;
}

export function drawLiveHeatmap(ctx, snapshot) {
  const h = snapshot.heatmap, [badge, tone] = status(snapshot);
  frame(ctx, `${h.symbol} · ${h.title}`, badge, tone);
  text(ctx, h.source, 32, 105, 19, C.muted, 450, 630);
  text(ctx, h.range + ' · UTC', 850, 105, 18, C.muted);
  if (h.kind === 'observed-liquidations') {
    text(ctx, `LONG  ${compact(h.longUsd)} USDT`, 32, 139, 18, C.green, 600);
    text(ctx, `SHORT  ${compact(h.shortUsd)} USDT`, 290, 139, 18, C.red, 600);
    text(ctx, `${h.count ?? 0} ordini completati campionati`, 575, 139, 18, C.muted, 400, 415);
  } else text(ctx, h.kind === 'demo' ? 'Dati sintetici per la prova grafica' : 'Livelli di liquidazione stimati · scala logaritmica', 32, 139, 18, h.kind === 'demo' ? C.amber : C.muted);
  const plot = { x: 76, y: 173, w: 827, h: 312 };
  ctx.fillStyle = '#25043d'; ctx.fillRect(plot.x, plot.y, plot.w, plot.h);
  const max = Math.max(0, ...(h.cells ?? []).map(cell => cell[2]));
  ctx.save(); ctx.beginPath(); ctx.rect(plot.x, plot.y, plot.w, plot.h); ctx.clip();
  if (max > 0) for (const [x, y, value] of h.cells ?? []) {
    if (![x, y, value].every(Number.isFinite) || x < 0 || x >= h.columns || y < 0 || y >= h.rows || !(value > 0)) continue;
    ctx.fillStyle = heatColor(Math.log1p(value) / Math.log1p(max));
    ctx.fillRect(plot.x + x * plot.w / h.columns, plot.y + plot.h - (y + 1) * plot.h / h.rows, Math.ceil(plot.w / h.columns), Math.ceil(plot.h / h.rows));
  }
  ctx.restore();
  for (let n = 0; n < 128; n++) { ctx.fillStyle = heatColor(1 - n / 127); ctx.fillRect(28, plot.y + n * plot.h / 128, 15, plot.h / 128 + 1); }
  text(ctx, compact(max), 17, 162, 14, C.muted); text(ctx, '0', 32, 506, 14, C.muted);
  const hasPrices = chart(ctx, h.candles, plot, { minPrice: h.minPrice, maxPrice: h.maxPrice, from: h.from, to: h.to, axes: true, grid: false });
  if (!hasPrices) empty(ctx, snapshot.connection.status === 'requires-key' ? 'COLLEGA COINGLASS MODEL 3' : 'IN ATTESA DI DATI DI MERCATO',
    snapshot.connection.status === 'requires-key' ? 'Serve una chiave API abilitata a Model3.' : 'Il grafico compare quando arrivano prezzi verificati.', 106, 300, 750);
  else if (!h.cells?.length) {
    ctx.fillStyle = '#071320d9'; ctx.fillRect(187, 187, 560, 54);
    text(ctx, h.kind === 'observed-liquidations' ? 'Nessun evento raccolto in questa finestra' : 'Nessun livello disponibile', 206, 221, 19, C.text, 500, 525);
  }
  if (snapshot.demo) {
    ctx.save(); ctx.globalAlpha = .17; text(ctx, 'DEMO', 387, 362, 80, '#ffffff', 800); ctx.restore();
  }
  const collection = h.kind === 'observed-liquidations' ? `Raccolta dal ${date(h.collectedSince)} UTC · ${h.gaps ?? 0} interruzioni`
    : h.kind === 'demo' ? 'DEMO SINTETICA · NON SONO DATI REALI' : `Aggiornato ${ageLabel(h.updatedAt)} · CoinGlass API`;
  text(ctx, collection, 32, 539, 17, snapshot.demo ? C.amber : C.muted, 500, 960);
  text(ctx, h.kind === 'observed-liquidations' ? 'Campione pubblico 1 s · ordini eseguiti, non livelli futuri · scala log USDT'
    : h.kind === 'demo' ? 'Selezionare Binance o CoinGlass per dati di mercato.' : 'Stima del modello · non liquidazioni già eseguite · scala log USD', 32, 562, 14, C.muted, 400, 960);
}

function fallbackWallboard(m) {
  return m?.selected ? { mode: 'external', title: `${m.mode === 'auto' ? 'AUTO-TRADING' : 'AIRTRACK'} WALLPANEL`, source: 'dApp · adattatore dati',
    updatedAt: m.fetchedAt, stale: !m.fetchedAt || Date.now() - m.fetchedAt > 45_000, selected: m.selected, trades: m.trades, candles: m.candles,
    report: m.report, cards: [], rows: [] } : null;
}
export function drawLiveWallpanel(ctx, snapshot, legacyMarket = null) {
  let w = snapshot.wallpanel;
  if (w.mode === 'external' && !w.updatedAt && legacyMarket?.selected) w = fallbackWallboard(legacyMarket);
  const badge = snapshot.demo && w.mode === 'market' ? 'DEMO' : w.stale ? 'DATI SCADUTI' : w.mode === 'external' ? 'WALLPANEL' : 'DATI LIVE';
  frame(ctx, w.title || 'WALLPANEL', badge, w.stale || snapshot.demo ? C.amber : C.green);
  text(ctx, w.source || 'Ingresso esterno', 32, 104, 18, C.muted, 450, 920);
  if (w.mode === 'external') {
    if (!w.updatedAt) { empty(ctx, 'WALLPANEL IN ATTESA', 'Collegare AIRTrack oppure inviare uno snapshot al modulo live.'); return; }
    if (w.selected && w.candles?.length) {
      const t = w.selected;
      ctx.fillStyle = C.panel; ctx.fillRect(32, 125, 270, 285);
      text(ctx, t.symbol, 49, 161, 31, C.text, 700, 235);
      text(ctx, `${t.side} · ${t.status}`, 49, 192, 18, t.side === 'SHORT' ? C.red : C.green, 600, 235);
      [['ENTRY', t.entry], ['TAKE PROFIT', t.takeProfit], ['STOP LOSS', t.stopLoss], ['PNL %', t.pnl]].forEach(([label, value], i) => {
        text(ctx, label, 49, 236 + i * 45, 13, C.muted); text(ctx, numberLabel(value), 162, 236 + i * 45, 19, C.text, 600, 126);
      });
      chart(ctx, w.candles, { x: 330, y: 145, w: 570, h: 268 }, { levels: [
        { name: 'ENTRY', value: t.entry, color: C.cyan }, { name: 'TP', value: t.takeProfit, color: C.green }, { name: 'SL', value: t.stopLoss, color: C.red }] });
      (w.trades ?? []).slice(0, 3).forEach((row, i) => {
        const x = 32 + i * 324; ctx.fillStyle = C.panel; ctx.fillRect(x, 453, 308, 71);
        text(ctx, `${row.symbol} · ${row.side}`, x + 14, 480, 19, row.side === 'SHORT' ? C.red : C.green, 650, 276);
        text(ctx, `Entry ${numberLabel(row.entry)}  ·  ${row.status}`, x + 14, 508, 15, C.muted, 400, 276);
      });
      text(ctx, `${w.report ? `Aperti ${w.report.open ?? '—'} · In attesa ${w.report.pending ?? '—'} · Chiusi ${w.report.closed ?? '—'} · ` : ''}Snapshot ${ageLabel(w.updatedAt)}`, 32, 559, 17, w.stale ? C.amber : C.muted, 400, 960);
      return;
    }
    const cards = (w.cards ?? []).slice(0, 3);
    cards.forEach((card, i) => {
      const x = 32 + i * 324; ctx.fillStyle = C.panel; ctx.fillRect(x, 126, 308, 99);
      text(ctx, card.label.toUpperCase(), x + 16, 155, 16, C.muted, 500, 270);
      text(ctx, card.value || '—', x + 16, 199, 30, card.tone === 'positive' ? C.green : card.tone === 'negative' ? C.red : C.text, 650, 270);
    });
    (w.rows ?? []).slice(0, 5).forEach((row, i) => {
      const yy = 262 + i * 52; text(ctx, row.label, 42, yy, 20, C.text, 600, 350);
      text(ctx, row.value, 460, yy, 21, row.tone === 'positive' ? C.green : row.tone === 'negative' ? C.red : C.cyan, 600, 510);
      if (row.detail) text(ctx, row.detail, 42, yy + 20, 13, C.muted, 400, 920);
      line(ctx, 32, yy + 31, 990, yy + 31);
    });
    if (!cards.length && !w.rows?.length) multiline(ctx, w.subtitle || 'Snapshot ricevuto. Aggiungere cards, rows oppure trades e candles.', 42, 235, 930, 4, 25);
    text(ctx, `Snapshot ${ageLabel(w.updatedAt)}${w.stale ? ' · scaduto' : ''}`, 32, 558, 17, w.stale ? C.amber : C.muted);
    return;
  }
  const tickers = w.tickers ?? [];
  if (snapshot.demo) {
    text(ctx, 'ANTEPRIMA GRAFICA · DATI SINTETICI', 34, 148, 21, C.amber, 700);
    text(ctx, 'I prezzi di questa prova non rappresentano il mercato.', 34, 185, 19, C.muted);
  } else tickers.slice(0, 3).forEach((t, i) => {
    const x = 32 + i * 324, stale = !t.updatedAt || Date.now() - t.updatedAt > 90_000;
    ctx.fillStyle = C.panel; ctx.fillRect(x, 125, 308, 100);
    text(ctx, t.symbol.replace('USDT', '/ USDT'), x + 16, 153, 17, C.muted, 600);
    text(ctx, numberLabel(t.price), x + 16, 194, 31, C.text, 700);
    text(ctx, t.changePct === null ? '—' : `${t.changePct >= 0 ? '+' : ''}${numberLabel(t.changePct)}%`, x + 205, 194, 18, stale ? C.amber : t.changePct < 0 ? C.red : C.green, 650, 88);
  });
  text(ctx, `${w.symbol} · PREZZO`, 32, 260, 19, C.cyan, 600);
  const ready = chart(ctx, w.candles, { x: 40, y: 284, w: 640, h: 220 });
  if (!ready) empty(ctx, 'PREZZI IN ATTESA', 'Nessun valore stimato o generato.', 52, 365, 620);
  const selected = tickers.find(t => t.symbol === w.symbol);
  [['MASSIMO 24H', selected?.high], ['MINIMO 24H', selected?.low], ['VOLUME USDT 24H', selected?.volume]].forEach(([label, value], i) => {
    text(ctx, label, 800, 302 + i * 77, 14, C.muted, 500, 190);
    text(ctx, i === 2 ? compact(value) : numberLabel(value ?? null), 800, 337 + i * 77, 23, C.text, 650, 190);
  });
  text(ctx, snapshot.demo ? 'DEMO SINTETICA · NON SONO DATI REALI' : `Prezzi pubblici · ${ageLabel(w.updatedAt)} · UTC`, 32, 558, 17, snapshot.demo || w.stale ? C.amber : C.muted, 500);
}

export function drawLiveDesk(ctx, snapshot, speech) {
  const [badge, tone] = status(snapshot); frame(ctx, 'MARKET DESK', badge, tone);
  text(ctx, 'OSSERVATORIO DI MERCATO', 32, 112, 18, C.cyan, 600);
  if (snapshot.demo) text(ctx, 'Modalità dimostrativa selezionata', 32, 170, 25, C.amber, 650);
  else (snapshot.tickers ?? []).slice(0, 3).forEach((t, i) => {
    const y = 168 + i * 63; text(ctx, t.symbol.replace('USDT', ''), 40, y, 31, C.text, 700);
    text(ctx, numberLabel(t.price), 235, y, 31, C.text, 650);
    text(ctx, t.changePct === null ? '—' : `${t.changePct >= 0 ? '+' : ''}${numberLabel(t.changePct)}%`, 680, y, 24, (t.changePct ?? 0) < 0 ? C.red : C.green, 650);
    text(ctx, '24 H', 888, y, 16, C.muted); line(ctx, 32, y + 24, 990, y + 24);
  });
  text(ctx, speech?.phase === 'playing' ? 'IN VOCE' : 'PROSSIMO INTERVENTO', 32, 370, 18, speech?.phase === 'playing' ? C.green : C.cyan, 700);
  multiline(ctx, speech?.text || 'In attesa del prossimo aggiornamento della presentatrice.', 32, 413, 960, 3, 25, speech?.text ? C.text : C.muted);
  const notice = snapshot.connection?.error || (snapshot.demo ? 'Demo esplicita · prezzi sintetici' : `${snapshot.heatmap.source} · ${snapshot.connection?.status}`);
  text(ctx, notice, 32, 556, 16, snapshot.connection?.stale ? C.amber : C.muted, 400, 960);
}
