/** Optional real public-feed probe. Does not require or read exchange keys. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createLiveMarketService } from '../src/live-market.mjs';
import { serviceRoot } from '../src/config.mjs';
const requests = [], startedAt = Date.now();
const service = createLiveMarketService({ config: { provider: 'binance', enabled: true }, fetchImpl: async (url, options) => {
  try { const response = await fetch(url, options); requests.push({ url, status: response.status }); return response; }
  catch (error) { requests.push({ url, error: error.name }); throw error; }
} });
let result;
try {
  await service.start(); await delay(12_000);
  const snapshot = service.snapshot();
  result = { schema: 'air3.market-network-probe.v1', at: new Date().toISOString(), durationMs: Date.now() - startedAt,
    requests, connection: snapshot.connection, tickerCount: snapshot.tickers.filter(t => t.price !== null).length,
    candles: snapshot.heatmap.candles.length, observedCompletedOrders: snapshot.heatmap.count,
    realSourceAccessible: !snapshot.connection.stale && snapshot.heatmap.candles.length > 0,
    notes: ['A 12 second network probe is not a long-running feed reliability benchmark.', 'Zero observed completed orders can be legitimate in this short sample.', 'No synthetic fallback or subscription key is used.'] };
} finally { await service.stop(); }
const out = resolve(process.env.AIR3_MARKET_QA_DIR || resolve(serviceRoot, '../docs/validation/current/live-market'));
await mkdir(out, { recursive: true }); await writeFile(resolve(out, 'network-probe.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
