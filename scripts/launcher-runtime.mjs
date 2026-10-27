import { spawn, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseEnv } from 'node:util';

export function gpuRequest(value = 'intel') {
  const name = String(value).toLowerCase();
  if (['intel', 'arc'].includes(name)) return { id: 'intel', preference: '1', encoder: 'h264_qsv', label: 'basso consumo / Intel, se disponibile' };
  if (['nvidia', 'rtx'].includes(name)) return { id: 'nvidia', preference: '2', encoder: 'h264_nvenc', label: 'alte prestazioni / NVIDIA, se disponibile' };
  throw new Error('GPU non valida: usare intel oppure nvidia');
}

export async function resolveLauncherChrome(serviceRoot, env = process.env, platform = process.platform) {
  let fileEnvironment = {};
  try { fileEnvironment = parseEnv(await readFile(path.join(serviceRoot, '.env'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let executable = env.AIR3_CHROME_PATH || fileEnvironment.AIR3_CHROME_PATH;
  if (!executable) try { executable = (await readFile(path.join(serviceRoot, '.browser-path'), 'utf8')).trim(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!executable && platform === 'win32') executable = path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
  if (!executable) throw new Error('Chrome non configurato: eseguire npm run browser:install --prefix studio-broadcast oppure impostare AIR3_CHROME_PATH');
  await access(executable, constants.F_OK);
  return executable;
}

const APPLY_GPU_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$application = $env:AIR3_LAUNCHER_GPU_APP
$preference = $env:AIR3_LAUNCHER_GPU_PREFERENCE
if ([string]::IsNullOrWhiteSpace($application) -or $preference -notin @('1','2')) { throw 'Invalid GPU preference request' }
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\\Microsoft\\DirectX\\UserGpuPreferences')
try {
  $existed = $key.GetValueNames() -contains $application
  $kind = $null; $serialized = $null
  if ($existed) {
    $kind = $key.GetValueKind($application).ToString()
    $prior = $key.GetValue($application, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $serialized = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Management.Automation.PSSerializer]::Serialize($prior)))
  }
  $applied = 'GpuPreference=' + $preference + ';'
  $key.SetValue($application, $applied, [Microsoft.Win32.RegistryValueKind]::String)
  @{ existed=$existed; kind=$kind; serialized=$serialized; applied=$applied } | ConvertTo-Json -Compress
} finally { $key.Dispose() }
`;

const RESTORE_GPU_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$application = $env:AIR3_LAUNCHER_GPU_APP
$record = $env:AIR3_LAUNCHER_GPU_PRIOR | ConvertFrom-Json
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\DirectX\\UserGpuPreferences', $true)
if ($null -eq $key) { @{ restored=$false; reason='key-removed-externally' } | ConvertTo-Json -Compress; exit 0 }
try {
  $current = $key.GetValue($application, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($current -isnot [string] -or $current -cne $record.applied) { @{ restored=$false; reason='changed-externally' } | ConvertTo-Json -Compress; exit 0 }
  if ($record.existed) {
    $xml = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($record.serialized))
    $prior = [Management.Automation.PSSerializer]::Deserialize($xml)
    $kind = [Enum]::Parse([Microsoft.Win32.RegistryValueKind], $record.kind)
    $key.SetValue($application, $prior, $kind)
  } else { $key.DeleteValue($application, $false) }
  @{ restored=$true } | ConvertTo-Json -Compress
} finally { $key.Dispose() }
`;

function powershellJson(source, environment, execute) {
  const encoded = Buffer.from(source, 'utf16le').toString('base64');
  const output = execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { env: environment, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  return JSON.parse(String(output).replace(/^\uFEFF/, '').trim());
}

/** A typed registry snapshot is retained only in this launcher process. */
export function applyWindowsGpuPreference(executable, request, { platform = process.platform, env = process.env, execute = execFileSync } = {}) {
  if (platform !== 'win32') return { applied: false, restore: () => ({ restored: false, reason: 'not-windows' }) };
  const base = { ...env, AIR3_LAUNCHER_GPU_APP: executable, AIR3_LAUNCHER_GPU_PREFERENCE: request.preference };
  const prior = powershellJson(APPLY_GPU_SCRIPT, base, execute);
  if (typeof prior.existed !== 'boolean' || prior.applied !== `GpuPreference=${request.preference};`) throw new Error('Risposta preferenza GPU non valida');
  let result = null;
  return { applied: true, restore() {
    if (result) return result;
    result = powershellJson(RESTORE_GPU_SCRIPT, { ...base, AIR3_LAUNCHER_GPU_PRIOR: JSON.stringify(prior) }, execute);
    return result;
  } };
}

/** If the requested preview port belongs to another process, ask the OS for a new one. */
export function previewPort(preferred = 5892) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', error => error.code === 'EADDRINUSE' ? resolve(0) : reject(error));
    probe.listen(preferred, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve(preferred)));
  });
}

/** Spawn a process owned by this launcher; always attach error/exit listeners. */
export function startManaged(command, args, { cwd, env = process.env, stdout = process.stdout, stderr = process.stderr, ipc = false } = {}) {
  const events = new EventEmitter(), seen = [];
  // Separate process groups keep a terminal Ctrl+C from stopping the gateway
  // at the same instant as the encoder. The parent owns shutdown ordering.
  const child = spawn(command, args, { cwd, env, detached: true, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] });
  let buffer = '', ended = null, resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const finish = result => { if (ended) return; ended = result; resolveDone(result); events.emit('ended', result); };
  child.on('error', error => finish({ code: 1, signal: null, error }));
  child.once('exit', (code, signal) => finish({ code, signal }));
  child.stdout.on('data', bytes => {
    stdout?.write(bytes); buffer += bytes.toString('utf8');
    if (buffer.length > 1024 * 1024) buffer = buffer.slice(-65536);
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      try { const value = JSON.parse(line); seen.push(value); if (seen.length > 32) seen.shift(); events.emit('json', value); } catch {}
    }
  });
  child.stderr.on('data', bytes => stderr?.write(bytes));
  return { child, events, seen, done, get ended() { return ended; } };
}

export function waitForOwnedEvent(managed, predicate, timeoutMs = 15000) {
  const existing = managed.seen.find(predicate); if (existing) return Promise.resolve(existing);
  if (managed.ended) return Promise.reject(managed.ended.error || new Error(`Il processo è terminato prima dell'avvio (${managed.ended.code ?? managed.ended.signal})`));
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); managed.events.off('json', onJson); managed.events.off('ended', onEnd); };
    const onJson = value => { if (!predicate(value)) return; cleanup(); resolve(value); };
    const onEnd = result => { cleanup(); reject(result.error || new Error(`Il processo è terminato prima dell'avvio (${result.code ?? result.signal})`)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timeout nell’attesa dell’avvio del processo controllato')); }, timeoutMs);
    managed.events.on('json', onJson); managed.events.once('ended', onEnd);
  });
}

export function exitCode(result) {
  return Number.isInteger(result?.code) && result.code >= 0 ? result.code : result?.signal === 'SIGINT' ? 130 : result?.signal === 'SIGTERM' ? 143 : 1;
}

export async function stopManaged(managed, { graceMs = 20000, platform = process.platform } = {}) {
  if (!managed) return { forced: false, result: null };
  if (managed.ended) return { forced: false, result: managed.ended };
  const child = managed.child;
  // Node's child.kill(SIGTERM) is a forced termination on Windows. An owned
  // IPC preload emits SIGTERM inside the child so its async cleanup can run.
  if (platform === 'win32' && child.connected) {
    try { child.send({ type: 'air3-launcher-shutdown' }, error => { if (error && !managed.ended) child.kill('SIGTERM'); }); }
    catch { child.kill('SIGTERM'); }
  } else child.kill('SIGTERM');
  let timer;
  const result = await Promise.race([managed.done, new Promise(resolve => { timer = setTimeout(() => resolve(null), graceMs); })]);
  clearTimeout(timer);
  if (result) return { forced: false, result };
  child.kill('SIGKILL');
  return { forced: true, result: await managed.done };
}
