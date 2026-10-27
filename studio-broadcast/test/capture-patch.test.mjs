import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import * as stream from 'node:stream';
import * as path from 'node:path';

// Execute the installed vendor code with fake browser/socket surfaces. A thrown
// setup step must not lock the next session or retain a connection listener.
const source = await readFile(new URL('../node_modules/puppeteer-stream/dist/PuppeteerStream.js', import.meta.url), 'utf8');
function runtime(listenerError) {
  class FakeServer extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => listenerError
        ? this.emit('error', Object.assign(new Error('fixture'), { code: listenerError }))
        : this.emit('listening'));
    }
  }
  const ws = { WebSocketServer: FakeServer, CLOSED: 3 };
  const context = { exports: {}, process: { platform: 'linux' }, URL, setTimeout, clearTimeout,
    require(name) {
      const mocks = { 'puppeteer-core': {}, path, stream, ws };
      if (!(name in mocks)) throw new Error('Unexpected vendor dependency');
      return mocks[name];
    } };
  vm.runInNewContext(source, context, { filename: 'patched-capture-fixture.js' });
  return context.exports;
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Capture mutex did not unlock')), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

for (const failurePosition of [1, 2]) {
  test(`capture lock ${failurePosition} releases after a thrown setup step and the next session starts`, async () => {
    const capture = runtime();
    const server = await capture.wss;
    let fronts = 0;
    const browser = { waitForTarget: async () => ({ page: async () => extension }), isConnected: () => true };
    const extension = { isClosed: () => false, browser: () => browser,
      evaluate: async (fn) => fn.toString().includes('chrome.tabs.query') ? [{ id: 1 }] : true };
    const page = { browser: () => browser,
      bringToFront: async () => { if (++fronts === failurePosition) throw new Error('Injected capture fault'); },
      keyboard: { down: async () => {}, up: async () => {}, press: async () => {} } };
    await assert.rejects(bounded(capture.getStream(page, { audio: true, video: true })), /Injected capture fault/);
    assert.equal(server.listenerCount('connection'), 0, 'Failed setup must remove its connection listener');
    const result = await bounded(capture.getStream(page, { audio: true, video: true }));
    assert.ok(result instanceof stream.Transform);
    result.destroy();
  });
}

test('capture listener errors other than an occupied port reject startup', async () => {
  await assert.rejects(runtime('EACCES').wss, { code: 'EACCES' });
});
