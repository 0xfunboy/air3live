import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serviceRoot } from '../src/config.mjs';

// Version-specific, idempotent corrections to the installed capture transport.
// Reject upstream drift rather than exposing a listener or retaining a locked mutex.
const root = resolve(serviceRoot, 'node_modules/puppeteer-stream');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
if (pkg.version !== '3.0.23') throw new Error('Re-review the capture transport before upgrading puppeteer-stream');
const file = resolve(root, 'dist/PuppeteerStream.js');
const originalSource = await readFile(file, 'utf8');
let source = originalSource;
function patch(name, before, after) {
  const oldCount = source.split(before).length - 1;
  const newCount = source.split(after).length - 1;
  if (newCount === 1 && oldCount === 0) return;
  if (oldCount !== 1 || newCount !== 0) throw new Error(`Unexpected capture source: ${name} patch cannot be applied safely`);
  source = source.replace(before, after);
}

patch('loopback listener',
  'new ws_1.WebSocketServer({ port: i })',
  'new ws_1.WebSocketServer({ host: "127.0.0.1", port: i })');

patch('listener errors', `            new Promise((resolve) => {
                ws.on("error", (e) => {
                    resolve(!e.message.includes("EADDRINUSE"));
                });
            }),`, `            new Promise((resolve, reject) => {
                ws.on("error", (e) => {
                    if (e.code === "EADDRINUSE") resolve(false);
                    else reject(e);
                });
            }),`);

patch('tab-selection mutex', `    await lock();
    await page.bringToFront();
    const [tab] = await extension.evaluate(async (x) => {
        // @ts-ignore
        return chrome.tabs.query(x);
    }, opts.tabQuery || {
        active: true,
    });
    unlock();`, `    let tab;
    await lock();
    try {
        await page.bringToFront();
        [tab] = await extension.evaluate(async (x) => {
            // @ts-ignore
            return chrome.tabs.query(x);
        }, opts.tabQuery || {
            active: true,
        });
    } finally {
        // AIR3 capture mutex cleanup: tab selection.
        unlock();
    }`);

patch('capture-start mutex', `    (await exports.wss).on("connection", onConnection);
    await lock();
    await page.bringToFront();
    await assertExtensionLoaded(extension, retryPolicy);
    // Invoke extension via keyboard command to grant activeTab (Ctrl/Command+Shift+Y)
    const isMac = process.platform === 'darwin';
    await page.keyboard.down(isMac ? 'Meta' : 'Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyY');
    await page.keyboard.up('Shift');
    await page.keyboard.up(isMac ? 'Meta' : 'Control');
    // Small delay to let Chrome register the invocation
    await new Promise((r) => setTimeout(r, 100));
    await extension.evaluate(
    // @ts-ignore
    (settings) => START_RECORDING(settings), Object.assign(Object.assign({}, opts), { index, tabId: tab.id }));
    unlock();`, `    const captureServer = await exports.wss;
    captureServer.on("connection", onConnection);
    await lock();
    try {
        await page.bringToFront();
        await assertExtensionLoaded(extension, retryPolicy);
        // Invoke extension via keyboard command to grant activeTab (Ctrl/Command+Shift+Y)
        const isMac = process.platform === 'darwin';
        await page.keyboard.down(isMac ? 'Meta' : 'Control');
        await page.keyboard.down('Shift');
        await page.keyboard.press('KeyY');
        await page.keyboard.up('Shift');
        await page.keyboard.up(isMac ? 'Meta' : 'Control');
        // Small delay to let Chrome register the invocation
        await new Promise((r) => setTimeout(r, 100));
        await extension.evaluate(
        // @ts-ignore
        (settings) => START_RECORDING(settings), Object.assign(Object.assign({}, opts), { index, tabId: tab.id }));
    } catch (error) {
        captureServer.off("connection", onConnection);
        stream.destroy();
        throw error;
    } finally {
        // AIR3 capture mutex cleanup: capture startup.
        unlock();
    }`);

if (source !== originalSource) await writeFile(file, source);
console.log('Capture transport patched: loopback, listener failures and mutex cleanup');
