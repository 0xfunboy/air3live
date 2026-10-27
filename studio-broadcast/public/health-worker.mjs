import { fetchJson } from './pure.mjs';

// Network timeouts run off the rendering thread. A slow first shader/frame must
// not turn a successful local HTTP response into a false gateway outage.
let pending = false, sequence = 0;
globalThis.onmessage = async ({ data }) => {
  if (data?.type !== 'probe' || pending) return;
  pending = true;
  const probeId = String(++sequence), startedAt = Date.now(), started = performance.now();
  let ok = false, errorName = null, errorCode = null;
  try {
    // The public correlation ID lets QA match Chromium's network observation
    // to this exact completed JSON read; it contains no credentials or user data.
    const result = await fetchJson('/api/health?probe=' + probeId, {}, { timeoutMs: 4000, maxBytes: 64 * 1024 });
    ok = result?.ok === true;
    if (!ok) errorCode = 'invalid-health-response';
  }
  catch (error) {
    errorName = error?.name || 'Error';
    errorCode = error?.message === 'Request timeout' ? 'timeout'
      : /^HTTP \d+$/.test(error?.message) ? 'http'
      : error?.message === 'Response too large' ? 'size-limit'
      : error instanceof SyntaxError ? 'invalid-json' : 'network';
  }
  finally { pending = false; }
  globalThis.postMessage({ type: 'health', probeId, startedAt, checkedAt: Date.now(),
    elapsedMs: Math.round((performance.now() - started) * 100) / 100, ok, errorName, errorCode });
};
