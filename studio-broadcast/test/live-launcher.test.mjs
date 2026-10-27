import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { prepareLiveEnv, liveControlUrl } from '../../scripts/start-live.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(),'air3-live-launcher-test-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'.env.example'),'AIR3_PRODUCER_TOKEN=GENERATE_PRODUCER_TOKEN\nAIR3_PLAYER_TOKEN=GENERATE_PLAYER_TOKEN\nAIR3_OPERATOR_TOKEN=GENERATE_OPERATOR_TOKEN\nAIR3_LIVE_ENABLED=true\nAIR3_OUTPUT_MODE=file\n');
  return dir;
}

test('first live initialization creates three private distinct credentials and never configures automatic streaming', async t => {
  const dir = await fixture(t), prepared = await prepareLiveEnv(dir), text = await readFile(prepared.file,'utf8'), env = parseEnv(text);
  assert.equal(prepared.created,true); assert.equal(env.AIR3_OUTPUT_MODE,'file'); assert.equal(env.AIR3_LIVE_ENABLED,'true');
  const keys = [env.AIR3_PRODUCER_TOKEN,env.AIR3_PLAYER_TOKEN,env.AIR3_OPERATOR_TOKEN];
  assert.equal(new Set(keys).size,3); assert(keys.every(key=>/^[a-f0-9]{64}$/.test(key)));
  assert(keys.every(key=>!JSON.stringify(prepared).includes(key)));
  if(process.platform !== 'win32') assert.equal((await stat(prepared.file)).mode & 0o777,0o600);
});

test('migration preserves exact existing comments, keys, TTS and deployment settings, and is idempotent', async t => {
  const dir = await fixture(t), old='# User configuration\r\nAIR3_PRODUCER_TOKEN="existing-producer"\r\nAIR3_PLAYER_TOKEN=existing-player\r\nAIR3_TTS_BASE_URL=https://tts.example/v1\r\nAIR3_TTS_API_KEY="user-private-tts-key"\r\nAIR3_HOST=0.0.0.0\r\nAIR3_LIVE_ENABLED=false\r\n';
  await writeFile(join(dir,'.env'),old); const first=await prepareLiveEnv(dir);
  const migrated=await readFile(first.file,'utf8'), env=parseEnv(migrated);
  assert(migrated.startsWith(old)); assert.deepEqual(first.changedKeys,['AIR3_OPERATOR_TOKEN','AIR3_LIVE_ENABLED']);
  assert.equal(env.AIR3_TTS_API_KEY,'user-private-tts-key'); assert.equal(env.AIR3_PRODUCER_TOKEN,'existing-producer');
  assert.equal(env.AIR3_PLAYER_TOKEN,'existing-player'); assert.equal(env.AIR3_HOST,'0.0.0.0'); assert.equal(env.AIR3_LIVE_ENABLED,'true');
  const second=await prepareLiveEnv(dir); assert.deepEqual(second.changedKeys,[]); assert.equal(await readFile(first.file,'utf8'),migrated);
});

test('concurrent initialization shares one operator token instead of rotating credentials on double launch', async t => {
  const dir=await fixture(t); await writeFile(join(dir,'.env'),'AIR3_PRODUCER_TOKEN=keep-producer\nAIR3_PLAYER_TOKEN=keep-player\n');
  await Promise.all(Array.from({length:4},()=>prepareLiveEnv(dir)));
  const text=await readFile(join(dir,'.env'),'utf8'); assert.equal((text.match(/^AIR3_OPERATOR_TOKEN=/gm)||[]).length,1);
  const previous=parseEnv(text).AIR3_OPERATOR_TOKEN;await prepareLiveEnv(dir);assert.equal(parseEnv(await readFile(join(dir,'.env'),'utf8')).AIR3_OPERATOR_TOKEN,previous);
  assert.deepEqual((await readdir(dir)).sort(),['.env','.env.example']);
});

test('local control URLs use Twitch-documented localhost while custom hosts and HTTPS origins stay intact', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::', '', undefined]) {
    assert.equal(liveControlUrl(host,5890),'http://localhost:5890/control');
  }
  assert.equal(liveControlUrl('192.0.2.5',5890),'http://192.0.2.5:5890/control');
  assert.equal(liveControlUrl('127.0.0.1',5890,'https://studio.example'),'https://studio.example/control');
});
