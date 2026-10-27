import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultLiveSettings, mergeLiveSettings, publicLiveSettings, streamDestination, createLiveSettingsStore } from '../src/live-settings.mjs';

const invalid = error => error.code === 'INVALID_LIVE_SETTINGS' && error.statusCode === 400;
async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'air3-live-settings-test-')); t.after(() => rm(path, {recursive:true,force:true})); return path; }

test('live destinations compose RTMPS/RTMP keys and Twitch bandwidth-test query without exposing secrets in the public form', () => {
  let settings = mergeLiveSettings(defaultLiveSettings(), {stream:{provider:'restream',server:'rtmps://live.restream.io:443/live',key:'private-key-123'}});
  assert.equal(streamDestination(settings.stream), 'rtmps://live.restream.io:443/live/private-key-123');
  assert.equal(publicLiveSettings(settings).stream.hasKey, true); assert.equal('key' in publicLiveSettings(settings).stream, false);
  settings = mergeLiveSettings(settings, {stream:{provider:'twitch',server:'rtmp://live.twitch.tv/app',key:'live_fixture?extra=one',twitchBandwidthTest:true}});
  const url = new URL(streamDestination(settings.stream));
  assert.equal(url.pathname, '/app/live_fixture'); assert.equal(url.searchParams.get('bandwidthtest'), 'true'); assert.equal(url.searchParams.get('extra'),'one');
  assert.equal(new URL(streamDestination(settings.stream,{test:false})).searchParams.has('bandwidthtest'),false);
  assert.throws(() => streamDestination(defaultLiveSettings().stream), error => error.code === 'STREAM_DESTINATION_REQUIRED');
});

test('live settings reject credential-bearing URLs, provider host spoofing, malformed scalar values and unknown fields', () => {
  const before = defaultLiveSettings();
  for (const patch of [
    {stream:{server:'https://live.restream.io/live'}}, {stream:{server:'file:///tmp/stream'}},
    {stream:{server:'rtmp://user:password@live.restream.io/live'}}, {stream:{server:'rtmp://restream.io.evil.example/live'}},
    {stream:{provider:'twitch',server:'rtmp://live-video.net.evil.example/app'}},
    {stream:{server:'rtmp://live.restream.io/live?key=secret'}}, {stream:{key:'bad\nkey'}},
    {stream:{profile:'toString'}}, {stream:{encoder:'constructor'}}, {stream:{bitrateKbps:NaN}},
    {stream:{bitrateKbps:4500.5}}, {scene:{roaming:'false'}}, {scene:{intensity:1.01}},
    {market:{provider:'toString'}}, {market:{symbol:'../../file'}},
    {tts:{baseUrl:'https://name:password@tts.example/v1'}}, {tts:{baseUrl:'https://tts.example/v1#key'}},
    {tts:{speed:Infinity}}, {twitch:{channel:'name/other'}}, {twitch:{clientId:'<script>'}},
    {unknown:true}, {stream:{command:'spawn'}}, {scene:[]}, {stream:null}, [], null,
  ]) assert.throws(() => mergeLiveSettings(before,patch), invalid, JSON.stringify(patch));
  assert.deepEqual(before,defaultLiveSettings(), 'Rejected updates do not mutate the active settings');
});

test('JSON prototype keys and non-plain inherited settings cannot cross the configuration boundary', () => {
  const original = defaultLiveSettings();
  for (const payload of ['{"__proto__":{"polluted":true}}','{"constructor":{"prototype":{"polluted":true}}}',
    '{"stream":{"__proto__":{"server":"rtmp://evil.example/live"}}}', '{"twitch":{"constructor":{}}}']) {
    assert.throws(() => mergeLiveSettings(original,JSON.parse(payload)), invalid);
  }
  assert.throws(() => mergeLiveSettings(original,Object.create({stream:{provider:'custom',server:'rtmp://evil.example/live'}})),invalid);
  assert.throws(() => mergeLiveSettings(original,{scene:Object.create({roaming:true})}),invalid);
  assert.equal({}.polluted,undefined); assert.equal(original.stream.server,'');
});

test('OAuth tokens stay server-owned and are invalidated when the configured application identity changes', () => {
  const app = mergeLiveSettings(defaultLiveSettings(),{twitch:{clientId:'testclient',clientSecret:'private-app-secret',channel:'#FunBoy'}});
  assert.equal(app.twitch.channel,'funboy');
  const connected = mergeLiveSettings(app,{twitch:{accessToken:'access-fixture',refreshToken:'refresh-fixture',userId:'123',login:'funboy',scopes:['user:read:chat'],expiresAt:2000000000000}},{internal:true});
  assert.equal(connected.twitch.accessToken,'access-fixture');
  for (const field of ['accessToken','refreshToken','userId','login','scopes','expiresAt']) {
    assert.throws(() => mergeLiveSettings(connected,{twitch:{[field]:connected.twitch[field]}}), invalid);
  }
  for (const change of [{clientId:'anotherapp'},{clientSecret:'changed-app-secret'}]) {
    const updated = mergeLiveSettings(connected,{twitch:change});
    assert.equal(updated.twitch.accessToken,''); assert.equal(updated.twitch.refreshToken,''); assert.deepEqual(updated.twitch.scopes,[]);
  }
});

test('all private keys are absent from settings returned to the operator and copies cannot mutate active state', () => {
  const settings = defaultLiveSettings();
  settings.stream.key = 'stream-fixture-secret'; settings.tts.apiKey = 'tts-fixture-secret'; settings.market.coinglassKey = 'coinglass-fixture-secret';
  Object.assign(settings.twitch,{clientSecret:'twitch-client-secret',accessToken:'twitch-access-secret',refreshToken:'twitch-refresh-secret',scopes:['user:read:chat'],userId:'123'});
  const shown = publicLiveSettings(settings), encoded = JSON.stringify(shown);
  for (const secret of [settings.stream.key,settings.tts.apiKey,settings.market.coinglassKey,settings.twitch.clientSecret,settings.twitch.accessToken,settings.twitch.refreshToken]) assert.equal(encoded.includes(secret),false);
  assert(shown.stream.hasKey && shown.tts.hasApiKey && shown.market.hasCoinglassKey && shown.twitch.hasClientSecret && shown.twitch.authorized);
  shown.scene.camera = 'wide'; assert.equal(settings.scene.camera,'auto');
});

test('serialized settings updates preserve independent changes, persist private file permissions and recover after rejected writes', async t => {
  const path = await directory(t), store = await createLiveSettingsStore(path);
  await Promise.all([store.update({scene:{camera:'wide'}}),store.update({tts:{speed:1.2}}),store.update({market:{symbol:'ETHUSDT'}})]);
  await assert.rejects(store.update({stream:{bitrateKbps:-1}}),invalid);
  await store.update({scene:{eyeContact:false}});
  const value = store.get(); assert.equal(value.scene.camera,'wide'); assert.equal(value.tts.speed,1.2); assert.equal(value.market.symbol,'ETHUSDT'); assert.equal(value.scene.eyeContact,false);
  const filename = join(path,'live-settings.json'), disk = JSON.parse(await readFile(filename,'utf8'));
  assert.deepEqual(value,disk); assert.equal((await readdir(path)).filter(name=>name.includes('.tmp-')).length,0);
  if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o777,0o600);
  value.stream.key = 'outside-change'; assert.notEqual(store.get().stream.key,'outside-change');
  assert.deepEqual((await createLiveSettingsStore(path)).get(),store.get());
});

test('saved settings preserve OAuth on restart but unknown fields cannot enlarge the accepted schema', async t => {
  const path = await directory(t), store = await createLiveSettingsStore(path);
  await store.update({twitch:{clientId:'testclient',clientSecret:'client-secret'}});
  await store.update({twitch:{accessToken:'persist-access',refreshToken:'persist-refresh',userId:'123',scopes:['user:read:chat'],expiresAt:2000000000000}},{internal:true});
  const restored = await createLiveSettingsStore(path); assert.equal(restored.get().twitch.accessToken,'persist-access');
  const saved = restored.get(); saved.twitch.unrecognizedSecret = 'should-never-load';
  await writeFile(join(path,'live-settings.json'),JSON.stringify(saved));
  await assert.rejects(createLiveSettingsStore(path),/LIVE_SETTINGS_UNREADABLE/);
});
