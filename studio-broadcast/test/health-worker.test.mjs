import test from 'node:test';
import assert from 'node:assert/strict';

test('health worker reports the exact bounded JSON result, deduplicates probes and recovers after timeout', async (t) => {
  const original = { fetch: globalThis.fetch, postMessage: globalThis.postMessage,
    onmessage: globalThis.onmessage, setTimeout: globalThis.setTimeout };
  t.after(() => Object.assign(globalThis, original));
  const messages = [], requests = [];
  globalThis.postMessage = (message) => messages.push(message);
  await import('../public/health-worker.mjs');
  let release;
  globalThis.fetch = (url) => { requests.push(url); return new Promise(resolve => { release = resolve; }); };
  const first = globalThis.onmessage({ data: { type: 'probe' } });
  await globalThis.onmessage({ data: { type: 'probe' } });
  assert.equal(requests.length, 1, 'Only one health read may be pending');
  assert.equal(messages.length, 0, 'A pending fetch is not an application-level success');
  release(Response.json({ ok: true })); await first;
  assert.equal(messages[0].ok, true);
  assert.equal(requests[0], '/api/health?probe=' + messages[0].probeId);
  assert.equal(messages[0].errorCode, null);
  assert.ok(messages[0].checkedAt >= messages[0].startedAt);
  assert.ok(messages[0].elapsedMs >= 0);

  for (const [response, expected] of [
    [new Response('{not-json'), 'invalid-json'],
    [Response.json({ ok: false }), 'invalid-health-response'],
    [new Response('unavailable', { status: 503 }), 'http'],
    [new Response('x'.repeat(65 * 1024)), 'size-limit'],
  ]) {
    globalThis.fetch = async () => response;
    await globalThis.onmessage({ data: { type: 'probe' } });
    assert.equal(messages.at(-1).ok, false);
    assert.equal(messages.at(-1).errorCode, expected);
  }
  let deadline, wasAborted = false;
  globalThis.setTimeout = (callback, ms, ...args) => {
    deadline = ms; return original.setTimeout(callback, 0, ...args);
  };
  globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { wasAborted = true; reject(signal.reason); }, { once: true });
  });
  await globalThis.onmessage({ data: { type: 'probe' } });
  globalThis.setTimeout = original.setTimeout;
  assert.equal(deadline, 4000, 'The health deadline remains four seconds');
  assert.equal(wasAborted, true);
  assert.equal(messages.at(-1).errorCode, 'timeout');
  assert.equal(messages.at(-1).ok, false);
  globalThis.fetch = async () => Response.json({ ok: true });
  await globalThis.onmessage({ data: { type: 'probe' } });
  assert.equal(messages.at(-1).ok, true, 'A subsequent scheduled probe may recover');
  assert.equal(new Set(messages.map(row => row.probeId)).size, messages.length);
  assert.equal(messages.length, 7, 'There is no hidden retry after a failure');
});
