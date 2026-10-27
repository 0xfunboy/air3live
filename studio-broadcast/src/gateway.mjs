import http from 'node:http';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, readdir, realpath, open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { NarrationQueue, QueueError, isSafeId, EMOTION_NAMES, EMOTION_ALIASES } from './queue.mjs';
import { synthesizeSpeech } from './speech.mjs';
import { generateLipSync } from './lip-sync.mjs';
import { createLiveService } from './live-service.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream', '.ktx2': 'image/ktx2', '.hdr': 'application/octet-stream',
  '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.wav': 'audio/wav',
};
const digest = (text) => createHash('sha256').update(text).digest();

function authorized(req, token) {
  const header = req.headers.authorization;
  return typeof header === 'string' && /^Bearer [^\s]+$/.test(header) &&
    timingSafeEqual(digest(header.slice(7)), digest(token));
}

function json(res, status, value) {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function body(req, limit) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new QueueError('JSON_REQUIRED', 415);
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new QueueError('BODY_TOO_LARGE', 413);
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw new QueueError('BODY_TOO_LARGE', 413);
    parts.push(part);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(parts, size).toString('utf8')); }
  catch { throw new QueueError('INVALID_JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new QueueError('INVALID_REQUEST');
  return value;
}

function publicConfig(config) {
  let dappBaseUrl = null;
  if (config.dappBaseUrl) {
    const url = new URL(config.dappBaseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('INVALID_DAPP_BASE_URL');
    }
    dappBaseUrl = url.toString().replace(/\/$/, '');
  }
  const avatarUrl = config.avatarUrl || null;
  if (avatarUrl && (typeof avatarUrl !== 'string' || !/^(?:\/studio)?\/assets\/[A-Za-z0-9_./-]+\.(?:glb|gltf)$/.test(avatarUrl) ||
      avatarUrl.includes('..') || avatarUrl.includes('\\') || avatarUrl.includes('?') || avatarUrl.includes('#') ||
      avatarUrl.includes('%') || /[\u0000-\u001f]/u.test(avatarUrl))) throw new Error('INVALID_AVATAR_URL');
  return { project: 'air3', dappBaseUrl, avatarUrl, defaultTimeframe: '1h', renderQuality: config.renderQuality || 'auto',
    width: config.width, height: config.height, fps: config.fps };
}

async function staticFile(req, res, pathname, config) {
  let root;
  let relative;
  let vendor = false;
  if ((pathname === '/' && config.live?.enabled) || pathname === '/control' || pathname === '/control/') {
    root = config.publicDir; relative = 'control/index.html';
  } else if (pathname === '/' || pathname === '/studio' || pathname === '/studio/') {
    root = config.publicDir;
    relative = 'index.html';
  } else if (pathname.startsWith('/studio/')) {
    root = config.publicDir;
    relative = pathname.slice('/studio/'.length);
  } else if (pathname.startsWith('/assets/')) {
    root = path.join(config.publicDir, 'assets');
    relative = pathname.slice('/assets/'.length);
  } else if (pathname.startsWith('/vendor/three/')) {
    root = path.join(config.nodeModulesDir, 'three');
    relative = pathname.slice('/vendor/three/'.length);
    vendor = true;
  } else if (pathname.startsWith('/vendor/chart.js/')) {
    root = path.join(config.nodeModulesDir, 'chart.js');
    relative = pathname.slice('/vendor/chart.js/'.length);
    vendor = true;
  } else {
    throw new QueueError('NOT_FOUND', 404);
  }
  if (!relative || relative.includes('\\') || relative.includes('\u0000') ||
      relative.split('/').some((part) => !part || part.startsWith('.'))) throw new QueueError('NOT_FOUND', 404);
  const ext = path.extname(relative).toLowerCase();
  if (!MIME[ext] || (vendor && !['.js', '.mjs', '.wasm'].includes(ext))) throw new QueueError('NOT_FOUND', 404);
  let actualRoot;
  let filename;
  try {
    actualRoot = await realpath(root);
    filename = await realpath(path.resolve(root, relative));
  } catch { throw new QueueError('NOT_FOUND', 404); }
  if (!filename.startsWith(actualRoot + path.sep)) throw new QueueError('NOT_FOUND', 404);
  const handle = await open(filename, 'r');
  const info = await handle.stat();
  if (!info.isFile() || info.size > 128 * 1024 * 1024) {
    await handle.close();
    throw new QueueError('NOT_FOUND', 404);
  }
  res.writeHead(200, { 'Content-Type': MIME[ext], 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') { await handle.close(); res.end(); return; }
  await pipeline(handle.createReadStream(), res);
}

export async function createGateway(config) {
  if (typeof config.producerToken !== 'string' || config.producerToken.length < 16 ||
      typeof config.playerToken !== 'string' || config.playerToken.length < 16 ||
      config.producerToken === config.playerToken) throw new Error('INVALID_GATEWAY_TOKENS');
  const visible = publicConfig(config);
  // Inline import maps require their own CSP hash. Derive it from the shipped HTML
  // so dependency-map edits do not silently disable all module imports.
  const indexHtml = await readFile(path.join(config.publicDir, 'index.html'), 'utf8');
  const importMaps = [...indexHtml.matchAll(/<script\s+type=["']importmap["']\s*>([\s\S]*?)<\/script\s*>/gi)];
  const importMapPolicy = importMaps.map((match) => ` 'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`).join('');
  const now = config.now || Date.now;
  const audioDir = path.join(config.dataDir, 'audio');
  await mkdir(audioDir, { recursive: true, mode: 0o700 });
  const queue = new NarrationQueue(path.join(config.dataDir, 'narrations.sqlite'), config.queue, now);
  const knownFiles = queue.referencedAudioFiles();
  for (const filename of await readdir(audioDir)) {
    if (/^[a-f0-9]{64}\.wav(?:\.part-[a-f0-9-]+)?$/.test(filename) && !knownFiles.has(filename)) {
      await rm(path.join(audioDir, filename), { force: true });
    }
  }
  let closing = false;
  let active = null;
  let worker = null;
  let sweepBusy = false;
  const makeAudioName = (id) => `${createHash('sha256').update(id).digest('hex')}.wav`;

  const work = async () => {
    while (!closing) {
      const job = queue.takeForGeneration();
      if (!job) return;
      const controller = new AbortController();
      active = { id: job.id, controller };
      let temp;
      let target;
      try {
        const speech = await synthesizeSpeech(config.tts, job, { fetchImpl: config.fetchImpl || fetch, signal: controller.signal });
        if (closing || controller.signal.aborted) continue;
        const name = makeAudioName(job.id);
        target = path.join(audioDir, name);
        temp = `${target}.part-${randomUUID()}`;
        await writeFile(temp, speech.bytes, { flag: 'wx', mode: 0o600 });
        await rename(temp, target);
        temp = null;
        const lipSync = await generateLipSync(config.lipSync, { audioPath: target,
          durationMs: speech.durationMs, language: job.language }, { signal: controller.signal });
        if (closing || controller.signal.aborted || !queue.markReady(job.id, name, speech.durationMs, lipSync)) {
          await rm(target, { force: true });
        }
      } catch (error) {
        if (!closing) queue.markFailed(job.id, error?.code);
        if (temp) await rm(temp, { force: true }).catch(() => {});
        if (target) await rm(target, { force: true }).catch(() => {});
      } finally { active = null; }
    }
  };

  const kick = () => {
    if (closing || worker) return;
    worker = work().catch(() => {
      // Internal paths/provider errors must not escape into public logs.
      if (active && !closing) queue.markFailed(active.id, 'TTS_WORKER_FAILED');
    }).finally(() => { worker = null; });
  };

  const housekeeping = async () => {
    if (closing || sweepBusy) return;
    sweepBusy = true;
    try {
      queue.sweep();
      if (active && queue.row(active.id)?.status !== 'generating') active.controller.abort();
      for (const row of queue.prune()) {
        if (row.audio_file && /^[a-f0-9]{64}\.wav$/.test(row.audio_file)) {
          await rm(path.join(audioDir, row.audio_file), { force: true });
        }
      }
      kick();
    } catch { /* Next tick retries; no user input or secret is logged. */ }
    finally { sweepBusy = false; }
  };

  let live;
  try { live = config.live?.enabled ? await createLiveService({ config, json, body,
    enqueue(input) { const result = queue.enqueue(input); kick(); return { id: result.id, status: result.status, duplicate: result.duplicate }; },
    cancel(id) { const job = queue.cancel(id); if (active?.id === id) active.controller.abort(); return job; },
    getNarration: id => queue.get(id), ...config.liveDependencies,
  }) : null; } catch (error) { queue.close(); throw error; }
  const dappOrigin = visible.dappBaseUrl ? ` ${new URL(visible.dappBaseUrl).origin}` : '';
  const csp = `default-src 'self'; script-src 'self'${importMapPolicy}; style-src 'self' 'unsafe-inline'; ` +
    `connect-src 'self' blob:${dappOrigin}${dappOrigin.replace(/^ http/, ' ws')}; img-src 'self' data: blob: https:; ` +
    `media-src 'self' blob:; worker-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`;
  const server = http.createServer({ maxHeaderSize: 16384 }, async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', csp);
    try {
      if (closing) throw new QueueError('GATEWAY_STOPPING', 503);
      let url;
      let pathname;
      try { url = new URL(req.url, 'http://localhost'); pathname = decodeURIComponent(url.pathname); }
      catch { throw new QueueError('INVALID_PATH'); }
      // Credentials in a URL are unsupported even if an Authorization header exists.
      if ([...url.searchParams.keys()].some((key) => /token|secret|key/i.test(key))) throw new QueueError('CREDENTIALS_IN_URL_NOT_ALLOWED');
      if (req.method === 'GET' && pathname === '/api/health') {
        return json(res, 200, { ok: true, service: 'air3-studio', queue: queue.counts(),
          speech: { mode: 'fully-buffered', lipSync: config.lipSync?.mode ?? 'off', clock: 'audio' } });
      }
      if (req.method === 'GET' && pathname === '/api/public-config') return json(res, 200, { ...visible, ...live?.publicConfig() });
      if (live && await live.handle(req, res, pathname, url)) return;
      if (req.method === 'GET' && (pathname === '/api/emotions' || pathname === '/api/expressions')) {
        return json(res, 200, { emotions: EMOTION_NAMES, aliases: EMOTION_ALIASES });
      }

      const producerRoute = pathname === '/api/narrations' || pathname.startsWith('/api/narrations/');
      const playerRoute = pathname.startsWith('/api/player/') || pathname.startsWith('/api/audio/');
      if (producerRoute && !authorized(req, config.producerToken)) throw new QueueError('UNAUTHORIZED', 401);
      if (playerRoute && !authorized(req, config.playerToken)) throw new QueueError('UNAUTHORIZED', 401);
      const bodyLimit = Math.min(256 * 1024, config.queue.maxTextChars * 6 + 4096);
      if (pathname === '/api/narrations' && req.method === 'POST') {
        const result = queue.enqueue(await body(req, bodyLimit));
        kick();
        return json(res, 202, { id: result.id, status: result.status, duplicate: result.duplicate });
      }
      let match = /^\/api\/narrations\/([^/]+)$/.exec(pathname);
      if (match && isSafeId(match[1])) {
        if (req.method === 'GET') {
          const job = queue.get(match[1]);
          if (!job) throw new QueueError('NOT_FOUND', 404);
          return json(res, 200, job);
        }
        if (req.method === 'DELETE') {
          const job = queue.cancel(match[1]);
          if (active?.id === match[1]) active.controller.abort();
          return json(res, 200, job);
        }
      }
      if (pathname === '/api/player/claim' && req.method === 'POST') {
        const input = await body(req, 4096);
        return json(res, 200, queue.claim(input.playerId));
      }
      match = /^\/api\/player\/([^/]+)\/events$/.exec(pathname);
      if (match && isSafeId(match[1]) && req.method === 'POST') {
        return json(res, 200, queue.playerEvent(match[1], await body(req, 4096)));
      }
      match = /^\/api\/audio\/([^/]+)$/.exec(pathname);
      if (match && isSafeId(match[1]) && req.method === 'GET') {
        const record = queue.audioRecord(match[1]);
        if (!/^[a-f0-9]{64}\.wav$/.test(record.audio_file)) throw new QueueError('AUDIO_NOT_AVAILABLE', 404);
        let bytes;
        try { bytes = await readFile(path.join(audioDir, record.audio_file)); }
        catch { throw new QueueError('AUDIO_NOT_AVAILABLE', 404); }
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
        return res.end(bytes);
      }
      if (pathname.startsWith('/api/')) throw new QueueError('NOT_FOUND', 404);
      if (!['GET', 'HEAD'].includes(req.method)) throw new QueueError('METHOD_NOT_ALLOWED', 405);
      await staticFile(req, res, pathname, config);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof QueueError ? error.statusCode : 500;
      if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
      if (status === 429) res.setHeader('Retry-After', '1');
      json(res, status, { error: error instanceof QueueError ? error.code : 'INTERNAL_ERROR' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  const timer = setInterval(() => { void housekeeping(); }, Math.min(1000, Math.max(50, Math.floor(config.queue.leaseMs / 3))));
  timer.unref();
  kick();
  let closePromise;
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    clearInterval(timer);
    active?.controller.abort();
    closePromise = (async () => {
      let liveError;
      try { if (live) await live.close(); } catch (error) { liveError = error; }
      await new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeIdleConnections();
      });
      if (worker) await worker;
      while (sweepBusy) await new Promise((resolve) => setTimeout(resolve, 5));
      queue.close();
      if (liveError) throw liveError;
    })();
    return closePromise;
  };
  return { server, close, live };
}
