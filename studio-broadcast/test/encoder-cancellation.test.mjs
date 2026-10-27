import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { selectEncoder, redactValue } from '../src/encoder.mjs';

// Spawn fixtures exercise cancellation and redaction, not hardware availability.
test('encoder cancellation kills the pending probe and never tries a later codec', async () => {
  const aborter = new AbortController(), calls = [], kills = [];
  const spawnImpl = (_file, args) => {
    calls.push(args[args.indexOf('-c:v') + 1]);
    const child = new EventEmitter();
    child.kill = signal => { kills.push(signal); child.emit('exit', 0); return true; };
    return child;
  };
  const reason = new Error('fixture-cancelled');
  const probe = selectEncoder({ encoder: 'auto', ffmpeg: 'fixture-ffmpeg' }, { signal: aborter.signal, spawnImpl });
  const observed = probe.then(value => ({ value }), error => ({ error }));
  assert.deepEqual(calls, ['h264_nvenc']);
  aborter.abort(reason);
  assert.equal((await observed).error, reason, 'Even a synchronous exit emitted by kill cannot turn abort into success');
  assert.deepEqual(kills, ['SIGKILL']);
  assert.deepEqual(calls, ['h264_nvenc']);
});

test('a previously cancelled encoder selection never spawns a process', async () => {
  const aborter = new AbortController(); aborter.abort();
  let spawns = 0;
  await assert.rejects(selectEncoder({ encoder: 'libx264', ffmpeg: 'fixture-ffmpeg' }, {
    signal: aborter.signal, spawnImpl() { spawns++; throw new Error('unexpected spawn'); },
  }), error => error.name === 'AbortError');
  assert.equal(spawns, 0);
});

test('redaction preserves typed telemetry and handles quotes, slashes, newlines and nested serialized strings', () => {
  const secret = 'api-"quoted"-\\line\nnext';
  const original = { fps: 29.97, frame: 123, running: true, renderer: null,
    nested: [{ key: secret }, { message: JSON.stringify({ error: secret }) }],
    query: 'https://tts.example.test/path?token=' + encodeURIComponent(secret),
    destination: 'Cannot open rtmps://live.example.test/app/hidden-stream-key',
    [secret]: 'secret-bearing property name',
  };
  const sanitized = redactValue(original, [secret]);
  assert.equal(sanitized.fps, 29.97); assert.equal(sanitized.frame, 123);
  assert.equal(sanitized.running, true); assert.equal(sanitized.renderer, null);
  assert.equal(sanitized.nested[0].key, '[redacted]');
  assert.equal(JSON.parse(sanitized.nested[1].message).error, '[redacted]');
  assert.equal(sanitized['[redacted]'], 'secret-bearing property name');
  assert.equal(sanitized.query, 'https://tts.example.test/path?token=[redacted]');
  assert.equal(sanitized.destination, 'Cannot open [stream destination]');
  const serialized = JSON.stringify(sanitized);
  for (const spelling of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), 'hidden-stream-key']) {
    assert.equal(serialized.includes(spelling), false);
  }
  assert.equal(original.nested[0].key, secret, 'Sanitizing a log must not mutate settings or runtime inputs');
  const cycle = {}; cycle.self = cycle;
  assert.deepEqual(redactValue(cycle), { self: '[circular]' });
});
