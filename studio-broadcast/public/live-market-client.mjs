import { fetchJson, reconnectDelay } from './pure.mjs';

/** One bounded same-origin poll for all three canvas monitors. No API keys. */
export function createLiveMarketClient({ onUpdate, onStatus = () => {}, token = null, endpoint = '/api/live/market',
  pollMs = 3000, fetchImpl = globalThis.fetch, random = Math.random } = {}) {
  if (typeof onUpdate !== 'function') throw new Error('Market update callback is required');
  if (!/^\/api\/[A-Za-z0-9/_-]+$/.test(endpoint)) throw new Error('Market endpoint must be a same-origin API path');
  let stopped = true, generation = 0, timer = null, controller = null, failures = 0, latest = null;
  const state = { connected: false, lastReceivedAt: null, error: '' };
  const emit = () => onStatus({ ...state });
  async function poll() {
    if (stopped || controller) return;
    const gen = generation, request = controller = new AbortController();
    try {
      const currentToken = typeof token === 'function' ? token() : token;
      const snapshot = await fetchJson(endpoint, { signal: request.signal, headers: currentToken ? { Authorization: `Bearer ${currentToken}` } : {} },
        { timeoutMs: 8000, maxBytes: 3 * 1024 * 1024, fetchImpl });
      if (stopped || gen !== generation || request.signal.aborted) return;
      if (snapshot?.schema !== 'air3.live-market.v1' || !snapshot.heatmap || !snapshot.wallpanel) throw new Error('Invalid market snapshot');
      latest = snapshot; failures = 0; state.connected = true; state.error = ''; state.lastReceivedAt = Date.now();
      onUpdate(snapshot); emit();
    } catch (error) {
      if (stopped || gen !== generation || request.signal.aborted) return;
      failures++; state.connected = false; state.error = 'Dati di mercato temporaneamente non disponibili'; emit();
      // Retain received prices with an explicit stale state; never turn an
      // unavailable real feed into a synthetic chart or a zero-value price.
      if (latest) onUpdate({ ...latest, connection: { ...latest.connection, status: 'offline', stale: true, error: state.error },
        heatmap: { ...latest.heatmap, stale: true }, wallpanel: { ...latest.wallpanel, stale: true } });
    } finally {
      if (controller === request) controller = null;
      if (!stopped && gen === generation) timer = setTimeout(poll, failures ? Math.max(pollMs, reconnectDelay(failures, random)) : pollMs);
    }
  }
  return {
    start() { if (!stopped) return; stopped = false; generation++; void poll(); },
    stop() { stopped = true; generation++; clearTimeout(timer); timer = null; controller?.abort(); controller = null; state.connected = false; },
    refresh() { if (stopped) return; clearTimeout(timer); timer = null; return poll(); },
    state: () => ({ ...state }),
  };
}
