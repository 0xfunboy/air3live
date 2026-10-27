import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

export const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function integer(env, key, fallback, min, max) {
  const value = env[key] === undefined || env[key] === '' ? fallback : Number(env[key]);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer between ${min} and ${max}`);
  return value;
}
function number(env, key, fallback, min, max) {
  const value = env[key] === undefined || env[key] === '' ? fallback : Number(env[key]);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} is outside its supported range`);
  return value;
}
function bool(env, key, fallback = false) {
  if (env[key] === undefined || env[key] === '') return fallback;
  if (!['true', 'false'].includes(env[key])) throw new Error(`${key} must be true or false`);
  return env[key] === 'true';
}
function httpUrl(value, name, nullable = false) {
  if (!value && nullable) return null;
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be a valid HTTP URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`${name} must be HTTP(S), without embedded credentials, query, or fragment`);
  return url.toString().replace(/\/$/, '');
}
function secret(env, key) {
  const value = env[key] || '';
  if (value.length < 32 || /[\r\n]/.test(value)) throw new Error(`${key} must contain at least 32 characters; run npm run init`);
  return value;
}

export function loadConfig(env = process.env) {
  const producerToken = secret(env, 'AIR3_PRODUCER_TOKEN');
  const playerToken = secret(env, 'AIR3_PLAYER_TOKEN');
  if (producerToken === playerToken) throw new Error('Producer and player tokens must be different');
  const liveEnabled = bool(env, 'AIR3_LIVE_ENABLED', false);
  const operatorToken = liveEnabled ? secret(env, 'AIR3_OPERATOR_TOKEN') : '';
  if (liveEnabled && [producerToken, playerToken].includes(operatorToken)) throw new Error('Operator, producer and player tokens must be different');
  const publicOrigin = httpUrl(env.AIR3_PUBLIC_ORIGIN, 'AIR3_PUBLIC_ORIGIN', true);
  if (publicOrigin && new URL(publicOrigin).pathname !== '/') throw new Error('AIR3_PUBLIC_ORIGIN must be an origin without path');
  const avatarUrl = env.AIR3_AVATAR_URL || null;
  const lipSyncMode = env.AIR3_LIPSYNC_MODE || 'auto';
  if (!['auto', 'required', 'off'].includes(lipSyncMode)) throw new Error('AIR3_LIPSYNC_MODE must be auto, required or off');
  const renderQuality = env.AIR3_RENDER_QUALITY || 'auto';
  if (!['auto', 'high', 'balanced', 'software'].includes(renderQuality)) throw new Error('Unsupported AIR3_RENDER_QUALITY');
  if (avatarUrl && (!/^\/assets\/[A-Za-z0-9_./-]+\.(glb|gltf)$/.test(avatarUrl) || avatarUrl.includes('..'))) throw new Error('AIR3_AVATAR_URL must identify a local GLB/glTF under /assets/');
  return {
    host: env.AIR3_HOST || '127.0.0.1',
    port: integer(env, 'AIR3_PORT', 5890, 1, 65535),
    dataDir: resolve(serviceRoot, env.AIR3_DATA_DIR || './data'),
    publicDir: resolve(serviceRoot, 'public'), nodeModulesDir: resolve(serviceRoot, 'node_modules'),
    producerToken, playerToken,
    live: { enabled: liveEnabled, operatorToken, publicOrigin, localOperator: bool(env, 'AIR3_LOCAL_OPERATOR', true) },
    dappBaseUrl: httpUrl(env.AIR3_DAPP_BASE_URL, 'AIR3_DAPP_BASE_URL', true), avatarUrl, renderQuality,
    width: integer(env, 'AIR3_WIDTH', 1920, 320, 3840),
    height: integer(env, 'AIR3_HEIGHT', 1080, 180, 2160),
    fps: integer(env, 'AIR3_FPS', 30, 1, 60),
    lipSync: { mode: lipSyncMode, binary: env.AIR3_RHUBARB_PATH || '',
      timeoutMs: integer(env, 'AIR3_LIPSYNC_TIMEOUT_MS', 45000, 1000, 120000),
      threads: integer(env, 'AIR3_LIPSYNC_THREADS', 2, 1, 8) },
    tts: {
      baseUrl: httpUrl(env.AIR3_TTS_BASE_URL || 'http://127.0.0.1:8880/v1', 'AIR3_TTS_BASE_URL'),
      apiKey: env.AIR3_TTS_API_KEY || '', model: env.AIR3_TTS_MODEL || 'kokoro',
      voiceEn: env.AIR3_TTS_VOICE_EN || 'af_jessica', voiceIt: env.AIR3_TTS_VOICE_IT || 'if_sara',
      speed: number(env, 'AIR3_TTS_SPEED', 1, 0.5, 2),
      timeoutMs: integer(env, 'AIR3_TTS_TIMEOUT_MS', 60000, 1000, 120000),
      maxChunkChars: integer(env, 'AIR3_TTS_CHUNK_CHARS', 600, 80, 2000),
    },
    queue: {
      maxPending: integer(env, 'AIR3_QUEUE_LIMIT', 20, 1, 100),
      maxTextChars: integer(env, 'AIR3_MAX_TEXT_CHARS', 8000, 50, 16000),
      maxAgeMs: integer(env, 'AIR3_NARRATION_TTL_MS', 300000, 10000, 900000),
      leaseMs: integer(env, 'AIR3_PLAYER_LEASE_MS', 15000, 3000, 60000),
      retentionMs: integer(env, 'AIR3_RETENTION_MS', 3600000, 60000, 86400000),
    },
  };
}

export function loadBroadcastConfig(env = process.env) {
  const gateway = loadConfig(env);
  const url = new URL(env.AIR3_STUDIO_URL || `http://127.0.0.1:${gateway.port}/studio?output=1`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('AIR3_STUDIO_URL must be an HTTP(S) URL without embedded credentials');
  if (url.pathname.replace(/\/$/, '') !== '/studio') throw new Error('AIR3_STUDIO_URL must point to the owned /studio entry point');
  const mode = env.AIR3_OUTPUT_MODE || 'file';
  if (!['file', 'rtmp', 'rtsp'].includes(mode)) throw new Error('AIR3_OUTPUT_MODE must be file, rtmp or rtsp');
  let outputUrl = null;
  if (mode !== 'file') {
    const raw = mode === 'rtmp' ? env.AIR3_RTMP_URL : env.AIR3_RTSP_URL;
    let target;
    try { target = new URL(raw); } catch { throw new Error(`A valid ${mode.toUpperCase()} output URL is required`); }
    if (!(mode === 'rtmp' ? ['rtmp:', 'rtmps:'] : ['rtsp:', 'rtsps:']).includes(target.protocol)) throw new Error('Output protocol does not match output mode');
    outputUrl = target.toString();
    if (mode === 'rtmp' && env.AIR3_RTMP_KEY) outputUrl = outputUrl.replace(/\/$/, '') + '/' + env.AIR3_RTMP_KEY;
  }
  const encoder = env.AIR3_VIDEO_ENCODER || 'auto';
  if (!['auto', 'libx264', 'h264_nvenc', 'h264_qsv'].includes(encoder)) throw new Error('AIR3_VIDEO_ENCODER must be auto, libx264, h264_nvenc or h264_qsv');
  const angle = env.AIR3_CHROME_ANGLE || 'default';
  if (!['default', 'vulkan', 'gl', 'swiftshader'].includes(angle)) throw new Error('Unsupported AIR3_CHROME_ANGLE');
  let browserPath = env.AIR3_CHROME_PATH || '';
  if (!browserPath) { try { browserPath = readFileSync(resolve(serviceRoot, '.browser-path'), 'utf8').trim(); } catch {} }
  if (!browserPath) throw new Error('Set AIR3_CHROME_PATH or run npm run browser:install');
  return {
    gateway, studioUrl: url.toString(), mode, outputUrl, encoder, angle, browserPath,
    controlStdin: bool(env, 'AIR3_CONTROL_STDIN'),
    recordingDir: resolve(serviceRoot, env.AIR3_RECORDING_DIR || './recordings'),
    ffmpeg: env.AIR3_FFMPEG || 'ffmpeg',
    noSandbox: bool(env, 'AIR3_CHROME_NO_SANDBOX'),
    requireHardware: bool(env, 'AIR3_REQUIRE_HARDWARE_RENDERING', mode !== 'file'),
    bitrateKbps: integer(env, 'AIR3_VIDEO_BITRATE_KBPS', 4500, 500, 20000),
    captureBitrateKbps: integer(env, 'AIR3_CAPTURE_BITRATE_KBPS', 10000, 1000, 40000),
    durationSeconds: integer(env, 'AIR3_BROADCAST_DURATION_SECONDS', 0, 0, 86400),
    maxRestarts: integer(env, 'AIR3_MAX_RESTARTS', 5, 0, 100),
    maxBufferBytes: integer(env, 'AIR3_MAX_CAPTURE_BUFFER_MB', 16, 2, 128) * 1024 * 1024,
  };
}
