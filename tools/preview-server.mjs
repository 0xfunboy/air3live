#!/usr/bin/env node
// Local read-only preview. No producer token, TTS calls or narration claims.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
const args = process.argv.slice(2), at = args.indexOf('--studio');
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const studio = await realpath(at >= 0 ? path.resolve(args[at + 1]) : path.join(packageRoot, 'studio-broadcast'));
const publicRoot = await realpath(path.join(studio, 'public')), three = await realpath(path.join(studio, 'node_modules/three')), chart = await realpath(path.join(studio, 'node_modules/chart.js'));
const portAt = args.indexOf('--port'), port = portAt < 0 ? 5892 : Number(args[portAt + 1]);
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid preview port');
const mime = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.wav': 'audio/wav', '.hdr': 'application/octet-stream' };
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const server = http.createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Preview is read-only' });
    let url = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (url === '/api/health') return json(res, 200, { ok: true, service: 'air3-readonly-preview', preview: true });
    if (url === '/api/emotions' || url === '/api/expressions') return json(res, 200, {
      emotions: ['neutral', 'happy', 'sad', 'surprised', 'warm', 'focused', 'concerned'],
      aliases: { felice: 'happy', triste: 'sad', stupita: 'surprised', sorpresa: 'surprised', cordiale: 'warm', concentrata: 'focused', preoccupata: 'concerned', neutra: 'neutral' }
    });
    if (url === '/api/public-config') return json(res, 200, { project: 'air3', preview: true, dappBaseUrl: null, avatarUrl: '/assets/air3/models/AIR3-runtime.glb', defaultTimeframe: '1h', width: 1920, height: 1080, fps: 30 });
    if (url === '/') url = '/studio/preview/index.html'; else if (url === '/studio' || url === '/studio/') url = '/studio/index.html';
    let root, relative;
    if (url.startsWith('/studio/')) { root = publicRoot; relative = url.slice(8); }
    else if (url.startsWith('/assets/')) { root = publicRoot; relative = url.slice(1); }
    else if (url.startsWith('/vendor/three/')) { root = three; relative = url.slice(14); }
    else if (url.startsWith('/vendor/chart.js/')) { root = chart; relative = url.slice(17); }
    else return json(res, 404, { error: 'Not found' });
    if (!relative || relative.includes('\\') || relative.includes('\0') || relative.split('/').some((x) => !x || x.startsWith('.'))) throw new Error('Path');
    const file = await realpath(path.resolve(root, relative));
    if (!file.startsWith(root + path.sep) || !mime[path.extname(file)]) throw new Error('Path');
    const info = await stat(file); if (!info.isFile() || info.size > 128 * 1024 * 1024) throw new Error('File');
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)], 'Content-Length': info.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    if (req.method === 'HEAD') { res.end(); return; } await pipeline(createReadStream(file), res);
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ preview: `http://127.0.0.1:${server.address().port}/`, studio: `http://127.0.0.1:${server.address().port}/studio`, readOnly: true })));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { server.closeAllConnections(); server.close(); });
