/** Fully buffered OpenAI-compatible speech synthesis. No progressive playout. */
export class SpeechError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SpeechError';
    this.code = code;
  }
}

export const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 32 * 1024 * 1024;
const MAX_AUDIO_MS = 10 * 60 * 1000;

/** Prefer sentence/word boundaries; never lose, duplicate or reorder text. */
export function splitSpeechText(text, maxChars = 450) {
  if (typeof text !== 'string' || !text.trim()) throw new SpeechError('TTS_EMPTY_TEXT');
  if (!Number.isInteger(maxChars) || maxChars < 32 || maxChars > 10000) {
    throw new SpeechError('TTS_INVALID_CHUNK_LIMIT');
  }
  let remaining = text.trim();
  const chunks = [];
  while (remaining.length > maxChars) {
    let cut = maxChars;
    const candidate = remaining.slice(0, maxChars);
    const boundaries = [...candidate.matchAll(/[.!?;\n](?:\s|$)/gu)];
    const sentence = boundaries.at(-1);
    if (sentence && sentence.index + 1 >= Math.floor(maxChars / 3)) {
      cut = sentence.index + 1;
    } else {
      const space = candidate.lastIndexOf(' ');
      if (space >= Math.floor(maxChars / 3)) cut = space;
    }
    // Do not split a surrogate pair, even when a single unbroken word is huge.
    const last = remaining.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut--;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/** Validate and normalize RIFF/WAVE PCM16; reject compressed/float WAV. */
export function parsePcmWav(input, maxBytes = MAX_AUDIO_BYTES) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length > maxBytes) throw new SpeechError('TTS_AUDIO_TOO_LARGE');
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.toString('ascii', 8, 12) !== 'WAVE') throw new SpeechError('TTS_INVALID_WAV');
  const declared = bytes.readUInt32LE(4);
  // Some HTTP WAV encoders use the documented streaming-size sentinel. The
  // response has already finished, so its bounded byte length is authoritative.
  if (declared !== 0xffffffff && declared + 8 !== bytes.length) {
    throw new SpeechError('TTS_TRUNCATED_WAV');
  }
  let format;
  let pcm;
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new SpeechError('TTS_TRUNCATED_WAV');
    const kind = bytes.toString('ascii', offset, offset + 4);
    let size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (size === 0xffffffff && kind === 'data') size = bytes.length - start;
    if (start + size > bytes.length) throw new SpeechError('TTS_TRUNCATED_WAV');
    if (kind === 'fmt ') {
      if (format || size < 16) throw new SpeechError('TTS_INVALID_WAV_FORMAT');
      const encoding = bytes.readUInt16LE(start);
      const channels = bytes.readUInt16LE(start + 2);
      const sampleRate = bytes.readUInt32LE(start + 4);
      const byteRate = bytes.readUInt32LE(start + 8);
      const blockAlign = bytes.readUInt16LE(start + 12);
      const bitsPerSample = bytes.readUInt16LE(start + 14);
      if (encoding !== 1 || bitsPerSample !== 16 || ![1, 2].includes(channels) ||
          sampleRate < 8000 || sampleRate > 96000 || blockAlign !== channels * 2 ||
          byteRate !== sampleRate * blockAlign) throw new SpeechError('TTS_UNSUPPORTED_WAV_FORMAT');
      format = { channels, sampleRate, bitsPerSample, blockAlign, byteRate };
    } else if (kind === 'data') {
      if (pcm) throw new SpeechError('TTS_MULTIPLE_WAV_DATA_CHUNKS');
      pcm = bytes.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
    if (offset > bytes.length) throw new SpeechError('TTS_TRUNCATED_WAV');
  }
  if (!format || !pcm?.length || pcm.length % format.blockAlign !== 0) {
    throw new SpeechError('TTS_INVALID_WAV_DATA');
  }
  const durationMs = pcm.length / format.byteRate * 1000;
  if (durationMs > MAX_AUDIO_MS) throw new SpeechError('TTS_AUDIO_TOO_LONG');
  return { ...format, pcm, durationMs };
}

export function assemblePcmWav(parts) {
  if (!parts.length) throw new SpeechError('TTS_EMPTY_AUDIO');
  const first = parts[0];
  let total = 0;
  for (const part of parts) {
    if (part.channels !== first.channels || part.sampleRate !== first.sampleRate ||
        part.bitsPerSample !== first.bitsPerSample) throw new SpeechError('TTS_INCOMPATIBLE_SEGMENTS');
    total += part.pcm.length;
    if (total + 44 > MAX_AUDIO_BYTES) throw new SpeechError('TTS_AUDIO_TOO_LARGE');
  }
  const durationMs = total / first.byteRate * 1000;
  if (durationMs > MAX_AUDIO_MS) throw new SpeechError('TTS_AUDIO_TOO_LONG');
  const wav = Buffer.allocUnsafe(44 + total);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + total, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(first.channels, 22);
  wav.writeUInt32LE(first.sampleRate, 24);
  wav.writeUInt32LE(first.byteRate, 28);
  wav.writeUInt16LE(first.blockAlign, 32);
  wav.writeUInt16LE(first.bitsPerSample, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(total, 40);
  let offset = 44;
  for (const part of parts) {
    part.pcm.copy(wav, offset);
    offset += part.pcm.length;
  }
  return { bytes: wav, durationMs, sampleRate: first.sampleRate, channels: first.channels };
}

function speechEndpoint(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new SpeechError('TTS_INVALID_BASE_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new SpeechError('TTS_INVALID_BASE_URL');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/audio/speech') ? path :
    path.endsWith('/v1') ? `${path}/audio/speech` : `${path}/v1/audio/speech`;
  return url.toString();
}

async function boundedBody(response, limit, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new SpeechError('TTS_AUDIO_TOO_LARGE');
  }
  if (!response.body) throw new SpeechError('TTS_EMPTY_AUDIO');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new SpeechError('TTS_AUDIO_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
}

export async function synthesizeSpeech(tts, job, { fetchImpl = fetch, signal } = {}) {
  const endpoint = speechEndpoint(tts.baseUrl);
  const voice = job.language === 'it' ? tts.voiceIt : tts.voiceEn;
  if (typeof voice !== 'string' || !voice || typeof tts.model !== 'string' || !tts.model) {
    throw new SpeechError('TTS_INVALID_MODEL_OR_VOICE');
  }
  const timeoutMs = tts.timeoutMs ?? 60000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 600000) {
    throw new SpeechError('TTS_INVALID_TIMEOUT');
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const headers = { 'Content-Type': 'application/json', Accept: 'audio/wav' };
  if (tts.apiKey) headers.Authorization = `Bearer ${tts.apiKey}`;
  const parts = [];
  let total = 0;
  try {
    for (const text of splitSpeechText(job.text, tts.maxChunkChars ?? 450)) {
      combined.throwIfAborted();
      const response = await fetchImpl(endpoint, {
        method: 'POST', headers, signal: combined, redirect: 'error',
        body: JSON.stringify({ model: tts.model, input: text, voice,
          response_format: 'wav', speed: tts.speed ?? 1 }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        // Never forward provider text, URLs or exception messages to API clients.
        throw new SpeechError(`TTS_HTTP_${Number(response.status) || 500}`);
      }
      const part = parsePcmWav(await boundedBody(response, MAX_SEGMENT_BYTES, combined), MAX_SEGMENT_BYTES);
      total += part.pcm.length;
      if (total + 44 > MAX_AUDIO_BYTES) throw new SpeechError('TTS_AUDIO_TOO_LARGE');
      parts.push(part);
    }
    combined.throwIfAborted();
    return { ...assemblePcmWav(parts), segmentCount: parts.length, buffered: true,
      lipSync: { kind: 'amplitude' } };
  } catch (error) {
    if (signal?.aborted) throw new SpeechError('TTS_CANCELLED');
    if (timeout.aborted) throw new SpeechError('TTS_TIMEOUT');
    if (error instanceof SpeechError) throw error;
    throw new SpeechError('TTS_UNAVAILABLE');
  }
}
