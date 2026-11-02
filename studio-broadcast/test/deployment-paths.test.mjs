import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');
const canonical = '/home/funboy/air3live';

test('installed-unit templates use the canonical repository, never a development worktree', async () => {
  for (const file of ['ops/air3-live-air3agent-canary.conf', 'ops/air3-live-v2-preview.service', 'ops/air3-tts-air3agent-canary.service']) {
    const text = await read(file);
    assert.ok(!text.includes('air3live-v2-dev'), file);
    assert.ok(text.includes('WorkingDirectory=' + canonical), file);
    assert.ok(text.includes(canonical + '/'), file);
  }
});

test('production deployment pins its own working directory and dedicated TTS dependency', async () => {
  const text = await read('tools/prepare-airewardrop-production.mjs');
  assert.ok(text.includes('WorkingDirectory=${root}/studio-broadcast'));
  assert.ok(text.includes('Requires=air3-tts-air3agent-canary.service'));
  assert.ok(text.includes('After=air3-tts-air3agent-canary.service'));
});

test('co-located test and production code retain private, separated runtime boundaries', async () => {
  const preview = await read('ops/air3-live-v2-preview.service');
  const tts = await read('ops/air3-tts-air3agent-canary.service');
  assert.ok(preview.includes('StateDirectory=air3live-v2-preview'));
  assert.ok(preview.includes('InaccessiblePaths=/home/funboy/.ssh ' + canonical + '/.env'));
  assert.ok(tts.includes('StateDirectory=air3-tts-air3agent-canary'));
  assert.ok(tts.includes('EnvironmentFile=/home/funboy/.local/state/air3live-air3agent-canary/tts.env'));
  assert.ok(tts.includes('NoNewPrivileges=true'));
});
