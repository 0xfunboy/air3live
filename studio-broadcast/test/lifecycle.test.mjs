import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { attachStdinControl } from '../src/lifecycle.mjs';

test('service stdin EOF does not terminate an unattended broadcaster', async () => {
  const input = new PassThrough(), controller = new AbortController();
  const detach = attachStdinControl(input, controller); input.end();
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(controller.signal.aborted, false); detach();
});
test('explicit supervisor can stop through split quit lines and EOF', async () => {
  for (const commands of [['qui', 't\n'], []]) {
    const input = new PassThrough(), controller = new AbortController();
    const detach = attachStdinControl(input, controller, { supervised: true });
    for (const command of commands) input.write(command); input.end();
    await new Promise((resolve) => setImmediate(resolve)); assert.equal(controller.signal.aborted, true); detach();
  }
});
