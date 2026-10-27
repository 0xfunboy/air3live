import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { gpuRequest, applyWindowsGpuPreference, previewPort, startManaged,
  waitForOwnedEvent, stopManaged, exitCode } from '../../scripts/launcher-runtime.mjs';

const preload = new URL('../../scripts/launcher-shutdown.mjs', import.meta.url).href;
const silent = { stdout: null, stderr: null };

test('launcher GPU preference preserves a typed prior snapshot and passes executable paths as data', () => {
  const calls = [], executable = `C:\\Program Files\\odd' \\chrome.exe`;
  const prior = { existed: true, kind: 'ExpandString', serialized: 'PHByaW9yLXR5cGVkLXZhbHVlPg==', applied: 'GpuPreference=1;' };
  const execute = (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, 'powershell.exe'); assert.equal(args[3], '-EncodedCommand');
    assert.equal(options.env.AIR3_LAUNCHER_GPU_APP, executable);
    const source = Buffer.from(args[4], 'base64').toString('utf16le');
    assert.ok(!source.includes(executable), 'Path is never interpolated into PowerShell source');
    return JSON.stringify(calls.length === 1 ? prior : { restored: true });
  };
  const preference = applyWindowsGpuPreference(executable, gpuRequest('intel'), { platform: 'win32', env: {}, execute });
  assert.equal(preference.applied, true); assert.deepEqual(preference.restore(), { restored: true }); preference.restore();
  assert.equal(calls.length, 2, 'Restore is idempotent');
  assert.deepEqual(JSON.parse(calls[1].options.env.AIR3_LAUNCHER_GPU_PRIOR), prior);
  assert.equal(applyWindowsGpuPreference(executable, gpuRequest('nvidia'), { platform: 'linux', execute: () => assert.fail('PowerShell on Linux') }).applied, false);
  assert.throws(() => gpuRequest('unsupported'), /GPU non valida/);
});

test('occupied preview port chooses another port without disturbing its owner', async t => {
  const server = net.createServer(socket => socket.end('owner remains active'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  assert.equal(await previewPort(port), 0);
  const received = await new Promise((resolve, reject) => {
    const client = net.connect(port, '127.0.0.1'); let text = '';
    client.on('data', bytes => { text += bytes; }); client.on('end', () => resolve(text)); client.on('error', reject);
  });
  assert.equal(received, 'owner remains active');
});

test('owned readiness waits for its actual JSON event and spawn failures reject cleanly', async t => {
  const child = startManaged(process.execPath, ['-e', `console.log(JSON.stringify({event:'unrelated'})); setTimeout(() => {console.log(JSON.stringify({event:'gateway-listening',port:1234}));}, 70); setTimeout(()=>{}, 5000);`], silent);
  t.after(() => stopManaged(child, { graceMs: 1000 }));
  const started = Date.now();
  const event = await waitForOwnedEvent(child, value => value.event === 'gateway-listening');
  assert.equal(event.port, 1234); assert.ok(Date.now() - started >= 50);
  const missing = startManaged('/air3-test-no-such-executable', [], silent);
  await assert.rejects(waitForOwnedEvent(missing, value => value.event === 'gateway-listening'), /ENOENT/);
  assert.equal(exitCode(await missing.done), 1);
});

test('IPC shutdown runs asynchronous drain before exit and does not force a Windows-style termination', async () => {
  const child = startManaged(process.execPath, ['--import', preload, '-e', `
    const keepAlive = setInterval(()=>{}, 1000);
    process.on('SIGTERM', () => setTimeout(() => {
      console.log(JSON.stringify({event:'drain-complete'})); clearInterval(keepAlive);
    }, 120));
    console.log(JSON.stringify({event:'ready'}));
  `], { ...silent, ipc: true });
  await waitForOwnedEvent(child, value => value.event === 'ready');
  const started = Date.now(), result = await stopManaged(child, { platform: 'win32', graceMs: 2000 });
  assert.equal(result.forced, false); assert.equal(exitCode(result.result), 0);
  assert.ok(Date.now() - started >= 100);
  assert.ok(child.seen.some(value => value.event === 'drain-complete'));
});

test('launcher IPC preload lets a completed worker exit naturally and preserves its exit code', async () => {
  const child = startManaged(process.execPath, ['--import', preload, '-e', 'process.exitCode = 7;'], { ...silent, ipc: true });
  const result = await child.done;
  assert.equal(exitCode(result), 7);
});

test('loss of the owning launcher closes its detached worker gracefully', async () => {
  const child = startManaged(process.execPath, ['--import', preload, '-e', `
    const keepAlive = setInterval(()=>{}, 1000);
    process.on('SIGTERM', () => { console.log(JSON.stringify({event:'owner-lost-cleanup'})); clearInterval(keepAlive); });
    console.log(JSON.stringify({event:'ready'}));
  `], { ...silent, ipc: true });
  await waitForOwnedEvent(child, value => value.event === 'ready');
  child.child.disconnect();
  const result = await child.done;
  assert.equal(exitCode(result), 0);
  assert.ok(child.seen.some(value => value.event === 'owner-lost-cleanup'));
});
