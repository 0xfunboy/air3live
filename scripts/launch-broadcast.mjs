#!/usr/bin/env node
/** Gateway and broadcaster supervisor. Never takes over another process's port. */
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gpuRequest, resolveLauncherChrome, applyWindowsGpuPreference,
  startManaged, waitForOwnedEvent, stopManaged, exitCode } from './launcher-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serviceRoot = resolve(root, 'studio-broadcast');
const preload = pathToFileURL(resolve(root, 'scripts/launcher-shutdown.mjs')).href;
let gateway, broadcaster, preference, stopping;
async function shutdown(code = 0) {
  if (stopping) return stopping;
  stopping = (async () => {
    // The gateway stays alive while the player terminalizes its lease and the
    // capture recorder/FFmpeg flush their last audio and video packets.
    const capture = await stopManaged(broadcaster, { graceMs: 30000 });
    if (capture.forced) { console.error('Timeout di arresto broadcaster: processo terminato dopo 30 secondi.'); if (!code) code = 1; }
    const service = await stopManaged(gateway, { graceMs: 12000 });
    if (service.forced) { console.error('Timeout di arresto gateway.'); if (!code) code = 1; }
    try {
      const restored = preference?.restore();
      if (restored?.reason === 'changed-externally') console.log('Preferenza GPU modificata esternamente: mantenuto il valore più recente.');
    } catch (error) { console.error('Ripristino preferenza GPU non riuscito:', error.message); if (!code) code = 1; }
    process.exitCode = code;
  })();
  return stopping;
}
const onInterrupt = () => { void shutdown(130); };
const onTerminate = () => { void shutdown(143); };
process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate);
try {
  const request = gpuRequest(process.argv[2]);
  const chrome = await resolveLauncherChrome(serviceRoot);
  if (stopping) throw new Error('Avvio interrotto');
  console.log(`airewardrop Broadcast · GPU richiesta: ${request.label}; encoder richiesto: ${request.encoder}`);
  preference = applyWindowsGpuPreference(chrome, request);
  if (!preference.applied) console.log('Preferenza DXGI disponibile solo su Windows; verificare renderer ed encoder nei log.');
  const env = { ...process.env, AIR3_CHROME_PATH: chrome, AIR3_VIDEO_ENCODER: request.encoder,
    AIR3_REQUIRE_HARDWARE_RENDERING: 'true', AIR3_CONTROL_STDIN: 'false' };
  if (!stopping) {
    gateway = startManaged(process.execPath, ['--env-file=.env', '--import', preload, 'src/main.mjs'],
      { cwd: serviceRoot, env, ipc: true });
    await waitForOwnedEvent(gateway, event => event.event === 'gateway-listening', 20000);
    if (!stopping) {
      broadcaster = startManaged(process.execPath, ['--env-file=.env', '--import', preload, 'src/broadcast.mjs'],
        { cwd: serviceRoot, env, ipc: true });
      const first = await Promise.race([
        broadcaster.done.then(result => ({ owner: 'broadcaster', result })),
        gateway.done.then(result => ({ owner: 'gateway', result }))
      ]);
      if (!stopping) {
        if (first.owner === 'gateway') console.error('Il gateway avviato dal launcher è terminato durante la trasmissione.');
        await shutdown(first.owner === 'gateway' ? exitCode(first.result) || 1 : exitCode(first.result));
      }
    }
  }
} catch (error) {
  if (!stopping) { console.error('Avvio trasmissione non riuscito:', error.message); await shutdown(1); }
} finally {
  if (stopping) await stopping;
  process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
}
