import { spawn } from 'node:child_process';

export function redact(text, secrets = []) {
  let value = String(text);
  // Include the serialized spelling for nested JSON messages and URL query
  // spellings. Redacting only raw secrets after JSON.stringify misses quotes,
  // backslashes and control escapes in credentials.
  const variants = new Set(secrets.filter(s => typeof s === 'string' && s.length).flatMap(s => {
    let encoded = ''; try { encoded = encodeURIComponent(s); } catch {}
    return [s, JSON.stringify(s).slice(1, -1), encoded].filter(Boolean);
  }));
  for (const secret of [...variants].sort((a, b) => b.length - a.length)) value = value.split(secret).join('[redacted]');
  return value.replace(/\b(?:rtmps?|rtsps?):\/\/[^\s"']+/gi, '[stream destination]');
}

/** Sanitize strings before serialization while retaining typed telemetry. */
export function redactValue(value, secrets = []) {
  const seen = new WeakSet();
  function walk(item, depth = 0) {
    if (typeof item === 'string') return redact(item, secrets);
    if (item === null || typeof item !== 'object') return item;
    if (depth > 16) return '[truncated]';
    if (seen.has(item)) return '[circular]';
    seen.add(item);
    const result = Array.isArray(item) ? item.map(v => walk(v, depth + 1))
      : Object.fromEntries(Object.entries(item).map(([key, v]) => [redact(key, secrets), walk(v, depth + 1)]));
    seen.delete(item); return result;
  }
  return walk(value);
}

export function encoderArgs(config, encoder, destination) {
  const { width, height, fps } = config.gateway;
  const pixelFormat = encoder === 'h264_qsv' ? 'nv12' : 'yuv420p';
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-thread_queue_size', '256',
    '-fflags', '+genpts', '-i', 'pipe:0', '-map', '0:v:0', '-map', '0:a:0',
    '-vf', `scale=${width}:${height}:flags=bilinear,format=${pixelFormat}`,
    '-r', String(fps), '-fps_mode', 'cfr', '-c:v', encoder,
    '-b:v', `${config.bitrateKbps}k`, '-maxrate', `${config.bitrateKbps}k`, '-bufsize', `${config.bitrateKbps * 2}k`,
    '-g', String(fps * 2), '-keyint_min', String(fps * 2), '-bf', '0', '-pix_fmt', pixelFormat];
  if (encoder === 'h264_nvenc') args.push('-preset', 'p4', '-tune', 'll', '-rc', 'cbr');
  else if (encoder === 'h264_qsv') args.push('-preset', 'veryfast', '-look_ahead', '0');
  else args.push('-preset', 'veryfast', '-tune', 'zerolatency', '-sc_threshold', '0');
  args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-af', 'aresample=async=1:first_pts=0');
  if (config.mode === 'file') args.push('-f', 'matroska', '-n', destination);
  else if (config.mode === 'rtmp') args.push('-f', 'flv', '-flvflags', 'no_duration_filesize', destination);
  else args.push('-f', 'rtsp', '-rtsp_transport', 'tcp', destination);
  return args;
}

async function works(ffmpeg, codec, { signal, spawnImpl = spawn } = {}) {
  if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
  return new Promise((resolve, reject) => {
    const proc = spawnImpl(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=320x180:r=30',
      '-frames:v', '2', '-c:v', codec, '-f', 'null', '-'], { stdio: 'ignore' });
    let settled = false;
    const finish = (value, error) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const kill = () => { try { proc.kill('SIGKILL'); } catch {} };
    const abort = () => { finish(false, signal.reason || new DOMException('Aborted', 'AbortError')); kill(); };
    const timer = setTimeout(() => { kill(); finish(false); }, 10000); timer.unref?.();
    proc.once('error', () => finish(false));
    proc.once('exit', (code) => finish(code === 0));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function selectEncoder(config, options = {}) {
  if (config.encoder !== 'auto') {
    if (!await works(config.ffmpeg, config.encoder, options)) throw new Error(`Requested encoder ${config.encoder} failed its actual encode probe`);
    return config.encoder;
  }
  if (await works(config.ffmpeg, 'h264_nvenc', options)) return 'h264_nvenc';
  if (await works(config.ffmpeg, 'h264_qsv', options)) return 'h264_qsv';
  if (await works(config.ffmpeg, 'libx264', options)) return 'libx264';
  throw new Error('No supported H264 encoder passed the actual encode probe');
}

export function softwareRenderer(diagnostics) {
  const renderer = String(diagnostics.gpuRenderer || diagnostics.gpu?.renderer || diagnostics.renderer || '');
  return !renderer || /swiftshader|llvmpipe|softpipe|software|microsoft basic render/i.test(renderer);
}
