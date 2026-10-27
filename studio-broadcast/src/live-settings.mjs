import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultLook, validateLookPreset } from '../public/look-presets.mjs';
import { QueueError } from './queue.mjs';
import { validateMarketConfig } from './live-market.mjs';

export const LIVE_SCHEMA = 'air3.live.settings.v1';
const clone = value => structuredClone(value);
const FIELDS = Object.freeze({
  stream: ['provider', 'server', 'key', 'profile', 'bitrateKbps', 'encoder', 'quality', 'twitchBandwidthTest', 'autoRecovery'],
  scene: ['camera', 'emotion', 'intensity', 'eyeContact', 'roaming'],
  tts: ['baseUrl', 'apiKey', 'model', 'voiceIt', 'voiceEn', 'speed'],
  market: ['enabled', 'provider', 'symbol', 'range', 'wallpanelSource', 'coinglassKey'],
  twitch: ['enabled', 'clientId', 'clientSecret', 'channel', 'accessToken', 'refreshToken', 'userId', 'login', 'scopes', 'expiresAt'],
});
export function defaultLiveSettings(config = {}) {
  return { schema: LIVE_SCHEMA,
    stream: { provider: 'restream', server: '', key: '', profile: '1080p30', bitrateKbps: 4500,
      encoder: 'auto', quality: 'balanced', twitchBandwidthTest: false, autoRecovery: true },
    scene: { camera: 'auto', emotion: 'happy', intensity: 1, eyeContact: true, roaming: false },
    look: defaultLook(),
    tts: { baseUrl: config.tts?.baseUrl || 'http://127.0.0.1:8880/v1', apiKey: config.tts?.apiKey || '',
      model: config.tts?.model || 'kokoro', voiceIt: config.tts?.voiceIt || 'if_sara', voiceEn: config.tts?.voiceEn || 'af_jessica', speed: config.tts?.speed || 1 },
    market: { enabled: true, provider: 'binance', symbol: 'BTCUSDT', range: '24h', wallpanelSource: 'external', coinglassKey: '' },
    twitch: { enabled: false, clientId: '', clientSecret: '', channel: '', accessToken: '', refreshToken: '', userId: '', login: '', scopes: [], expiresAt: 0 },
  };
}
function fail(field) { throw new QueueError('INVALID_LIVE_SETTINGS', 400, `Valore non valido: ${field}`); }
function object(v, allowed, field) {
  if (!v || typeof v !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(v)) || Object.keys(v).some(k => !allowed.includes(k))) fail(field);
}
function text(v, max, field, empty = true) {
  if (typeof v !== 'string' || v.length > max || /[\u0000-\u001f\u007f]/.test(v) || (!empty && !v.trim())) fail(field);
  return v.trim();
}
function choice(v, values, field) { if (!values.includes(v)) fail(field); return v; }
function bool(v, field) { if (typeof v !== 'boolean') fail(field); return v; }
function number(v, min, max, field, integer = false) { if (!Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) fail(field); return v; }
export function streamDestination(stream, { test = stream.twitchBandwidthTest } = {}) {
  if (!stream.server || !stream.key) throw new QueueError('STREAM_DESTINATION_REQUIRED', 400);
  const base = new URL(stream.server);
  base.pathname = base.pathname.replace(/\/$/, '') + '/' + stream.key.split('?')[0];
  const query = stream.key.indexOf('?');
  if (query >= 0) base.search = stream.key.slice(query + 1);
  if (stream.provider === 'twitch' && test) base.searchParams.set('bandwidthtest', 'true');
  return base.toString();
}
export const VIDEO_PROFILES = Object.freeze({ '720p30': { width: 1280, height: 720, fps: 30 },
  '1080p30': { width: 1920, height: 1080, fps: 30 }, '1080p60': { width: 1920, height: 1080, fps: 60 } });

export function mergeLiveSettings(previous, patch, { internal = false } = {}) {
  object(patch, ['stream', 'scene', 'look', 'tts', 'market', 'twitch'], 'Impostazioni');
  const next = clone(previous);
  for (const section of ['stream', 'scene', 'tts', 'market', 'twitch']) if (patch[section] !== undefined) {
    const allowed = [...FIELDS[section]];
    if (section === 'twitch' && !internal) allowed.splice(0, allowed.length, 'enabled', 'clientId', 'clientSecret', 'channel');
    object(patch[section], allowed, section);
    Object.assign(next[section], patch[section]);
  }
  if (patch.look !== undefined) {
    try { next.look = validateLookPreset(patch.look); } catch { fail('look'); }
  }
  const s = next.stream;
  if ((s.provider !== previous.stream.provider || s.server !== previous.stream.server) && patch.stream && !Object.hasOwn(patch.stream, 'key')) s.key = '';
  s.provider = choice(s.provider, ['restream', 'twitch', 'custom'], 'Destinazione');
  s.server = text(s.server, 2048, 'Server streaming'); s.key = text(s.key, 1024, 'Stream key');
  if (s.key && /[\s#\\]/.test(s.key)) fail('Stream key');
  if (s.server) {
    let u; try { u = new URL(s.server); } catch { fail('Server streaming'); }
    if (!['rtmp:', 'rtmps:'].includes(u.protocol) || !u.hostname || u.username || u.password || u.search || u.hash) fail('Server streaming');
    if (s.provider === 'restream' && !/(^|\.)restream\.io$/i.test(u.hostname)) fail('Server Restream');
    if (s.provider === 'twitch' && !/(^|\.)(live-video\.net|twitch\.tv)$/i.test(u.hostname)) fail('Server Twitch');
    s.server = u.toString().replace(/\/$/, '');
  }
  choice(s.profile, Object.keys(VIDEO_PROFILES), 'Risoluzione'); number(s.bitrateKbps, 500, 20000, 'Bitrate', true);
  choice(s.encoder, ['auto', 'libx264', 'h264_nvenc', 'h264_qsv'], 'Encoder');
  choice(s.quality, ['auto', 'high', 'balanced', 'software'], 'Qualità'); bool(s.twitchBandwidthTest, 'Test Twitch');
  if (s.autoRecovery === undefined) s.autoRecovery = true; else bool(s.autoRecovery, 'Auto-Recovery');
  const a = next.scene;
  choice(a.camera, ['auto', 'wide', 'presenter', 'screens'], 'Camera');
  choice(a.emotion, ['neutral', 'happy', 'sad', 'surprised', 'warm', 'focused', 'concerned'], 'Espressione');
  number(a.intensity, 0, 1, 'Intensità'); bool(a.eyeContact, 'Sguardo'); bool(a.roaming, 'Movimento');
  const t = next.tts;
  t.baseUrl = text(t.baseUrl, 2048, 'Server voce', false);
  let tu; try { tu = new URL(t.baseUrl); } catch { fail('Server voce'); }
  if (!['http:', 'https:'].includes(tu.protocol) || tu.username || tu.password || tu.search || tu.hash) fail('Server voce');
  t.baseUrl = tu.toString().replace(/\/$/, '');
  for (const key of ['model', 'voiceIt', 'voiceEn']) t[key] = text(t[key], 160, key, false);
  t.apiKey = text(t.apiKey, 4096, 'Chiave TTS'); number(t.speed, .5, 2, 'Velocità voce');
  const m = next.market;
  bool(m.enabled, 'Dati mercato'); choice(m.provider, ['binance', 'coinglass', 'demo'], 'Fonte heatmap');
  choice(m.symbol, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], 'Simbolo'); choice(m.range, ['12h', '24h', '3d', '7d'], 'Intervallo');
  choice(m.wallpanelSource, ['market', 'external'], 'Wallpanel'); m.coinglassKey = text(m.coinglassKey, 512, 'Chiave CoinGlass');
  try { validateMarketConfig(m); } catch { fail('Fonte mercato'); }
  const c = next.twitch; bool(c.enabled, 'Chat Twitch');
  c.clientId = text(c.clientId, 128, 'Twitch Client ID'); c.clientSecret = text(c.clientSecret, 1024, 'Twitch Client secret');
  c.channel = text(c.channel, 25, 'Canale Twitch').replace(/^#/, '').toLowerCase();
  if (c.channel && !/^[a-z0-9_]{1,25}$/.test(c.channel)) fail('Canale Twitch');
  if (c.clientId && !/^[a-z0-9]+$/i.test(c.clientId)) fail('Twitch Client ID');
  for (const key of ['accessToken', 'refreshToken', 'userId', 'login']) c[key] = text(c[key], 4096, key);
  if (!Array.isArray(c.scopes) || c.scopes.some(v => typeof v !== 'string' || v.length > 100)) fail('Twitch scope');
  number(c.expiresAt, 0, Number.MAX_SAFE_INTEGER, 'Twitch scadenza');
  if (previous.twitch.clientId !== c.clientId || previous.twitch.clientSecret !== c.clientSecret) {
    c.accessToken = ''; c.refreshToken = ''; c.userId = ''; c.login = ''; c.scopes = []; c.expiresAt = 0;
  }
  return next;
}

export function publicLiveSettings(value) {
  const out = clone(value);
  out.stream.hasKey = !!out.stream.key; delete out.stream.key;
  out.tts.hasApiKey = !!out.tts.apiKey; delete out.tts.apiKey;
  out.market.hasCoinglassKey = !!out.market.coinglassKey; delete out.market.coinglassKey;
  out.twitch.hasClientSecret = !!out.twitch.clientSecret; out.twitch.authorized = !!out.twitch.accessToken;
  for (const key of ['clientSecret', 'accessToken', 'refreshToken', 'scopes', 'expiresAt', 'userId']) delete out.twitch[key];
  return out;
}

export async function createLiveSettingsStore(dataDir, defaults = defaultLiveSettings()) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = resolve(dataDir, 'live-settings.json');
  let value = defaults, writeChain = Promise.resolve();
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved.schema !== LIVE_SCHEMA) throw new Error('Unsupported live settings');
    const { schema, ...patch } = saved;
    // Use the saved client identity as baseline, so loading does not invalidate its tokens.
    value = mergeLiveSettings({ ...defaults, twitch: { ...defaults.twitch, ...saved.twitch } }, patch, { internal: true });
    await chmod(file, 0o600);
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('LIVE_SETTINGS_UNREADABLE'); }
  return {
    get: () => clone(value), public: () => publicLiveSettings(value),
    update(patch, options) {
      const task = writeChain.then(async () => {
        if (typeof options?.guard === 'function' && !options.guard(clone(value))) throw new QueueError('LIVE_SETTINGS_CONFLICT', 409);
        const candidate = mergeLiveSettings(value, patch, options);
        const temp = file + '.tmp-' + randomUUID();
        await writeFile(temp, JSON.stringify(candidate, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temp, file); value = candidate; return clone(value);
      });
      writeChain = task.catch(() => {}); return task;
    },
  };
}
