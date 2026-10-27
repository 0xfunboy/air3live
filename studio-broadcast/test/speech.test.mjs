import test from 'node:test';
import assert from 'node:assert/strict';
import { assemblePcmWav, parsePcmWav, splitSpeechText, synthesizeSpeech } from '../src/speech.mjs';

function wav(sampleRate = 24000, samples = 2400) {
  return assemblePcmWav([{ channels: 1, sampleRate, bitsPerSample: 16,
    blockAlign: 2, byteRate: sampleRate * 2, pcm: Buffer.alloc(samples * 2, 1) }]).bytes;
}
const settings = { baseUrl: 'http://fixture.invalid/v1', apiKey: 'test-secret', model: 'kokoro',
  voiceEn: 'af_jessica', voiceIt: 'if_sara', speed: 1, timeoutMs: 2000, maxChunkChars: 45 };

test('speech segments at boundaries, preserves text and never cuts a surrogate pair', () => {
  const text = 'First complete sentence. Another sentence with several ordinary words. ' + '😀'.repeat(40);
  const chunks = splitSpeechText(text, 40);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 40 && !/[\uD800-\uDBFF]$/.test(chunk)));
  assert.equal(chunks.join(' ').replace(/\s/g, ''), text.replace(/\s/g, ''));
  assert.equal(chunks[0], 'First complete sentence.');
});

test('WAV validation rejects truncation, float encoding and inconsistent sample alignment', () => {
  assert.throws(() => parsePcmWav(wav().subarray(0, 100)), /TRUNCATED/);
  const float = Buffer.from(wav()); float.writeUInt16LE(3, 20);
  assert.throws(() => parsePcmWav(float), /UNSUPPORTED_WAV_FORMAT/);
  const odd = Buffer.from(wav()); odd.writeUInt16LE(3, 32);
  assert.throws(() => parsePcmWav(odd), /UNSUPPORTED_WAV_FORMAT/);
  assert.throws(() => parsePcmWav(Buffer.from('not audio')), /INVALID_WAV/);
});

test('fully buffered HTTP WAV with streaming size sentinels is normalized safely', () => {
  const source = Buffer.from(wav());
  source.writeUInt32LE(0xffffffff, 4); source.writeUInt32LE(0xffffffff, 40);
  const parsed = parsePcmWav(source);
  assert.equal(parsed.durationMs, 100);
  const normalized = assemblePcmWav([parsed]);
  assert.equal(normalized.bytes.readUInt32LE(4) + 8, normalized.bytes.length);
});

test('TTS requests sequential bounded WAV segments and concatenates compatible PCM only', async () => {
  const seen = [];
  let active = 0;
  let maximum = 0;
  const result = await synthesizeSpeech(settings, { language: 'it', text: 'Questa è la prima frase. Questa è la seconda frase. Questa è la terza frase.' }, {
    fetchImpl: async (url, options) => {
      active++; maximum = Math.max(maximum, active);
      const payload = JSON.parse(options.body);
      seen.push(payload);
      assert.equal(url, 'http://fixture.invalid/v1/audio/speech');
      assert.equal(options.headers.Authorization, 'Bearer test-secret');
      assert.equal(options.redirect, 'error');
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return new Response(wav(), { headers: { 'content-type': 'audio/wav' } });
    },
  });
  assert.equal(maximum, 1);
  assert.ok(seen.length >= 2);
  assert.ok(seen.every((part) => part.input.length <= 45 && part.voice === 'if_sara' && part.response_format === 'wav'));
  assert.equal(result.durationMs, seen.length * 100);
  assert.equal(parsePcmWav(result.bytes).pcm.length, seen.length * 4800);
  assert.equal(result.buffered, true);
  assert.deepEqual(result.lipSync, { kind: 'amplitude' });
});

test('TTS fails clearly on differing sample rates instead of concatenating corrupt audio', async () => {
  let call = 0;
  await assert.rejects(synthesizeSpeech(settings, {
    text: 'The first phrase is sufficiently long. The second phrase is sufficiently long.', language: 'en',
  }, { fetchImpl: async () => new Response(wav(++call === 1 ? 24000 : 48000)) }), /TTS_INCOMPATIBLE_SEGMENTS/);
});

test('provider errors are sanitized and body limits are enforced before buffering', async () => {
  await assert.rejects(synthesizeSpeech(settings, { text: 'Hello.', language: 'en' }, {
    fetchImpl: async () => { throw new Error('https://user:very-secret@host private stack'); },
  }), { message: 'TTS_UNAVAILABLE' });
  await assert.rejects(synthesizeSpeech(settings, { text: 'Hello.', language: 'en' }, {
    fetchImpl: async () => new Response('private provider body', { status: 403 }),
  }), { message: 'TTS_HTTP_403' });
  await assert.rejects(synthesizeSpeech(settings, { text: 'Hello.', language: 'en' }, {
    fetchImpl: async () => new Response(wav(), { headers: { 'content-length': String(100 * 1024 * 1024) } }),
  }), { message: 'TTS_AUDIO_TOO_LARGE' });
});

test('cancellation propagates to the provider and never becomes provider detail', async () => {
  const controller = new AbortController();
  const result = synthesizeSpeech(settings, { text: 'Hello.', language: 'en' }, {
    signal: controller.signal,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('private auth token')), { once: true });
      setTimeout(() => controller.abort(), 10);
    }),
  });
  await assert.rejects(result, { message: 'TTS_CANCELLED' });
});
