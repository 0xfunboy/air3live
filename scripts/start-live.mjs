#!/usr/bin/env node
/** Standalone control-room launcher. Starting this file never starts a stream. */
import { spawn } from 'node:child_process';
import { readFile, writeFile, rename, chmod, open, rm, access } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { gpuRequest, resolveLauncherChrome, applyWindowsGpuPreference,
  startManaged, waitForOwnedEvent, stopManaged, exitCode } from './launcher-runtime.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Preserve the entire old .env text, adding only the live-module defaults.
 * An exclusive short-lived lock also protects a double-click during migration.
 * No key or environment value is returned for logging.
 */
export async function prepareLiveEnv(serviceRoot) {
  const file = resolve(serviceRoot, '.env'), lockPath = file + '.live-init.lock';
  let lock;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { lock = await open(lockPath, 'wx', 0o600); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; await delay(50); }
  }
  if (!lock) throw new Error('LIVE_INIT_BUSY');
  let temporary;
  try {
    let source, created = false;
    try { source = await readFile(file, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      source = await readFile(resolve(serviceRoot, '.env.example'), 'utf8'); created = true;
      source = source.replaceAll('GENERATE_PRODUCER_TOKEN', randomBytes(32).toString('hex'))
        .replaceAll('GENERATE_PLAYER_TOKEN', randomBytes(32).toString('hex'))
        .replaceAll('GENERATE_OPERATOR_TOKEN', randomBytes(32).toString('hex'));
    }
    const parsed = parseEnv(source), additions = [], changedKeys = [];
    if (!parsed.AIR3_OPERATOR_TOKEN || parsed.AIR3_OPERATOR_TOKEN === 'GENERATE_OPERATOR_TOKEN') {
      additions.push('AIR3_OPERATOR_TOKEN=' + randomBytes(32).toString('hex')); changedKeys.push('AIR3_OPERATOR_TOKEN');
    }
    if (parsed.AIR3_LIVE_ENABLED !== 'true') { additions.push('AIR3_LIVE_ENABLED=true'); changedKeys.push('AIR3_LIVE_ENABLED'); }
    if (additions.length) source += (source.endsWith('\n') ? '' : '\n') + '\n# #AIR3 Live standalone configuration.\n' + additions.join('\n') + '\n';
    if (created || additions.length) {
      temporary = file + '.live-' + randomUUID();
      await writeFile(temporary, source, { flag: 'wx', mode: 0o600 });
      await rename(temporary, file); temporary = null;
    }
    await chmod(file, 0o600);
    return { file, created, changedKeys };
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => {});
    await lock.close(); await rm(lockPath, { force: true });
  }
}

export function liveControlUrl(host, port, publicOrigin) {
  if (publicOrigin) return new URL('/control', publicOrigin).toString();
  // Twitch's documented HTTP OAuth examples use localhost. Keep the browser
  // session and callback on that same host; the gateway bind/render URL stays
  // on its configured loopback address and remote HTTPS origins stay intact.
  const localHost = ['localhost', '127.0.0.1', '::1', '0.0.0.0', '::', undefined, ''].includes(host) ? 'localhost' : host;
  return new URL('/control', `http://${localHost}:${port}`).toString();
}

export async function runLiveLauncher({ root = ROOT, gpu = process.argv[2] } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24 || typeof process.loadEnvFile !== 'function') throw new Error('NODE_24_REQUIRED');
  const service = resolve(root, 'studio-broadcast');
  await access(resolve(service, 'node_modules/three/package.json')).catch(() => { throw new Error('RUN_SETUP_FIRST'); });
  let gateway, stopping = null, stderr = '', preference = null;
  async function shutdown(code = 0) {
    if (stopping) return stopping;
    stopping = (async () => {
      const stopped = await stopManaged(gateway, { graceMs: 50_000 });
      if (stopped.forced && !code) code = 1;
      try {
        const restored = preference?.restore();
        if (restored?.reason === 'changed-externally') console.log('Preferenza GPU modificata esternamente.');
      } catch {}
      process.exitCode = code;
    })();
    return stopping;
  }
  const interrupt = () => { void shutdown(130); }, terminate = () => { void shutdown(143); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    let chrome;
    try { chrome = await resolveLauncherChrome(service); } catch {}
    const requestedGpu = gpu || (process.platform === 'win32' ? 'nvidia' : null);
    if (chrome && requestedGpu && process.platform === 'win32') {
      try {
        const request = gpuRequest(requestedGpu);
        console.log(`airewardrop Live · GPU richiesta per Chrome: ${request.label}`);
        preference = applyWindowsGpuPreference(chrome, request);
      } catch (err) {
        console.log(`Nota GPU: ${err.message}`);
      }
    }
    const prepared = await prepareLiveEnv(service);
    if (stopping) { await stopping; return; }
    process.loadEnvFile(prepared.file);
    // External environment remains authoritative; this entry point explicitly
    // enables the control room, never an encoder or a public broadcast.
    const env = { ...process.env, AIR3_LIVE_ENABLED: 'true' };
    gateway = startManaged(process.execPath, ['--import', pathToFileURL(resolve(root, 'scripts/launcher-shutdown.mjs')).href, 'src/main.mjs'],
      { cwd: service, env, ipc: true, stdout: null, stderr: { write(bytes) { stderr = (stderr + bytes.toString()).slice(-32_000); } } });
    const ready = await waitForOwnedEvent(gateway, row => row.event === 'gateway-listening', 60_000);
    if (stopping) { await stopping; return; }

    const controlUrl = liveControlUrl(ready.host, ready.port, env.AIR3_PUBLIC_ORIGIN);
    const studioHost = ['0.0.0.0', '::', undefined, ''].includes(ready.host) ? '127.0.0.1' : ready.host;
    const studioUrl = new URL('/studio', `http://${studioHost}:${ready.port}`).toString();

    console.log('========================================================================');
    console.log('✓ #AIR3 Live Standalone 3.0 avviato con successo!');
    console.log(`✓ Finestra 1 (Regia Live): ${controlUrl}`);
    console.log(`✓ Finestra 2 (Studio 3D) : ${studioUrl}`);
    console.log('========================================================================');
    console.log('Apertura automatica di entrambe le finestre nel browser in corso...');
    console.log('Ctrl+C nel terminale arresta il servizio.');

    function openBrowser(targetUrl) {
      if (chrome) {
        const proc = spawn(chrome, ['--new-window', '--autoplay-policy=no-user-gesture-required', targetUrl],
          { detached: true, stdio: 'ignore', windowsHide: false });
        proc.once('error', () => {
          if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '', targetUrl], { detached: true, stdio: 'ignore' }).unref();
        });
        proc.unref();
      } else {
        if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '', targetUrl], { detached: true, stdio: 'ignore' }).unref();
      }
    }

    openBrowser(controlUrl);
    await delay(700);
    openBrowser(studioUrl);

    const result = await gateway.done;
    if (!stopping) await shutdown(exitCode(result));
  } catch (error) {
    if (!stopping) {
      const message = /EADDRINUSE/.test(stderr) ? 'Porta già occupata. La regia esistente è rimasta attiva.'
        : error.message === 'LIVE_INIT_BUSY' ? 'Inizializzazione già in corso. Riprova tra pochi secondi.'
        : /AIR3_.*must|Operator, producer and player tokens must|Producer and player tokens must/.test(stderr)
          ? 'Configurazione .env non valida: verifica i parametri e le tre chiavi distinte, senza rigenerare quelle già in uso.'
          : 'Avvio della regia non riuscito. Verifica Node 24, npm run setup e la configurazione .env.';
      console.error(message); await shutdown(1);
    }
  } finally {
    if (stopping) await stopping;
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLiveLauncher().catch(error => {
    console.error(error.message === 'NODE_24_REQUIRED' ? 'Installa Node.js 24 o successivo.'
      : error.message === 'RUN_SETUP_FIRST' ? 'Esegui npm run setup nella cartella del progetto, poi npm run live.'
        : 'Avvio della regia non riuscito. Verifica installazione e accesso alla cartella.');
    process.exitCode = 1;
  });
}
