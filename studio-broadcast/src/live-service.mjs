import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { QueueError } from './queue.mjs';
import { createOperatorAuth, bearerMatches } from './live-auth.mjs';
import { createLiveSettingsStore, defaultLiveSettings, VIDEO_PROFILES } from './live-settings.mjs';
import { createEditorialStore } from './live-editorial.mjs';
import { LiveProcess } from './live-process.mjs';
import { createLiveMarketService } from './live-market.mjs';
import { createTwitchChat } from './twitch-chat.mjs';

export async function createLiveService({ config, json, body, enqueue, cancel, getNarration,
  baseEnv = process.env, processFactory = options => new LiveProcess(options), marketFactory = createLiveMarketService,
  chatFactory = createTwitchChat }) {
  const store = await createLiveSettingsStore(config.dataDir, defaultLiveSettings(config));
  const editorial = await createEditorialStore(config.dataDir);
  const auth = createOperatorAuth(config.live);
  const broadcaster = processFactory({ config, getSettings: () => store.get(), baseEnv });
  const market = marketFactory({ dataDir: config.dataDir, config: store.get().market });
  const chat = chatFactory({ getConfig: () => store.get().twitch,
    saveTokens: (patch, options = {}) => store.update({ twitch: patch }, { internal: true, ...options }) });
  let revision = 1, closing = false;
  config.tts = { ...config.tts, ...store.get().tts };
  await market.start();
  void chat.start().catch(() => {}); // Chat connectivity never delays the local control room.
  const externalChat = [];
  function program() {
    const s = store.get();
    return { schema: 'air3.live.program.v1', revision, scene: s.scene, look: s.look, titles: editorial.get(),
      streaming: ['running', 'stalled', 'reconnecting'].includes(broadcaster.snapshot().phase) };
  }
  function publisher(req) {
    if (bearerMatches(req, config.producerToken)) {
      if (req.headers.origin && !auth.sameOrigin(req)) throw new QueueError('ORIGIN_NOT_ALLOWED', 403);
      return;
    }
    auth.requireOperator(req, { mutation: true });
  }
  function ownedOrigin(req) {
    // Rendering stays on the owned local gateway even behind an HTTPS reverse proxy.
    const port = req.socket.localPort || config.port; config.port = port;
    return `http://127.0.0.1:${port}`;
  }
  async function recordings() {
    const dir = resolve(config.dataDir, 'recordings');
    let files; try { files = await readdir(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return Promise.all(files.filter(name => /^studio-[a-zA-Z0-9_.-]+\.mkv$/.test(name)).slice(-50).reverse().map(async name => {
      const info = await stat(resolve(dir, name)); return { name, bytes: info.size, updatedAt: info.mtimeMs };
    }));
  }
  async function handle(req, res, pathname, url) {
    if (!pathname.startsWith('/api/live/') && pathname !== '/api/titles') return false;
    if (closing) throw new QueueError('LIVE_STOPPING', 503);
    if (req.method === 'GET' && pathname === '/api/live/program') { json(res, 200, program()); return true; }
    if (req.method === 'GET' && pathname === '/api/live/market') { json(res, 200, market.snapshot()); return true; }
    if (req.method === 'GET' && pathname === '/api/live/session') {
      const authenticated = !!auth.session(req) || bearerMatches(req, config.live.operatorToken);
      json(res, 200, { authenticated }); return true;
    }
    if (req.method === 'POST' && pathname === '/api/live/session') { json(res, 200, auth.login(req, res, await body(req, 4096))); return true; }
    if (req.method === 'DELETE' && pathname === '/api/live/session') { auth.logout(req, res); json(res, 200, { authenticated: false }); return true; }
    if (pathname === '/api/live/twitch/callback' && req.method === 'GET') {
      const session = auth.requireOperator(req);
      try {
        if (url.searchParams.has('error')) throw new Error('OAuth refused');
        await chat.callback({ code: url.searchParams.get('code'), state: url.searchParams.get('state'),
          redirectUri: auth.origin(req) + '/api/live/twitch/callback', sessionId: session.id });
        res.writeHead(303, { Location: '/control?twitch=connected', 'Cache-Control': 'no-store' }); res.end();
      } catch { res.writeHead(303, { Location: '/control?twitch=failed', 'Cache-Control': 'no-store' }); res.end(); }
      return true;
    }
    if (['/api/live/titles', '/api/titles'].includes(pathname)) {
      if (req.method === 'GET') { auth.requireOperator(req); json(res, 200, editorial.get()); return true; }
      if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE') {
        publisher(req);
        const value = await editorial.update(req.method === 'DELETE' ? { enabled: false, title: '', subtitle: '', ticker: [] } : await body(req, 16384));
        revision++; json(res, 200, value); return true;
      }
    }
    if (pathname === '/api/live/wallpanel' && req.method === 'POST') {
      publisher(req); let value;
      try { value = await market.setWallpanel(await body(req, 128 * 1024)); }
      catch (e) { if (e instanceof QueueError) throw e; throw new QueueError('INVALID_WALLPANEL', 400); }
      json(res, 200, value); return true;
    }
    if (pathname === '/api/live/chat/ingest' && req.method === 'POST') {
      publisher(req); const value = await body(req, 8192);
      if (!value || !['restream', 'external'].includes(value.provider) || typeof value.text !== 'string' ||
        value.text.length > 1000 || typeof value.author !== 'string' || value.author.length > 80) throw new QueueError('INVALID_CHAT_MESSAGE', 400);
      const clean = text => text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
      const row = { id: randomUUID(), provider: value.provider, author: clean(value.author), text: clean(value.text), receivedAt: Date.now() };
      externalChat.push(row); if (externalChat.length > 100) externalChat.shift(); json(res, 202, { id: row.id }); return true;
    }
    const session = auth.requireOperator(req, { mutation: !['GET', 'HEAD'].includes(req.method) });
    if (pathname === '/api/live/status' && req.method === 'GET') {
      json(res, 200, { schema: 'air3.live.status.v1', broadcast: broadcaster.snapshot(), settings: store.public(),
        titles: editorial.get(), chat: chat.publicState(), externalChat: externalChat.slice(-50), market: market.publicConfig(),
        redirectUri: auth.origin(req) + '/api/live/twitch/callback' }); return true;
    }
    if (pathname === '/api/live/settings' && req.method === 'GET') { json(res, 200, store.public()); return true; }
    if (pathname === '/api/live/settings' && req.method === 'PATCH') {
      const patch = await body(req, 64 * 1024), before = store.get();
      if (patch.stream && (broadcaster.child || broadcaster.busy)) throw new QueueError('STOP_BEFORE_STREAM_SETTINGS', 409);
      const next = await store.update(patch);
      config.tts = { ...config.tts, ...next.tts }; revision++;
      if (JSON.stringify(before.market) !== JSON.stringify(next.market)) await market.configure(next.market);
      if (patch.twitch) void Promise.resolve(chat.configure()).catch(() => {});
      json(res, 200, store.public()); return true;
    }
    if (pathname === '/api/live/preflight' && req.method === 'POST') {
      const input = await body(req, 4096); json(res, 200, await broadcaster.preflight(input.mode || 'record', ownedOrigin(req))); return true;
    }
    if (pathname === '/api/live/start' && req.method === 'POST') {
      const input = await body(req, 4096); json(res, 202, await broadcaster.start(input.mode || 'live', ownedOrigin(req))); return true;
    }
    if (pathname === '/api/live/stop' && req.method === 'POST') { json(res, 200, await broadcaster.stop()); return true; }
    if (pathname === '/api/live/command' && req.method === 'POST') {
      const command = await body(req, 4096);
      if (!['monitor', 'home', 'test-voice', 'stop-test-voice'].includes(command.type) ||
        (command.type === 'monitor' && !['left', 'center', 'right'].includes(command.monitor)) ||
        Object.keys(command).some(k => !['type', 'monitor'].includes(k))) throw new QueueError('INVALID_LIVE_COMMAND', 400);
      json(res, 200, await broadcaster.command(command)); return true;
    }
    if (pathname === '/api/live/preview.jpg' && req.method === 'GET') {
      broadcaster.requestPreview?.();
      if (!broadcaster.preview) { res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return true; }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': broadcaster.preview.length, 'Cache-Control': 'no-store' }); res.end(broadcaster.preview); return true;
    }
    if (pathname === '/api/live/narrations' && req.method === 'POST') {
      const input = await body(req, 64 * 1024); input.id ||= 'operator-' + randomUUID();
      json(res, 202, enqueue(input)); return true;
    }
    const narration = /^\/api\/live\/narrations\/([a-zA-Z0-9][a-zA-Z0-9_.-]{0,127})$/.exec(pathname);
    if (narration && req.method === 'GET') { const row = getNarration(narration[1]); if (!row) throw new QueueError('NOT_FOUND', 404); json(res, 200, row); return true; }
    if (narration && req.method === 'DELETE') { json(res, 200, cancel(narration[1])); return true; }
    if (pathname === '/api/live/twitch/authorize' && req.method === 'POST') {
      json(res, 200, await chat.authorize({ redirectUri: auth.origin(req) + '/api/live/twitch/callback', sessionId: session.id })); return true;
    }
    if (pathname === '/api/live/twitch/disconnect' && req.method === 'POST') { await chat.clearAuth(); json(res, 200, chat.publicState()); return true; }
    if (pathname === '/api/live/recordings' && req.method === 'GET') { json(res, 200, { recordings: await recordings() }); return true; }
    const recording = /^\/api\/live\/recordings\/(studio-[a-zA-Z0-9_.-]+\.mkv)$/.exec(pathname);
    if (recording && req.method === 'GET') {
      let handle; try { handle = await open(resolve(config.dataDir, 'recordings', recording[1]), 'r'); } catch { throw new QueueError('NOT_FOUND', 404); }
      const info = await handle.stat();
      res.writeHead(200, { 'Content-Type': 'video/x-matroska', 'Content-Length': info.size,
        'Content-Disposition': `attachment; filename="${recording[1]}"`, 'Cache-Control': 'no-store' });
      await pipeline(handle.createReadStream(), res); return true;
    }
    throw new QueueError('NOT_FOUND', 404);
  }
  return { handle, broadcaster, store, market, chat, program,
    publicConfig() { const s = store.get(); return { live: true, renderQuality: s.stream.quality, ...VIDEO_PROFILES[s.stream.profile] }; },
    async close() {
      closing = true;
      const results = await Promise.allSettled([broadcaster.close(), Promise.resolve(chat.stop()), Promise.resolve(market.stop())]);
      const failed = results.find(r => r.status === 'rejected'); if (failed) throw failed.reason;
    },
  };
}
