import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultLiveSettings } from '../src/live-settings.mjs';
import { LiveProcess, buildLiveEnvironment } from '../src/live-process.mjs';

// Explicit process-control fixture: no network, Chrome, encoder or live stream.
class Child extends EventEmitter {
  constructor() { super(); this.stdout=new PassThrough(); this.stderr=new PassThrough(); this.connected=true; this.pid=123456; this.sent=[]; }
  send(message,done) { this.sent.push(message); done?.(); if(message.type==='stop') queueMicrotask(()=>{this.connected=false;this.emit('exit',0,null);}); }
  kill(signal) {this.connected=false;this.emit('exit',0,signal);return true;}
}
async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(),'air3-live-process-test-'));
  const settings = defaultLiveSettings(); settings.stream.server='rtmps://live.restream.io/live'; settings.stream.key='stream-secret-fixture';
  settings.tts.apiKey='api-"quoted"-\\fixture'; settings.market.coinglassKey='cg-fixture-secret';
  const config = {port:5890,dataDir,producerToken:'producer-fixture-token',playerToken:'player-fixture-token',live:{operatorToken:'operator-fixture-token'}};
  let forks = 0; const children=[];
  const process = new LiveProcess({config,getSettings:()=>settings,baseEnv:{},forkImpl:()=>{forks++;const child=new Child();children.push(child);return child;},...overrides});
  process.preflight=async()=>({ok:true,encoder:'fixture-encoder'});
  t.after(async()=>{await process.close();await rm(dataDir,{recursive:true,force:true});});
  return {process,settings,config,children,forks:()=>forks};
}

test('stream environment uses the owned renderer and separate file/test/live modes', async t => {
  const {settings,config} = await fixture(t);
  const base={AIR3_RTMP_URL:'rtmp://stale.invalid/secret',AIR3_WIDTH:'500',AIR3_CONTROL_STDIN:'true'};
  const record=buildLiveEnvironment(settings,config,base,{mode:'record',origin:'http://127.0.0.1:5890'});
  assert.equal(record.AIR3_RTMP_URL,'');assert.equal(record.AIR3_OUTPUT_MODE,'file');assert.equal(record.AIR3_WIDTH,'1920');
  assert.equal(record.AIR3_CONTROL_STDIN,'false'); assert.equal(record.AIR3_REQUIRE_HARDWARE_RENDERING,'false');
  const live=buildLiveEnvironment(settings,config,base,{mode:'live',origin:'http://127.0.0.1:5890'});
  assert.equal(live.AIR3_OUTPUT_MODE,'rtmp');assert.equal(live.AIR3_REQUIRE_HARDWARE_RENDERING,'true');
  assert.equal(new URL(live.AIR3_STUDIO_URL).pathname,'/studio');assert.equal(live.AIR3_LIVE_IPC,'true');
  assert.throws(()=>buildLiveEnvironment(settings,config,base,{mode:'twitch-test',origin:'http://127.0.0.1:5890'}),error=>error.code==='TWITCH_TEST_ONLY');
});

test('process status and logs redact encoder destinations and literal escaped credentials', async t => {
  const {process,settings,config}=await fixture(t);
  const message='Cannot open rtmps://live.restream.io/live/'+settings.stream.key+' with '+settings.tts.apiKey+' / '+config.playerToken;
  assert.doesNotThrow(()=>process.handleEvent({event:'broadcast-error',message,attempt:1}));
  assert.doesNotThrow(()=>process.event('fixture-error',{nested:{secret:settings.tts.apiKey},message}));
  await process.logChain;
  const snapshot=JSON.stringify(process.snapshot()),log=await readFile(join(config.dataDir,'live-session.log'),'utf8');
  for(const value of [snapshot,log]) {
    for(const secret of [settings.stream.key,settings.tts.apiKey,JSON.stringify(settings.tts.apiKey).slice(1,-1),config.playerToken]) assert.equal(value.includes(secret),false,'Private credentials must not survive serialization');
    assert.equal(value.includes('rtmps://live.restream.io'),false);
  }
  assert.equal(process.snapshot().phase,'reconnecting');
});

test('stopping while the encoder preflight is pending prevents a late broadcast fork', async t => {
  const f=await fixture(t);let resolveProbe;
  f.process.preflight=()=>new Promise(done=>{resolveProbe=done;});
  const start=f.process.start('live','http://127.0.0.1:5890');
  const observed=start.then(value=>({value}),error=>({error}));
  assert.equal(f.process.busy,true);
  const stop=f.process.stop(); resolveProbe({ok:true,encoder:'fixture-encoder'});
  await stop; const result=await observed;
  assert.equal(f.forks(),0,'No process starts after the operator requested stop');
  assert.equal(f.process.child,null);assert.equal(f.process.busy,false);
  if(result.error)assert.equal(result.error.code,'LIVE_START_CANCELLED');
});

test('only advancing encoder output reports running; stop settles commands and releases the owned child', async t => {
  const f=await fixture(t);await f.process.start('record','http://127.0.0.1:5890');
  assert.equal(f.process.snapshot().phase,'starting');
  f.process.handleEvent({event:'encoder-progress',frame:0,seconds:0,fps:0});assert.equal(f.process.snapshot().phase,'starting');
  f.process.handleEvent({event:'encoder-progress',frame:30,seconds:1,fps:30,bitrate:'4000kbits/s'});
  assert.equal(f.process.snapshot().phase,'running');
  await assert.rejects(f.process.start('record','http://127.0.0.1:5890'),error=>error.code==='BROADCAST_ALREADY_ACTIVE');
  const command=f.process.command({type:'home'});const observed=command.then(value=>({value}),error=>({error}));
  await f.process.stop();const outcome=await observed;
  assert.equal(outcome.error?.code,'BROADCAST_STOPPED');assert.equal(f.process.pending.size,0);
  assert.equal(f.process.child,null);assert.equal(f.process.snapshot().phase,'stopped');
  assert.equal(f.children[0].sent.at(-1).type,'stop');
  await f.process.start('record','http://127.0.0.1:5890');assert.equal(f.forks(),2);
});

test('preview captures are requested only on demand and are throttled across polling clients', async t => {
  let clock = 0;
  const f = await fixture(t, { now: () => clock });
  assert.equal(f.process.requestPreview(), false);
  await f.process.start('record', 'http://127.0.0.1:5890');
  const child = f.children[0];
  assert.deepEqual(child.sent, [], 'Starting a stream must not schedule repeated JPEG capture');
  assert.equal(f.process.requestPreview(), true);
  assert.equal(f.process.requestPreview(), true);
  clock = 2999; f.process.requestPreview();
  assert.deepEqual(child.sent, [{ type: 'preview-request' }]);
  clock = 3000; f.process.requestPreview();
  assert.equal(child.sent.length, 2);
  child.emit('message', { type: 'preview', jpeg: Buffer.from('not-an-image').toString('base64') });
  assert.equal(f.process.preview, null);
  const jpegHeaderFixture = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]);
  child.emit('message', { type: 'preview', jpeg: jpegHeaderFixture.toString('base64') });
  assert.deepEqual(f.process.preview, jpegHeaderFixture);
  assert.equal(f.process.snapshot().previewAt, 3000);
  await f.process.stop();
  assert.equal(f.process.requestPreview(), false);
});

test('close cancels a never-settled preflight promptly and prevents a late fork and restart', async t => {
  const f = await fixture(t);
  let probeSignal, releaseProbe;
  f.process.preflight = (_mode, _origin, { signal }) => {
    probeSignal = signal;
    return new Promise(done => { releaseProbe = done; });
  };
  const start = f.process.start('live', 'http://127.0.0.1:5890');
  const observed = start.then(value => ({ value }), error => ({ error }));
  let timer;
  try {
    await Promise.race([
      f.process.close(),
      new Promise((_done, reject) => { timer = setTimeout(() => reject(new Error('close did not cancel preflight')), 1000); }),
    ]);
  } finally { clearTimeout(timer); }
  assert.equal(probeSignal.aborted, true);
  assert.equal((await observed).error?.code, 'LIVE_START_CANCELLED');
  releaseProbe({ ok: true, encoder: 'late-fixture-encoder' });
  await new Promise(done => setImmediate(done));
  assert.equal(f.forks(), 0);
  assert.equal(f.process.child, null);
  assert.equal(f.process.snapshot().phase, 'stopped');
  await assert.rejects(f.process.start('record', 'http://127.0.0.1:5890'), error => error.code === 'BROADCAST_CLOSED');
});

test('an unconfirmed child exit produces a bounded stop failure while retaining ownership', async t => {
  const kills = [];
  const f = await fixture(t, { stopTimeoutMs: 15, killTimeoutMs: 15,
    killTreeImpl: async (child, force) => { kills.push({ child, force }); } });
  await f.process.start('record', 'http://127.0.0.1:5890');
  const child = f.children[0];
  child.send = (message, done) => { child.sent.push(message); done?.(); };
  const began = performance.now();
  try {
    await assert.rejects(f.process.stop(), error => error.code === 'BROADCAST_STOP_TIMEOUT' && error.statusCode === 504);
    assert.ok(performance.now() - began < 1000, 'Stop has a finite deadline even if a child never exits');
    assert.equal(kills.length, 1); assert.equal(kills[0].child, child); assert.equal(kills[0].force, true);
    assert.equal(f.process.child, child, 'Retain ownership until the operating system confirms exit');
    assert.equal(f.process.snapshot().phase, 'failed');
    assert.equal(f.process.snapshot().error, 'BROADCAST_STOP_TIMEOUT');
    f.process.handleEvent({ event: 'encoder-progress', frame: 90, seconds: 3, fps: 30 });
    assert.equal(f.process.snapshot().phase, 'failed', 'Late progress must not undo an explicit stop');
    await assert.rejects(f.process.start('record', 'http://127.0.0.1:5890'), error => error.code === 'BROADCAST_ALREADY_ACTIVE');
  } finally { child.connected = false; child.emit('exit', null, 'SIGKILL'); }
  assert.equal(f.process.child, null);
  assert.equal(f.process.snapshot().phase, 'stopped');
});

test('stderr redacts credentials across chunk boundaries before shortening the diagnostic line', async t => {
  const f = await fixture(t);
  const prefix = 'private-api-credential-' + 'sensitive-segment-'.repeat(12);
  const secret = prefix + 'x'.repeat(2800) + '-credential-end';
  f.settings.tts.apiKey = secret;
  await f.process.start('record', 'http://127.0.0.1:5890');
  const child = f.children[0];
  child.stderr.write('TTS failure: ' + secret.slice(0, 1700));
  child.stderr.write(secret.slice(1700) + ' during fixture request\n');
  await f.process.logChain;
  const log = await readFile(join(f.config.dataDir, 'live-session.log'), 'utf8');
  const snapshot = JSON.stringify(f.process.snapshot());
  for (const text of [log, snapshot]) {
    assert.equal(text.includes(prefix.slice(0, 128)), false, 'The prefix of a long private key must not survive truncation');
    assert.equal(text.includes(secret), false);
    assert.ok(text.includes('[redacted]'));
  }
});
