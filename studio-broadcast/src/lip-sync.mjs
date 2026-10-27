import { execFile } from 'node:child_process';
import { access, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { normalizeMouthCues } from '../public/lip-sync.mjs';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = '1.14.0';

export class LipSyncError extends Error {
  constructor(code) { super(code); this.name = 'LipSyncError'; this.code = code; }
}

export function bundledRhubarb(platform = process.platform, architecture = process.arch) {
  if (architecture !== 'x64' || !['linux', 'win32'].includes(platform)) return null;
  return resolve(root, 'vendor/rhubarb', version, `${platform}-${architecture}`, platform === 'win32' ? 'rhubarb.exe' : 'rhubarb');
}

/** Run once on the completed WAV, before it becomes claimable by a player. */
export async function generateLipSync(config, { audioPath, durationMs, language }, { signal } = {}) {
  const mode = config?.mode ?? 'off';
  if (mode === 'off') return { kind: 'amplitude', reason: 'disabled' };
  const binary = config.binary || bundledRhubarb();
  const timeoutMs = config.timeoutMs ?? 45000;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const started = performance.now();
  try {
    if (!binary) throw new Error('unsupported platform');
    combined.throwIfAborted();
    await access(binary, constants.F_OK);
    // ZIP extraction on Linux may discard the executable bit. Only repair the
    // bundled executable, never an operator-provided path.
    if (process.platform !== 'win32' && binary === bundledRhubarb()) await chmod(binary, 0o755);
    const recognizer = language === 'en' ? 'pocketSphinx' : 'phonetic';
    const { stdout } = await execute(binary, ['--quiet', '--consoleLevel', 'error', '--exportFormat', 'json',
      '--recognizer', recognizer, '--extendedShapes', 'GHX', '--threads', String(config.threads ?? 2), audioPath],
    { signal: combined, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      windowsHide: true, shell: false, encoding: 'utf8' });
    combined.throwIfAborted();
    const parsed = JSON.parse(stdout), duration = durationMs / 1000;
    const mouthCues = normalizeMouthCues(parsed.mouthCues, duration);
    if (!mouthCues.length) throw new Error('empty timeline');
    return { kind: 'rhubarb', version, recognizer, clock: 'audio', duration,
      processingMs: Math.round(performance.now() - started), mouthCues };
  } catch {
    if (signal?.aborted) throw new LipSyncError('TTS_CANCELLED');
    const reason = timeout.aborted ? 'alignment-timeout' : 'alignment-unavailable';
    if (mode === 'required') throw new LipSyncError(timeout.aborted ? 'TTS_LIPSYNC_TIMEOUT' : 'TTS_LIPSYNC_UNAVAILABLE');
    return { kind: 'amplitude', reason };
  }
}
