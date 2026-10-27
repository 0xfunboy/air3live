import { FEEDS, numberLabel, isStale, ageLabel } from './pure.mjs';
import { drawLiveDesk, drawLiveHeatmap, drawLiveWallpanel } from './market-panels.mjs';

const C = { bg: '#071319', panel: '#0c2027', cyan: '#53e6ed', text: '#dcecef', muted: '#78959f',
  line: '#183b43', amber: '#edbf74', red: '#ee7e91', green: '#78d9bb' };

const canvas = () => { const c = document.createElement('canvas'); c.width = 1024; c.height = 576; return c; };
function text(ctx, value, x, y, size = 24, color = C.text, weight = 400) {
  ctx.fillStyle = color; ctx.font = `${weight} ${size}px "Courier New", monospace`; ctx.fillText(String(value), x, y);
}
function base(ctx, label, index) {
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, 1024, 576);
  ctx.strokeStyle = C.line; ctx.lineWidth = 1;
  for (let y = 88; y < 576; y += 48) { ctx.beginPath(); ctx.moveTo(32, y); ctx.lineTo(992, y); ctx.stroke(); }
  ctx.fillStyle = C.cyan; ctx.fillRect(32, 28, 5, 27);
  text(ctx, label, 52, 50, 24, C.text, 700);
  text(ctx, index, 971, 50, 13, C.muted);
  ctx.fillStyle = C.line; ctx.fillRect(32, 72, 960, 1);
}
function wrapped(ctx, value, x, y, width, lineHeight, maxLines, fontSize = 25, color = C.text) {
  ctx.font = `400 ${fontSize}px "Courier New", monospace`; ctx.fillStyle = color;
  const words = String(value).split(/\s+/), lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > width && line) { lines.push(line); line = word; }
    else line = next;
    if (lines.length >= maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  lines.forEach((l, i) => ctx.fillText(i === maxLines - 1 && words.join(' ').length > lines.join(' ').length ? `${l.slice(0, -2)}…` : l, x, y + i * lineHeight));
}

const candlePlugin = {
  id: 'studioCandles',
  afterDatasetsDraw(chart) {
    const candles = chart.options.plugins.studioCandles.candles ?? [];
    const { ctx, scales: { x, y }, chartArea } = chart;
    if (!candles.length) return;
    const w = Math.min(14, Math.max(2, chartArea.width / candles.length * 0.60));
    ctx.save();
    ctx.beginPath(); ctx.rect(chartArea.left, chartArea.top, chartArea.width, chartArea.height); ctx.clip();
    candles.forEach((c, i) => {
      const px = x.getPixelForValue(i), top = y.getPixelForValue(Math.max(c.open, c.close));
      const height = Math.max(2, Math.abs(y.getPixelForValue(c.open) - y.getPixelForValue(c.close)));
      const color = c.close >= c.open ? C.green : C.red;
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, y.getPixelForValue(c.high)); ctx.lineTo(px, y.getPixelForValue(c.low)); ctx.stroke();
      ctx.fillRect(px - w / 2, top, w, height);
    });
    const levels = chart.options.plugins.studioCandles.levels ?? [];
    for (const { value, name, color } of levels) {
      if (value === null || value < y.min || value > y.max) continue;
      const py = y.getPixelForValue(value);
      ctx.strokeStyle = color; ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(chartArea.left, py); ctx.lineTo(chartArea.right, py); ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle = color; ctx.font = '16px monospace';
      ctx.fillText(`${name} ${numberLabel(value)}`, chartArea.left + 5, py - 5);
    }
    ctx.restore();
  },
};

export class StudioMonitors {
  constructor(onDirty) {
    this.onDirty = onDirty;
    this.left = canvas(); this.center = canvas(); this.right = canvas();
    this.chartCanvas = document.createElement('canvas'); this.chartCanvas.width = 960; this.chartCanvas.height = 408;
    this.chart = null;
    this.market = null; this.speech = null; this.liveMarket = null;
    this.lastChartKey = '';
    this.lastSpeechKey = '';
    this.draw();
  }

  setMarket(state) { this.market = state; this.draw(); }
  setLiveMarketSnapshot(snapshot) { this.liveMarket = snapshot; this.draw(); }
  setSpeech(state) {
    this.speech = state;
    // Audio cues are sampled every frame, but the monitor contains only the
    // briefing text/status. Avoid repainting and uploading an identical 2MB
    // canvas for every phoneme, keeping the render thread for the avatar.
    const key = `${state?.phase}|${!!state?.connected}|${state?.lipSync}|${state?.text ?? ''}`;
    if (key === this.lastSpeechKey) return;
    this.lastSpeechKey = key;
    if (this.liveMarket) { this.drawLeft(); this.onDirty?.('left'); }
    else { this.drawRight(); this.onDirty?.('right'); }
  }

  draw() {
    this.drawLeft(); this.drawCenter(); this.drawRight(); this.onDirty?.('all');
  }

  drawLeft() {
    const ctx = this.left.getContext('2d'), m = this.market;
    if (this.liveMarket) { drawLiveDesk(ctx, this.liveMarket, this.speech); return; }
    base(ctx, 'MARKET TELEMETRY', '01');
    const fresh = m && !isStale(m.fetchedAt);
    text(ctx, m ? FEEDS[m.mode].label.toUpperCase() : 'DATA LINK', 40, 122, 20, C.cyan);
    text(ctx, fresh ? 'SNAPSHOT RECEIVED' : 'DATA NOT CURRENT', 40, 161, 28, fresh ? C.green : C.amber, 700);
    const r = m?.report;
    const reportStale = !m || isStale(m.reportAt, Date.now(), 60_000);
    const boxes = [['OPEN', r?.open], ['PENDING', r?.pending], ['CLOSED', r?.closed]];
    boxes.forEach(([label, value], i) => {
      const x = 40 + i * 320;
      text(ctx, label, x, 228, 19, C.muted);
      text(ctx, numberLabel(value ?? null, { maximumFractionDigits: 0 }), x, 294, 55, C.text, 700);
    });
    text(ctx, m?.mode === 'auto' ? 'SIZE-NORMALIZED CUMULATIVE PNL %' : 'SUM OF CLOSED TRADE PNL %', 40, 354, 19, C.muted);
    text(ctx, r?.pnlSum === null || r?.pnlSum === undefined ? '—' : `${numberLabel(r.pnlSum)}%`, 40, 402, 38,
      (r?.pnlSum ?? 0) < 0 ? C.red : C.cyan);
    text(ctx, 'Not portfolio return / not vault APY', 40, 434, 18, C.muted);
    text(ctx, `Snapshot ${ageLabel(m?.fetchedAt)}`, 40, 493, 19, C.muted);
    text(ctx, reportStale ? 'REPORT UNKNOWN / STALE' : `Report ${ageLabel(m?.reportAt)}`, 40, 529, 20, reportStale ? C.amber : C.muted);
  }

  drawCenter() {
    const ctx = this.center.getContext('2d'), m = this.market, selected = m?.selected;
    if (this.liveMarket) { drawLiveWallpanel(ctx, this.liveMarket, this.market); return; }
    base(ctx, selected ? `${selected.symbol}  /  ${m.timeframe.toUpperCase()}` : 'MARKET CHART', '02');
    const candles = m?.candles ?? [];
    if (!candles.length) {
      text(ctx, selected ? 'WAITING FOR CANDLES' : 'NO MARKET DATA', 42, 240, 40, C.text, 700);
      wrapped(ctx, 'Waiting for confirmed market prices.', 42, 291, 900, 35, 4, 24, C.muted);
      text(ctx, 'MARKET CONNECTION PENDING', 42, 504, 20, C.amber);
      return;
    }
    const key = `${m.mode}|${selected.id}|${m.timeframe}|${m.chartAt}`;
    if (key !== this.lastChartKey && window.Chart) {
      const values = candles.flatMap((c) => [c.low, c.high]);
      let min = Math.min(...values), max = Math.max(...values);
      const pad = (max - min || Math.abs(max) * .01) * .08; min -= pad; max += pad;
      const data = { datasets: [{ data: candles.map((c, i) => ({ x: i, y: c.close })), pointRadius: 0, borderWidth: 0 }] };
      const options = { responsive: false, animation: false, devicePixelRatio: 1, events: [],
        layout: { padding: { top: 12, right: 12 } },
        plugins: { legend: { display: false }, tooltip: { enabled: false },
          studioCandles: { candles, levels: [
            { value: selected.entry, name: 'ENTRY', color: C.cyan },
            { value: selected.takeProfit, name: 'TP', color: C.green },
            { value: selected.stopLoss, name: 'SL', color: C.red },
          ] } },
        scales: { x: { type: 'linear', min: -1, max: candles.length,
          grid: { color: C.line }, border: { color: C.line }, ticks: { maxTicksLimit: 6, color: C.muted, font: { family: 'monospace', size: 16 },
            callback: (i) => candles[Math.round(i)] ? new Date(candles[Math.round(i)].time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) : '' } },
          y: { min, max, position: 'right', grid: { color: C.line }, border: { color: C.line },
            ticks: { color: C.muted, maxTicksLimit: 6, font: { family: 'monospace', size: 16 }, callback: (v) => numberLabel(v) } } } };
      if (this.chart) { this.chart.data = data; this.chart.options = options; this.chart.update('none'); }
      else this.chart = new window.Chart(this.chartCanvas, { type: 'scatter', data, options, plugins: [candlePlugin] });
      this.lastChartKey = key;
    }
    if (this.chart) ctx.drawImage(this.chartCanvas, 32, 94);
    else text(ctx, 'Chart engine unavailable', 42, 250, 30, C.amber);
    const stale = isStale(m.chartAt, Date.now(), 35_000);
    text(ctx, `${selected.side}  ·  ${selected.status}  ·  ${stale ? 'STALE' : 'FETCHED'} ${ageLabel(m.chartAt)}`, 40, 541, 19, stale ? C.amber : C.muted);
  }

  drawRight() {
    const ctx = this.right.getContext('2d'), s = this.speech, m = this.market;
    if (this.liveMarket) { drawLiveHeatmap(ctx, this.liveMarket); return; }
    base(ctx, 'MARKET BRIEFING', '03');
    const active = s?.phase === 'playing';
    text(ctx, active ? 'VOICE ON AIR' : s?.connected ? 'VOICE READY' : 'MUTED OBSERVER', 40, 130, 31, active ? C.green : C.cyan, 700);
    text(ctx, 'MARKET BRIEFING', 40, 170, 18, C.muted);
    if (s?.text) {
      wrapped(ctx, s.text, 40, 229, 940, 36, 7, 25, C.text);
    } else {
      wrapped(ctx, s?.connected ? 'The next market briefing will begin shortly.' : 'Preview mode. Live narration is currently off air.', 40, 240, 916, 37, 5, 26, C.muted);
    }
    const aligned = s?.lipSync?.startsWith('rhubarb:');
    text(ctx, active ? (aligned ? 'VOICE AND LIP SYNC' : 'VOICE ON AIR') : 'AUTONOMOUS MARKET STUDIO', 40, 512, 19, active ? C.cyan : C.muted);
    text(ctx, m && !isStale(m.fetchedAt) ? 'MARKET SNAPSHOT RECEIVED' : 'WAITING FOR MARKET UPDATES', 40, 548, 18, C.muted);
  }

  dispose() { this.chart?.destroy(); this.chart = null; }
}
