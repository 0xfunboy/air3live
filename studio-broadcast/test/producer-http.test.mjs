import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../src/gateway.mjs';
import { assemblePcmWav } from '../src/speech.mjs';

const producer='fixture-producer-01234567890123456789', player='fixture-player-01234567890123456789';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t,enabled=true) {
  const dir=await mkdtemp(join(tmpdir(),'air3-producer-http-'));const publicDir=join(dir,'public');await mkdir(publicDir);
  await writeFile(join(publicDir,'index.html'),'<!doctype html><title>Fixture</title>');
  const wav=assemblePcmWav([{channels:1,sampleRate:24000,bitsPerSample:16,blockAlign:2,byteRate:48000,pcm:Buffer.alloc(4800)}]).bytes;
  const gateway=await createGateway({host:'127.0.0.1',port:0,publicDir,dataDir:join(dir,'data'),nodeModulesDir:join(dir,'node_modules'),producerToken:producer,playerToken:player,
    editorial:{enabled,producerId:'fixture',channelId:'123'},queue:{maxPending:20,maxTextChars:8000,maxAgeMs:300000,leaseMs:15000,retentionMs:3600000},
    tts:{baseUrl:'http://fixture.invalid',model:'fixture',voiceEn:'fixture',voiceIt:'fixture',speed:1,timeoutMs:1000,maxChunkChars:600},lipSync:{mode:'off'},
    fetchImpl:async()=>new Response(wav,{headers:{'Content-Type':'audio/wav'}})});
  await new Promise(r=>gateway.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${gateway.server.address().port}`;
  t.after(async()=>{await gateway.close();await rm(dir,{recursive:true,force:true});});
  const request=async(path,method='GET',body,token=producer)=>{const response=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});return{status:response.status,data:await response.json()};};
  return {request,base};
}
const path=(type,id)=>`/api/producer/v1/${type}/${id}`;
function turn(id) {const now=Date.now();return{revision:1,phase:'queued',source:{platform:'twitch',channelId:'123',messageId:id,userId:id,receivedAt:now},expiresAt:now+90000};}
function intent(id,kind='filler',reservation) {const now=Date.now();return{schema:'air3.editorial-intent.v1',id,kind,...(reservation?{turnId:reservation.source.messageId}:{}),
  source:reservation?.source??{platform:'market',channelId:'123'},language:'en',speechText:'This is a safe integration fixture, not a real trade.',createdAt:now,expiresAt:reservation?.expiresAt??now+120000,
  presentation:{intent:'address_audience'},editorial:{title:'Integration fixture',topic:'test',sourceRefs:[]}};}
async function ready(f,id) {for(let i=0;i<200;i++){const response=await f.request('/api/player/claim','POST',{playerId:'fixture',protocol:'air3.editorial.player.v1'},player);if(response.data.job)return response.data.job;await delay(10);}assert.fail(`No claim: ${id}`);}
test('editorial is opt-in and refuses player/unauthenticated producer access',async t=>{
  const disabled=await fixture(t,false);assert.equal((await disabled.request('/api/producer/v1/capabilities')).status,503);
  const f=await fixture(t);assert.equal((await f.request('/api/producer/v1/capabilities','GET',undefined,player)).status,401);
  const caps=await f.request('/api/producer/v1/capabilities');assert.equal(caps.status,200);assert.equal(caps.data.channelId,'123');
  assert.equal(caps.data.features.monitorSnapshots,false);assert.ok(!JSON.stringify(caps).includes(producer));
  assert.equal((await f.request('/api/player/claim','POST',{playerId:'old-player'},player)).status,409);
  assert.equal((await f.request('/api/player/claim','POST',{playerId:'new-player',protocol:'air3.editorial.player.v1'},player)).status,200);
});
test('turn reservation blocks a ready news segment before its next claim and DELETE releases it',async t=>{
  const f=await fixture(t);await f.request(path('utterances','low'),'PUT',intent('low','news'));await delay(100);
  await f.request(path('turns','question'),'PUT',turn('question'));
  assert.equal((await f.request('/api/player/claim','POST',{playerId:'fixture',protocol:'air3.editorial.player.v1'},player)).data.job,null);
  await f.request(path('turns','question'),'DELETE');assert.ok(await ready(f,'low'));
});
test('chat delivery carries identity through API, generation, player and terminal status',async t=>{
  const f=await fixture(t);const queued=turn('question');await f.request(path('turns','question'),'PUT',queued);
  const preparing={...queued,phase:'preparing',revision:2,prepareStartedAt:Date.now(),prepareDeadlineAt:Date.now()+20000,dispatchSequence:1};
  await f.request(path('turns','question'),'PUT',preparing);
  assert.equal((await f.request(path('utterances','answer'),'PUT',intent('answer','chat',queued))).status,202);
  const job=await ready(f,'answer');assert.equal(job.editorial.parentId,'answer');assert.equal(job.editorial.kind,'chat');assert.equal(job.emotionExplicit,false);
  const event=kind=>f.request(`/api/player/${job.id}/events`,'POST',{event:kind,playerId:'fixture',leaseToken:job.leaseToken},player);
  assert.equal((await event('started')).data.control.yield,false);await event('finished');
  assert.equal((await f.request(path('utterances','answer'))).data.status,'completed');
});
test('playing filler yields to reservation, and cannot falsely finish after interruption',async t=>{
  const f=await fixture(t);await f.request(path('utterances','low'),'PUT',intent('low'));const job=await ready(f,'low');
  const event=kind=>f.request(`/api/player/${job.id}/events`,'POST',{event:kind,playerId:'fixture',leaseToken:job.leaseToken},player);
  await event('started');await f.request(path('turns','q'),'PUT',turn('q'));
  const response=await event('heartbeat');assert.equal(response.data.control.yield,true);assert.equal(response.data.controlPollMs,500);
  assert.equal((await f.request('/api/player/claim','POST',{playerId:'other',protocol:'air3.editorial.player.v1'},player)).data.job,null);
  await event('interrupted');assert.equal((await f.request(path('utterances','low'))).data.status,'superseded');
  assert.equal((await event('finished')).status,409);
});
test('late utterance cannot bypass a turn tombstone and cross-channel writes are denied',async t=>{
  const f=await fixture(t);const queued=turn('q');await f.request(path('turns','q'),'DELETE');
  assert.equal((await f.request(path('turns','q'),'PUT',queued)).status,410);
  assert.equal((await f.request(path('utterances','answer'),'PUT',intent('answer','chat',queued))).status,410);
  const low=intent('foreign');low.source.channelId='456';assert.equal((await f.request(path('utterances','foreign'),'PUT',low)).status,403);
});
test('PNG attachment binds to the reserved chat, serves only bounded immutable content and never returns bytes in status',async t=>{
 const {createHash}=await import('node:crypto');const f=await fixture(t),queued=turn('chart-question');await f.request(path('turns','chart-question'),'PUT',queued);
 await f.request(path('turns','chart-question'),'PUT',{...queued,revision:2,phase:'preparing',prepareStartedAt:Date.now(),prepareDeadlineAt:Date.now()+20000,dispatchSequence:1});
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+y4hoAAAAASUVORK5CYII=';
 const data=intent('chart-answer','chat',queued);data.chart={mimeType:'image/png',dataBase64:png,sha256:createHash('sha256').update(Buffer.from(png,'base64')).digest('hex')};
 data.expiresAt=data.createdAt+180000;
 assert.equal((await f.request(path('utterances','too-long-chart'),'PUT',{...data,id:'too-long-chart',expiresAt:data.createdAt+180001})).status,410);
 assert.equal((await f.request(path('utterances','bad-chart'),'PUT',{...data,id:'bad-chart',chart:{...data.chart,sha256:'0'.repeat(64)}})).status,400);
 assert.equal((await f.request(path('utterances','no-reservation'),'PUT',{...data,id:'no-reservation',turnId:'nonexistent'})).status,409);
 assert.equal((await f.request(path('utterances','chart-answer'),'PUT',data)).status,202);
 const job=await ready(f,'chart-answer');assert.equal(job.editorial.chart.sha256,data.chart.sha256);assert.equal(job.editorial.chart.dataBase64,undefined);
 const image=await fetch(f.base+job.editorial.chart.path);assert.equal(image.status,200);assert.equal(image.headers.get('Content-Type'),'image/png');assert.equal(Buffer.from(await image.arrayBuffer()).toString('base64'),png);
 assert.equal((await f.request(path('utterances','chart-answer'),'PUT',data)).data.duplicate,true);
 await f.request(path('utterances','chart-answer'),'DELETE');assert.equal((await fetch(f.base+job.editorial.chart.path)).status,404);
});
