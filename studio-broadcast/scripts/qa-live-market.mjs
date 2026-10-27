/** Canvas-only market-panel visual QA. Fixture renders are explicitly DEMO. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { serviceRoot } from '../src/config.mjs';
import { createLiveMarketService, demoMarketSnapshot, coinglassHeatmap } from '../src/live-market.mjs';

const out = resolve(process.env.AIR3_MARKET_QA_DIR || resolve(serviceRoot, '../docs/validation/current/live-market'));
await mkdir(out, { recursive: true });
let executablePath = process.env.AIR3_CHROME_PATH;
if (!executablePath) executablePath = (await readFile(resolve(serviceRoot, '.browser-path'), 'utf8')).trim();
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><title>#AIR3 market canvas QA</title><canvas id="left" width="1024" height="576"></canvas><canvas id="center" width="1024" height="576"></canvas><canvas id="right" width="1024" height="576"></canvas>'); return; }
  if (!['/market-panels.mjs', '/pure.mjs'].includes(path)) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(resolve(serviceRoot, 'public', path.slice(1))));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser; const result = { schema: 'air3.live-market-visual.v1', at: new Date().toISOString(), passed: false, errors: [], captures: [],
  fixtureNotice: 'These canvas exports use marked synthetic test input, not a captured real exchange session.' };
try {
  browser = await puppeteer.launch({ executablePath, headless: true, args: process.getuid?.() === 0 ? ['--no-sandbox', '--disable-dev-shm-usage'] : ['--disable-dev-shm-usage'] });
  const page = await browser.newPage(); page.on('pageerror', error => result.errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => { window.panels = await import('/market-panels.mjs'); });
  const now = Date.now();
  const disabled = createLiveMarketService({ config: { enabled: false }, now: () => now }); await disabled.start();
  const demo = createLiveMarketService({ config: { provider: 'demo' }, now: () => now }); await demo.start();
  const sample = demoMarketSnapshot(now);
  const observed = disabled.snapshot(); observed.demo = true;
  observed.connection.status = 'fixture'; observed.connection.stale = false;
  observed.heatmap = { ...sample, kind: 'observed-liquidations', title: 'LIQUIDAZIONI OSSERVATE · FIXTURE', source: 'Fixture di collaudo · nessun dato reale',
    cells: [[20, 35, 50_000], [38, 30, 21_000], [85, 44, 126_000], [94, 48, 82_000]], collectedSince: now - 43_200_000,
    longUsd: 71_000, shortUsd: 208_000, count: 4, gaps: 1 };
  observed.wallpanel.candles = sample.candles;
  const cg = disabled.snapshot(); cg.demo = true; cg.heatmap = coinglassHeatmap({ code: '0', data: {
    y_axis: [79500, 80500, 81500, 82500, 83500, 84500], price_candlesticks: sample.candles.map(c => [c.time / 1000, c.open, c.high, c.low, c.close, 0]),
    liquidation_leverage_data: Array.from({ length: 144 }, (_, x) => [x, 1 + Math.floor(x / 48), 200_000 + x * 1000]),
  } }, { symbol: 'BTCUSDT', range: '12h', now }); cg.heatmap.source = 'CoinGlass adapter · fixture di collaudo'; cg.wallpanel.candles = sample.candles;
  const external = createLiveMarketService({ config: { enabled: false, wallpanelSource: 'external' }, now: () => now }); await external.start();
  await external.setWallpanel({ title: 'AIRTRACK WALLPANEL · FIXTURE', source: 'Adattatore dApp · dati di collaudo', ttlSeconds: 300,
    trades: [{ id: 7, symbol: 'BTC', side: 'LONG', status: 'OPEN', entry_price: 82000, tp_price: 83000, sl_price: 81200, unrealized_pnl_pct: 1.2 },
      { id: 8, symbol: 'ETH', side: 'SHORT', status: 'PENDING', entry_price: 3000 }, { id: 9, symbol: 'SOL', side: 'LONG', status: 'OPEN', entry_price: 180 }],
    candles: sample.candles, report: { totals: { open: 2, pending: 1, closed: 18 }, pnl_realized_pct_sum: 5 }, selectedId: 7 });
  const cases = [['empty', disabled.snapshot()], ['demo', demo.snapshot()], ['observed-fixture', observed], ['coinglass-fixture', cg], ['wallpanel-fixture', external.snapshot()]];
  for (const [name, snapshot] of cases) {
    const captures = await page.evaluate(snapshot => {
      const ids = ['left', 'center', 'right'], canvases = ids.map(id => document.getElementById(id));
      window.panels.drawLiveDesk(canvases[0].getContext('2d'), snapshot, { phase: 'playing', text: 'Aggiornamento dei mercati: confronto dei dati confermati e del contesto della seduta. Questo testo è una prova del pannello.' });
      window.panels.drawLiveWallpanel(canvases[1].getContext('2d'), snapshot);
      window.panels.drawLiveHeatmap(canvases[2].getContext('2d'), snapshot);
      return canvases.map((canvas, index) => ({ id: ids[index], url: canvas.toDataURL('image/png') }));
    }, snapshot);
    for (const c of captures) {
      const file = `${name}-${c.id}.png`, bytes = Buffer.from(c.url.split(',')[1], 'base64');
      assert.ok(bytes.length > 5000); await writeFile(resolve(out, file), bytes); result.captures.push({ file, bytes: bytes.length });
    }
  }
  assert.equal(result.errors.length, 0); assert.equal(result.captures.length, 15); result.passed = true;
  await Promise.all([disabled.stop(), demo.stop(), external.stop()]);
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
  await writeFile(resolve(out, 'visual-report.json'), JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify({ passed: result.passed, captures: result.captures.length, errors: result.errors, report: resolve(out, 'visual-report.json') }));
