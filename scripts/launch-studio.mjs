#!/usr/bin/env node
/** Preview launcher with scoped Windows GPU preference and owned-process cleanup. */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gpuRequest, resolveLauncherChrome, applyWindowsGpuPreference, previewPort,
  startManaged, waitForOwnedEvent, stopManaged, exitCode } from './launcher-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serviceRoot = resolve(root, 'studio-broadcast');
let server, preference, stopping;
async function shutdown(code = 0) {
  if (stopping) return stopping;
  stopping = (async () => {
    const result = await stopManaged(server, { graceMs: 5000 });
    if (result.forced) { console.error('La preview non ha risposto all’arresto entro il timeout.'); if (!code) code = 1; }
    try {
      const restored = preference?.restore();
      if (restored?.reason === 'changed-externally') console.log('Preferenza GPU modificata da un altro processo: mantenuto il valore più recente.');
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
  console.log(`airewardrop Studio · Preferenza GPU richiesta: ${request.label}`);
  try { preference = applyWindowsGpuPreference(chrome, request); }
  catch (error) { throw new Error(`Impossibile applicare la preferenza GPU richiesta: ${error.message}`); }
  if (!preference.applied) console.log('Preferenza DXGI disponibile solo su Windows; il renderer verrà scelto dal sistema.');
  const port = await previewPort(5892);
  if (stopping) { await stopping; }
  else {
    if (port === 0) console.log('Porta 5892 già occupata: la preview userà una porta libera senza arrestare altri processi.');
    server = startManaged(process.execPath, ['--import', pathToFileURL(resolve(root, 'scripts/launcher-shutdown.mjs')).href,
      resolve(root, 'tools/preview-server.mjs'), '--studio', serviceRoot, '--port', String(port)], { cwd: root, ipc: true });
    const ready = await waitForOwnedEvent(server, event => typeof event.studio === 'string' && typeof event.preview === 'string');
    if (!stopping) {
      console.log(`Studio: ${ready.studio}`); console.log(`Personaggio: ${ready.preview}`);
      const browser = spawn(chrome, ['--new-window', '--autoplay-policy=no-user-gesture-required', ready.studio],
        { detached: true, stdio: 'ignore', windowsHide: false });
      browser.once('error', error => console.error(`Apertura Chrome non riuscita (${error.message}). Aprire manualmente ${ready.studio}`));
      browser.unref();
      console.log('Ctrl+C arresta soltanto la preview avviata da questo launcher.');
      const result = await server.done;
      if (!stopping) await shutdown(exitCode(result));
    }
  }
} catch (error) {
  if (!stopping) { console.error('Avvio preview non riuscito:', error.message); await shutdown(1); }
} finally {
  if (stopping) await stopping;
  process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
}
