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
    if (result.forced) { console.error('Preview did not respond to shutdown within timeout.'); if (!code) code = 1; }
    try {
      const restored = preference?.restore();
      if (restored?.reason === 'changed-externally') console.log('GPU preference modified by another process: retained latest value.');
    } catch (error) { console.error('Failed to restore GPU preference:', error.message); if (!code) code = 1; }
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
  if (stopping) throw new Error('Startup aborted');
  console.log(`airewardrop Studio · Requested GPU preference: ${request.label}`);
  try { preference = applyWindowsGpuPreference(chrome, request); }
  catch (error) { throw new Error(`Cannot apply requested GPU preference: ${error.message}`); }
  if (!preference.applied) console.log('DXGI preference available on Windows only; system will select renderer.');
  const port = await previewPort(5892);
  if (stopping) { await stopping; }
  else {
    if (port === 0) console.log('Port 5892 is occupied: preview will use an available free port.');
    server = startManaged(process.execPath, ['--import', pathToFileURL(resolve(root, 'scripts/launcher-shutdown.mjs')).href,
      resolve(root, 'tools/preview-server.mjs'), '--studio', serviceRoot, '--port', String(port)], { cwd: root, ipc: true });
    const ready = await waitForOwnedEvent(server, event => typeof event.studio === 'string' && typeof event.preview === 'string');
    if (!stopping) {
      console.log(`Studio: ${ready.studio}`); console.log(`Character: ${ready.preview}`);
      const browser = spawn(chrome, ['--new-window', '--autoplay-policy=no-user-gesture-required', ready.studio],
        { detached: true, stdio: 'ignore', windowsHide: false });
      browser.once('error', error => console.error(`Failed to open Chrome (${error.message}). Open manually: ${ready.studio}`));
      browser.unref();
      console.log('Ctrl+C stops only the preview started by this launcher.');
      const result = await server.done;
      if (!stopping) await shutdown(exitCode(result));
    }
  }
} catch (error) {
  if (!stopping) { console.error('Preview startup failed:', error.message); await shutdown(1); }
} finally {
  if (stopping) await stopping;
  process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
}
