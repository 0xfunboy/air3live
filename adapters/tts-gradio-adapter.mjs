#!/usr/bin/env node
/**
 * AIR3 Live — OpenAI-compatible Speech Adapter for Kokoro Gradio API
 *
 * Implements POST /v1/audio/speech and translates requests to the remote Gradio
 * /generate_full endpoint with Basic Auth + X-API-Key authentication.
 * Returns RIFF/WAVE PCM16 24kHz mono audio.
 */

import http from 'node:http';
import { parsePcmWav } from '../studio-broadcast/src/speech.mjs';

const PORT = parseInt(process.env.TTS_ADAPTER_PORT || '8880', 10);
const HOST = process.env.TTS_ADAPTER_HOST || '127.0.0.1';
const GRADIO_URL = (process.env.KOKORO_GRADIO_URL || 'https://tts-api.airewardrop.xyz').replace(/\/+$/, '');
const BASIC_USER = process.env.KOKORO_BASIC_USER || 'api';
const BASIC_PASS = process.env.KOKORO_BASIC_PASS || 'iUwA7B5JSg0wP861iq9RuQ';
const API_KEY = process.env.KOKORO_API_KEY || 'dPGlbL6gwK2UUi76U92riEZVBwu9iS';

const AUTH_HEADER = 'Basic ' + Buffer.from(`${BASIC_USER}:${BASIC_PASS}`).toString('base64');

const SUPPORTED_VOICES = new Set([
  'af_jessica', 'af_heart', 'af_bella', 'af_nicole', 'af_aoede', 'af_kore',
  'af_sarah', 'af_nova', 'af_sky', 'af_alloy', 'af_river',
  'am_michael', 'am_fenrir', 'am_puck', 'am_echo', 'am_eric', 'am_liam',
  'am_onyx', 'am_santa', 'am_adam',
  'bf_emma', 'bf_isabella', 'bf_alice', 'bf_lily',
  'bm_george', 'bm_fable', 'bm_lewis', 'bm_daniel'
]);

// Map unsupported voices (e.g. Italian if_sara from target spec) to closest equivalent
function normalizeVoice(voice) {
  if (SUPPORTED_VOICES.has(voice)) return voice;
  if (voice === 'if_sara' || voice?.startsWith('if_') || voice?.startsWith('it_')) {
    console.warn(`[TTS-Adapter] Voice '${voice}' not supported in remote Gradio pipeline (EN only). Falling back to af_jessica.`);
    return 'af_jessica';
  }
  return 'af_jessica';
}

async function callGradioTts(text, voice = 'af_jessica', speed = 1.0) {
  const chosenVoice = normalizeVoice(voice);
  const targetSpeed = Math.max(0.5, Math.min(2.0, Number(speed) || 1.0));

  // 1. Submit job to /gradio_api/call/generate_full
  const callRes = await fetch(`${GRADIO_URL}/gradio_api/call/generate_full`, {
    method: 'POST',
    headers: {
      'Authorization': AUTH_HEADER,
      'X-API-Key': API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      data: [text, chosenVoice, targetSpeed, true]
    }),
    signal: AbortSignal.timeout(60000)
  });

  if (!callRes.ok) {
    const errorText = await callRes.text().catch(() => '');
    throw new Error(`Gradio job submission failed: HTTP ${callRes.status} ${errorText}`);
  }

  const { event_id } = await callRes.json();
  if (!event_id) throw new Error('Gradio did not return an event_id');

  // 2. Poll/Read SSE event
  const sseRes = await fetch(`${GRADIO_URL}/gradio_api/call/generate_full/${event_id}`, {
    headers: {
      'Authorization': AUTH_HEADER,
      'X-API-Key': API_KEY
    },
    signal: AbortSignal.timeout(60000)
  });

  if (!sseRes.ok) {
    throw new Error(`Gradio SSE failed: HTTP ${sseRes.status}`);
  }

  const sseBody = await sseRes.text();
  if (sseBody.includes('event: error')) {
    throw new Error(`Gradio SSE returned error: ${sseBody.slice(0, 300)}`);
  }

  const match = sseBody.match(/data:\s*(\[.*?\])(?:\n|$)/s);
  if (!match) {
    throw new Error(`Failed to extract data payload from Gradio SSE: ${sseBody.slice(0, 300)}`);
  }

  const eventData = JSON.parse(match[1]);
  const fileInfo = eventData[0];
  if (!fileInfo?.url) {
    throw new Error('Gradio payload missing audio file URL');
  }

  const rawUrl = fileInfo.url.replace(/^http:/, 'https:');

  // 3. Download the audio file
  const audioRes = await fetch(rawUrl, {
    headers: {
      'Authorization': AUTH_HEADER,
      'X-API-Key': API_KEY
    },
    signal: AbortSignal.timeout(60000)
  });

  if (!audioRes.ok) {
    throw new Error(`Failed to download audio file: HTTP ${audioRes.status}`);
  }

  const arrayBuf = await audioRes.arrayBuffer();
  const wavBuffer = Buffer.from(arrayBuf);

  // Validate PCM16 WAV structure
  parsePcmWav(wavBuffer);
  return wavBuffer;
}

// Simple request queue to limit concurrency to 2
let inFlight = 0;
const MAX_CONCURRENT = 2;
const queue = [];

function enqueueJob(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (inFlight >= MAX_CONCURRENT || queue.length === 0) return;
  inFlight++;
  const { task, resolve, reject } = queue.shift();
  try {
    const result = await task();
    resolve(result);
  } catch (err) {
    reject(err);
  } finally {
    inFlight--;
    processQueue();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);

  // Health check
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', inFlight, queueLength: queue.length }));
    return;
  }

  // Model list
  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'kokoro', object: 'model', owned_by: 'air3' }]
    }));
    return;
  }

  // OpenAI Speech endpoint
  if (req.method === 'POST' && (url.pathname === '/v1/audio/speech' || url.pathname === '/audio/speech')) {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 256 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Payload too large', type: 'invalid_request_error' } }));
        req.destroy();
      }
    });

    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const text = payload.input || payload.text;
        if (!text || typeof text !== 'string' || !text.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Missing input text', type: 'invalid_request_error' } }));
          return;
        }

        const voice = payload.voice || 'af_jessica';
        const speed = payload.speed || 1.0;

        const wavBytes = await enqueueJob(() => callGradioTts(text, voice, speed));

        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': wavBytes.length,
          'Cache-Control': 'no-cache'
        });
        res.end(wavBytes);
      } catch (err) {
        console.error('[TTS-Adapter Error]', err.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message, type: 'api_error' } }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not found', type: 'invalid_request_error' } }));
});

server.listen(PORT, HOST, () => {
  console.log(`[TTS-Adapter] Listening on http://${HOST}:${PORT}/v1/audio/speech`);
  console.log(`[TTS-Adapter] Connected to remote Gradio: ${GRADIO_URL}`);
});

function shutdown() {
  server.close(() => {
    console.log('[TTS-Adapter] Stopped.');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

