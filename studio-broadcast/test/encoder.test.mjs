import test from 'node:test';
import assert from 'node:assert/strict';
import { encoderArgs, redact, softwareRenderer } from '../src/encoder.mjs';
import { loadConfig, loadBroadcastConfig } from '../src/config.mjs';

test('publication requires explicit output, while encoding uses audio and two-second GOP', () => {
  const config = { gateway: { width: 1920, height: 1080, fps: 30 }, bitrateKbps: 4500, mode: 'file' };
  const args = encoderArgs(config, 'libx264', '/tmp/result.mkv');
  assert.equal(args[args.indexOf('-g') + 1], '60');
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
  assert(args.includes('0:a:0')); assert(args.includes('-n')); assert(!args.includes('flv'));
});
test('stream URLs, keys and bearer values are redacted without exposing paths', () => {
  const result = redact('failed rtmps://host/app/privateKEY auth Bearer 123456TOKEN', ['privateKEY', '123456TOKEN']);
  assert(!result.includes('privateKEY')); assert(!result.includes('123456TOKEN')); assert(!result.includes('rtmps://'));
});
test('software renderer is never reported as hardware', () => {
  assert(softwareRenderer({ gpuRenderer: 'ANGLE (Google, Vulkan SwiftShader Device)' }));
  assert(softwareRenderer({ gpuRenderer: 'llvmpipe' }));
  assert(softwareRenderer({}));
  assert.equal(softwareRenderer({ gpuRenderer: 'ANGLE (NVIDIA RTX)' }), false);
});
test('configuration rejects shared credentials and remote avatar paths', () => {
  assert.throws(() => loadConfig({ AIR3_PRODUCER_TOKEN: 'a'.repeat(64), AIR3_PLAYER_TOKEN: 'a'.repeat(64) }), /different/);
  assert.throws(() => loadConfig({ AIR3_PRODUCER_TOKEN: 'a'.repeat(64), AIR3_PLAYER_TOKEN: 'b'.repeat(64), AIR3_AVATAR_URL: 'https://example.com/a.glb' }), /local/);
});
test('the Intel launcher encoder is accepted and receives QSV-compatible pixels and options', () => {
  const config = loadBroadcastConfig({ AIR3_PRODUCER_TOKEN: 'a'.repeat(64), AIR3_PLAYER_TOKEN: 'b'.repeat(64),
    AIR3_CHROME_PATH: process.execPath, AIR3_VIDEO_ENCODER: 'h264_qsv', AIR3_OUTPUT_MODE: 'file' });
  assert.equal(config.encoder, 'h264_qsv');
  const args = encoderArgs(config, config.encoder, '/tmp/qsv-test.mkv');
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'nv12');
  assert(args[args.indexOf('-vf') + 1].includes('format=nv12'));
  assert.equal(args[args.indexOf('-look_ahead') + 1], '0');
  assert(!args.includes('-tune'), 'x264 tune is not passed to QSV');
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
  assert(args.includes('-n'), 'Existing recording protection remains in place');
});
