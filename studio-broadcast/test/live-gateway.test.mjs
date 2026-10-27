import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createGateway } from '../src/gateway.mjs';
import { QueueError } from '../src/queue.mjs';
import { assemblePcmWav } from '../src/speech.mjs';
import { normalizeWallpanel } from '../src/live-market.mjs';
import { buildLiveEnvironment } from '../src/live-process.mjs';

const PRODUCER = 'test-producer-private-01234567890123456789';
const PLAYER = 'test-player-private-01234567890123456789';
const OPERATOR = 'test-operator-private-01234567890123456789';
const SECRETS = ['test-stream-private-key', 'test-tts-private-key', 'test-coinglass-private-key',
  'test-twitch-private-client-secret', 'test-twitch-access', 'test-twitch-refresh', PRODUCER, PLAYER, OPERATOR];
const wav = () => assemblePcmWav([{channels:1,sampleRate:24000,bitsPerSample:16,blockAlign:2,byteRate:48000,pcm:Buffer.alloc(4800,1)}]).bytes;
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function eventually(fn,predicate) {
  const deadline=Date.now()+3000;let last;
  while(Date.now()<deadline){last=await fn();if(predicate(last))return last;await delay(10);}
  assert.fail('Expected gateway state was not reached: '+JSON.stringify(last));
}

/** Only local HTTP, SQLite and settings files are real in this integration
 * fixture. Process, market and Twitch factories are explicit offline doubles;
 * the speech fetch returns a locally assembled WAV. No external service runs. */
async function fixture(t, {live = {}, speechHook} = {}) {
  const root=await mkdtemp(path.join(tmpdir(),'air3-live-gateway-'));
  const publicDir=path.join(root,'public'), nodeModulesDir=path.join(root,'node_modules');
  await mkdir(path.join(publicDir,'control'),{recursive:true});await mkdir(nodeModulesDir,{recursive:true});
  await writeFile(path.join(publicDir,'index.html'),'<!doctype html><title>Fixture renderer</title>');
  await writeFile(path.join(publicDir,'control/index.html'),'<!doctype html><title>Fixture operator</title>');
  const history={processes:[],markets:[],chats:[],speech:[]};
  const config={host:'127.0.0.1',port:0,dataDir:path.join(root,'data'),publicDir,nodeModulesDir,
    producerToken:PRODUCER,playerToken:PLAYER,dappBaseUrl:null,avatarUrl:null,width:1920,height:1080,fps:30,
    lipSync:{mode:'off'},
    tts:{baseUrl:'http://tts.fixture/v1',apiKey:SECRETS[1],model:'old-model',voiceIt:'old-it',voiceEn:'old-en',speed:1,timeoutMs:2000,maxChunkChars:100},
    queue:{maxPending:10,maxTextChars:2000,maxAgeMs:60_000,leaseMs:2000,retentionMs:3_600_000},
    live:{enabled:true,operatorToken:OPERATOR,localOperator:true,publicOrigin:null,...live},
    fetchImpl:async(url,options)=>{history.speech.push({url,options,body:JSON.parse(options.body)});const custom=await speechHook?.(url,options);return custom||new Response(wav(),{headers:{'content-type':'audio/wav'}});},
    liveDependencies:{
      processFactory:({config,getSettings})=>{
        const calls=[],state={phase:'stopped',mode:null};
        const process={calls,state,child:null,busy:false,preview:null,
          snapshot:()=>({...state}),
          async preflight(mode,origin){buildLiveEnvironment(getSettings(),config,{}, {mode,origin});calls.push({type:'preflight',mode,origin});return{ok:true,mode};},
          async start(mode,origin){const env=buildLiveEnvironment(getSettings(),config,{}, {mode,origin});calls.push({type:'start',mode,origin,env});process.child={connected:true};state.phase='starting';state.mode=mode;return process.snapshot();},
          async stop(){calls.push({type:'stop'});process.child=null;state.phase='stopped';return process.snapshot();},
          async command(command){if(!process.child)throw new QueueError('BROADCAST_NOT_ACTIVE',409);calls.push({type:'command',command});return{ok:true};},
          async close(){calls.push({type:'close'});process.child=null;state.phase='stopped';},
        };history.processes.push(process);return process;
      },
      marketFactory:({config})=>{
        let settings={...config},wallpanel=null;const calls=[];
        const publicConfig=()=>{const {coinglassKey,...rest}=settings;return{...rest,coinglassConfigured:!!coinglassKey};};
        const market={calls,async start(){calls.push('start');},async stop(){calls.push('stop');},
          async configure(next){settings={...next};calls.push('configure');return publicConfig();},
          publicConfig,snapshot:()=>({schema:'fixture.market',config:publicConfig(),wallpanel,heatmap:{kind:'fixture-empty',cells:[]}}),
          async setWallpanel(value){await nextTurn();if(value.fail)throw new Error('test-coinglass-private-key must not escape');wallpanel=normalizeWallpanel(value);calls.push('wallpanel');return structuredClone(wallpanel);},
        };history.markets.push(market);return market;
      },
      chatFactory:({getConfig,saveTokens})=>{
        const calls=[],states=new Map();let serial=0;
        const chat={calls,getConfig,saveTokens,async start(){calls.push({type:'start'});},async stop(){calls.push({type:'stop'});},async configure(){calls.push({type:'configure'});},
          publicState:()=>({state:getConfig().enabled?'fixture-connected':'disabled',channel:getConfig().channel,login:getConfig().login,messages:[],readOnly:true}),
          authorize(input){const state='fixture-state-'+(++serial);states.set(state,input);calls.push({type:'authorize',...input,state});return{url:'https://id.twitch.tv/oauth2/authorize?state='+state};},
          async callback(input){calls.push({type:'callback',...input});const saved=states.get(input.state);states.delete(input.state);
            if(!saved||saved.sessionId!==input.sessionId||saved.redirectUri!==input.redirectUri||input.code!=='fixture-code')throw new QueueError('TWITCH_OAUTH_STATE_INVALID',401);
            const cfg=getConfig();await saveTokens({accessToken:SECRETS[4],refreshToken:SECRETS[5],userId:'123',login:'air3_reader',scopes:['user:read:chat'],expiresAt:Date.now()+3600000},
              {guard:current=>current.twitch.clientId===cfg.clientId&&current.twitch.clientSecret===cfg.clientSecret});return chat.publicState();},
          async clearAuth(){calls.push({type:'clearAuth'});await saveTokens({accessToken:'',refreshToken:'',userId:'',login:'',scopes:[],expiresAt:0});},
        };history.chats.push(chat);return chat;
      },
    },
  };
  let gateway,base;
  async function start(){gateway=await createGateway(config);await new Promise(resolve=>gateway.server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+gateway.server.address().port;}
  await start();t.after(async()=>{await gateway.close();await rm(root,{recursive:true,force:true});});
  async function request(route,{method='GET',value,token,cookie,origin,headers={},raw}={}){
    const response=await fetch(base+route,{method,redirect:'manual',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(cookie?{Cookie:cookie}:{}),
      ...(origin!==undefined?{Origin:origin===true?base:origin}:{}),...(value!==undefined||raw!==undefined?{'Content-Type':'application/json'}:{}),...headers},
      ...(value!==undefined?{body:JSON.stringify(value)}:raw!==undefined?{body:raw}:{})});
    const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}return{status:response.status,data,text,headers:response.headers};
  }
  return{root,config,history,request,get base(){return base;},get process(){return history.processes.at(-1);},get market(){return history.markets.at(-1);},get chat(){return history.chats.at(-1);},
    get gateway(){return gateway;},async restart(){await gateway.close();await start();},
    async login(input={local:true}){const response=await request('/api/live/session',{method:'POST',origin:true,value:input});assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];},
    ready:id=>eventually(()=>request('/api/narrations/'+id,{token:PRODUCER}),r=>r.data.status==='ready'),
  };
}
const op=(value,method='PATCH')=>({method,value,token:OPERATOR});
const hasNoSecrets=value=>{const bytes=typeof value==='string'?value:JSON.stringify(value);for(const secret of SECRETS)assert.equal(bytes.includes(secret),false,'A private fixture value escaped');};

test('live HTTP roles keep producer, player and operator authority separate',async t=>{
  const f=await fixture(t);
  for(const token of [undefined,PLAYER,PRODUCER]){
    assert.equal((await f.request('/api/live/settings',{token})).status,401);
    assert.equal((await f.request('/api/live/start',{method:'POST',token,value:{mode:'record'}})).status,401);
    assert.equal((await f.request('/api/live/stop',{method:'POST',token,value:{}})).status,401);
  }
  assert.equal((await f.request('/api/live/settings',{token:OPERATOR})).status,200);
  assert.equal((await f.request('/api/player/claim',{method:'POST',token:OPERATOR,value:{playerId:'one'}})).status,401);
  assert.equal((await f.request('/api/narrations',{method:'POST',token:PLAYER,value:{id:'wrong-role',text:'test'}})).status,401);
  for(const token of [undefined,PLAYER])assert.equal((await f.request('/api/live/titles',{method:'POST',token,value:{title:'Blocked'}})).status,401);
  assert.equal(f.process.calls.filter(c=>c.type==='start').length,0);
});

test('local operator cookies are HttpOnly and same-origin protected against CSRF and host rebinding',async t=>{
  const f=await fixture(t);
  const denied=await f.request('/api/live/session',{method:'POST',origin:'https://foreign.example',value:{local:true}});assert.equal(denied.status,403);
  const rebinding=await f.request('/api/live/session',{method:'POST',origin:'http://foreign.example',headers:{Host:'foreign.example'},value:{local:true}});assert.equal(rebinding.status,403);
  const login=await f.request('/api/live/session',{method:'POST',origin:true,value:{local:true}});assert.equal(login.status,200);
  const header=login.headers.get('set-cookie'),cookie=header.split(';')[0];assert.match(header,/HttpOnly/);assert.match(header,/SameSite=Lax/);assert.match(cookie,/^air3_operator=[0-9a-f]{64}$/);
  assert.equal((await f.request('/api/live/session',{cookie})).data.authenticated,true);
  for(const options of [{},{origin:'https://foreign.example'},{origin:true,headers:{'Sec-Fetch-Site':'cross-site'}}]){
    const r=await f.request('/api/live/settings',{method:'PATCH',cookie,value:{scene:{emotion:'warm'}},...options});assert.equal(r.status,403);assert.equal(r.data.error,'ORIGIN_NOT_ALLOWED');
  }
  assert.equal((await f.request('/api/live/settings',{method:'PATCH',cookie,origin:true,value:{scene:{emotion:'warm'}}})).status,200);
  assert.equal((await f.request('/api/live/session',{method:'DELETE',cookie,origin:true})).status,200);
  assert.equal((await f.request('/api/live/settings',{cookie})).status,401);
});

test('remote-origin configuration requires an operator token and issues a Secure cookie',async t=>{
  const origin='https://studio.example';const f=await fixture(t,{live:{publicOrigin:origin}});
  assert.equal((await f.request('/api/live/session',{method:'POST',origin,value:{local:true}})).status,401);
  assert.equal((await f.request('/api/live/session',{method:'POST',origin,value:{token:PRODUCER}})).status,401);
  const result=await f.request('/api/live/session',{method:'POST',origin,value:{token:OPERATOR}});assert.equal(result.status,200);assert.equal(result.data.local,false);assert.match(result.headers.get('set-cookie'),/; Secure/);
  const cookie=result.headers.get('set-cookie').split(';')[0];assert.equal((await f.request('/api/live/settings',{method:'PATCH',origin,cookie,value:{scene:{emotion:'happy'}}})).status,200);
});

test('producer can publish titles and an asynchronously resolved wallpanel but cannot configure or start live output',async t=>{
  const f=await fixture(t);
  const title=await f.request('/api/titles',{method:'POST',token:PRODUCER,value:{enabled:true,title:'Mercati in apertura',subtitle:'Notiziario #AIR3',ticker:'Prima notizia\nSeconda notizia',ttlSeconds:120}});
  assert.equal(title.status,200);assert.deepEqual(title.data.ticker,['Prima notizia','Seconda notizia']);
  assert.equal((await f.request('/api/live/program')).data.titles.title,'Mercati in apertura');
  const panel=await f.request('/api/live/wallpanel',{method:'POST',token:PRODUCER,value:{title:'AIRTrack',source:'Fixture feed',cards:[{label:'Segnali',value:3}],rows:[{label:'BTC',value:'Live'}],ttlSeconds:60}});
  assert.equal(panel.status,200);assert.equal(panel.data.title,'AIRTrack');assert.equal(panel.data.cards[0].value,'3');assert.ok(Number.isFinite(panel.data.expiresAt));
  assert.equal((await f.request('/api/live/market')).data.wallpanel.title,'AIRTrack');
  assert.equal((await f.request('/api/live/settings',{...op({scene:{emotion:'sad'}}),token:PRODUCER})).status,401);
  const cross=await f.request('/api/live/titles',{method:'POST',token:PRODUCER,origin:'https://foreign.example',value:{title:'Bad'}});assert.equal(cross.status,403);
  const invalid=await f.request('/api/live/wallpanel',{method:'POST',token:PRODUCER,value:{fail:true}});assert.equal(invalid.status,400);assert.equal(invalid.data.error,'INVALID_WALLPANEL');hasNoSecrets(invalid.data);
  assert.equal(f.process.calls.filter(c=>c.type==='start').length,0);
});

test('private keys persist server-side but never appear in settings responses or public program/config/market',async t=>{
  const f=await fixture(t);const patch={stream:{provider:'restream',server:'rtmps://live.restream.io/live',key:SECRETS[0]},
    tts:{apiKey:SECRETS[1]},market:{coinglassKey:SECRETS[2]},twitch:{clientId:'testclient123',clientSecret:SECRETS[3],channel:'air3_test'}};
  const changed=await f.request('/api/live/settings',op(patch));assert.equal(changed.status,200);hasNoSecrets(changed.data);
  assert.equal(changed.data.stream.hasKey,true);assert.equal(changed.data.tts.hasApiKey,true);assert.equal(changed.data.market.hasCoinglassKey,true);assert.equal(changed.data.twitch.hasClientSecret,true);
  const stored=JSON.parse(await readFile(path.join(f.config.dataDir,'live-settings.json'),'utf8'));assert.equal(stored.stream.key,SECRETS[0]);assert.equal(stored.twitch.clientSecret,SECRETS[3]);
  for(const route of ['/api/public-config','/api/live/program','/api/live/market','/api/health']){const result=await f.request(route);assert.equal(result.status,200);hasNoSecrets(result.data);}
  const status=await f.request('/api/live/status',{token:OPERATOR});assert.equal(status.status,200);hasNoSecrets(status.data);
  const internal=await f.request('/api/live/settings',op({twitch:{accessToken:'forged-access'}}));assert.equal(internal.status,400);
  assert.equal((await f.request('/studio/data/live-settings.json')).status,404);
  await f.restart();const restored=await f.request('/api/live/settings',{token:OPERATOR});assert.equal(restored.status,200);assert.equal(restored.data.stream.hasKey,true);hasNoSecrets(restored.data);
  assert.equal(f.gateway.live.store.get().stream.key,SECRETS[0]);assert.equal(f.process.calls.filter(c=>c.type==='start').length,0);
});

test('live output starts only from an authorized explicit POST and stops before endpoint settings can change',async t=>{
  const f=await fixture(t);await f.request('/api/live/settings',op({stream:{provider:'restream',server:'rtmps://live.restream.io/live',key:SECRETS[0]}}));
  await f.login();await f.request('/api/live/program');await f.request('/api/live/settings',{token:OPERATOR});
  const preflight=await f.request('/api/live/preflight',op({mode:'record'},'POST'));assert.equal(preflight.status,200);assert.equal(f.process.calls.filter(c=>c.type==='start').length,0);
  assert.equal((await f.request('/api/live/start',{token:OPERATOR})).status,404);
  const invalid=await f.request('/api/live/start',op({mode:'invented'},'POST'));assert.equal(invalid.status,400);assert.equal(invalid.data.error,'INVALID_LIVE_MODE');
  const record=await f.request('/api/live/start',op({mode:'record'},'POST'));assert.equal(record.status,202);assert.equal(record.data.mode,'record');
  let call=f.process.calls.filter(c=>c.type==='start').at(-1);assert.equal(call.env.AIR3_OUTPUT_MODE,'file');assert.equal(call.env.AIR3_RTMP_URL,'');assert.equal(call.origin,f.base);assert.equal(call.env.AIR3_STUDIO_URL,f.base+'/studio?output=1&live=1');
  assert.equal((await f.request('/api/live/settings',op({stream:{bitrateKbps:5000}}))).status,409);
  assert.equal((await f.request('/api/live/program')).data.streaming,false);f.process.state.phase='running';assert.equal((await f.request('/api/live/program')).data.streaming,true);
  assert.equal((await f.request('/api/live/stop',op({},'POST'))).status,200);assert.equal((await f.request('/api/live/program')).data.streaming,false);
  const started=await f.request('/api/live/start',op({mode:'live'},'POST'));assert.equal(started.status,202);hasNoSecrets(started.data);
  call=f.process.calls.filter(c=>c.type==='start').at(-1);assert.equal(call.env.AIR3_OUTPUT_MODE,'rtmp');assert.ok(call.env.AIR3_RTMP_URL.includes(SECRETS[0]));assert.equal(call.env.AIR3_REQUIRE_HARDWARE_RENDERING,'true');
  await f.request('/api/live/stop',op({},'POST'));
  assert.equal((await f.request('/api/live/start',op({mode:'twitch-test'},'POST'))).data.error,'TWITCH_TEST_ONLY');
  await f.request('/api/live/settings',op({stream:{provider:'twitch',server:'rtmp://live.twitch.tv/app',key:SECRETS[0]}}));
  assert.equal((await f.request('/api/live/start',op({mode:'twitch-test'},'POST'))).status,202);call=f.process.calls.filter(c=>c.type==='start').at(-1);assert.equal(new URL(call.env.AIR3_RTMP_URL).searchParams.get('bandwidthtest'),'true');
});

test('Twitch callback receives the initiating operator cookie session and cannot be replayed or stolen by another session',async t=>{
  const f=await fixture(t);await f.request('/api/live/settings',op({twitch:{clientId:'testclient123',clientSecret:SECRETS[3],channel:'air3_test',enabled:true}}));
  const first=await f.login(),second=await f.login();
  assert.equal((await f.request('/api/live/twitch/authorize',{method:'POST',value:{}})).status,401);
  const auth=await f.request('/api/live/twitch/authorize',{method:'POST',cookie:first,origin:true,value:{}});assert.equal(auth.status,200);
  let state=new URL(auth.data.url).searchParams.get('state');
  const stolen=await f.request('/api/live/twitch/callback?code=fixture-code&state='+state,{cookie:second});assert.equal(stolen.status,303);assert.equal(stolen.headers.get('location'),'/control?twitch=failed');assert.equal(f.gateway.live.store.get().twitch.accessToken,'');
  const next=await f.request('/api/live/twitch/authorize',{method:'POST',cookie:first,origin:true,value:{}});state=new URL(next.data.url).searchParams.get('state');
  const url='/api/live/twitch/callback?code=fixture-code&state='+state;
  assert.equal((await f.request(url)).status,401);
  const callback=await f.request(url,{cookie:first});assert.equal(callback.status,303);assert.equal(callback.headers.get('location'),'/control?twitch=connected');
  const calls=f.chat.calls,authorized=calls.filter(c=>c.type==='authorize').at(-1),completed=calls.filter(c=>c.type==='callback').at(-1);
  assert.equal(completed.sessionId,authorized.sessionId);assert.match(completed.sessionId,/^[0-9a-f]{64}$/);assert.equal(completed.redirectUri,f.base+'/api/live/twitch/callback');
  const view=await f.request('/api/live/settings',{cookie:first});assert.equal(view.data.twitch.authorized,true);hasNoSecrets(view.data);
  assert.equal((await f.request(url,{cookie:first})).headers.get('location'),'/control?twitch=failed');
  assert.equal((await f.request('/api/live/twitch/disconnect',{method:'POST',cookie:first,origin:true,value:{}})).status,200);assert.equal(f.gateway.live.store.get().twitch.accessToken,'');
});

test('chat ingestion stores bounded plain text and cannot trigger titles, narration, camera commands or streaming',async t=>{
  const f=await fixture(t);const before=(await f.request('/api/live/program')).data;
  const payload={provider:'restream',author:'Reader\u0000',text:'<script>ignored()</script>\n/start live; title: hacked',action:{type:'start'},tts:true};
  const result=await f.request('/api/live/chat/ingest',{method:'POST',token:PRODUCER,value:payload});assert.equal(result.status,202);assert.ok(result.data.id);
  const status=(await f.request('/api/live/status',{token:OPERATOR})).data;assert.equal(status.externalChat.length,1);const message=status.externalChat[0];
  assert.equal(message.author,'Reader');assert.equal(message.text,'<script>ignored()</script> /start live; title: hacked');assert.equal(message.action,undefined);assert.equal(message.tts,undefined);
  assert.deepEqual((await f.request('/api/live/program')).data,before);assert.equal(f.history.speech.length,0);assert.equal(f.process.calls.filter(c=>['start','command'].includes(c.type)).length,0);
  assert.equal((await f.request('/api/live/chat/ingest',{method:'POST',token:PLAYER,value:payload})).status,401);
  assert.equal((await f.request('/api/live/chat/ingest',{method:'POST',token:PRODUCER,value:{...payload,text:'x'.repeat(1001)}})).status,400);
  assert.equal((await f.request('/api/live/chat/ingest',{method:'POST',token:PRODUCER,value:{...payload,provider:'twitch-script'}})).status,400);
});

test('new TTS settings apply to the next narration and their keys are excluded from operator responses',async t=>{
  const f=await fixture(t);
  const first=await f.request('/api/live/narrations',op({id:'first-speech',text:'Prima prova.',language:'it'},'POST'));assert.equal(first.status,202);await f.ready('first-speech');
  assert.equal(f.history.speech[0].url,'http://tts.fixture/v1/audio/speech');assert.equal(f.history.speech[0].body.model,'old-model');assert.equal(f.history.speech[0].body.voice,'old-it');
  const settings={tts:{baseUrl:'https://new-tts.fixture/v1',apiKey:'test-next-tts-private',model:'new-model',voiceIt:'new-it',voiceEn:'new-en',speed:1.1}};
  const changed=await f.request('/api/live/settings',op(settings));assert.equal(changed.status,200);assert.equal(JSON.stringify(changed.data).includes('test-next-tts-private'),false);
  const second=await f.request('/api/live/narrations',op({id:'second-speech',text:'Second test.',language:'en'},'POST'));assert.equal(second.status,202);await f.ready('second-speech');
  const call=f.history.speech.at(-1);assert.equal(call.url,'https://new-tts.fixture/v1/audio/speech');assert.equal(call.body.model,'new-model');assert.equal(call.body.voice,'new-en');assert.equal(call.body.speed,1.1);assert.equal(call.options.headers.Authorization,'Bearer test-next-tts-private');
  const response=await f.request('/api/live/narrations/second-speech',{token:OPERATOR});assert.equal(response.status,200);assert.equal(JSON.stringify(response.data).includes('test-next-tts-private'),false);
  assert.equal(f.process.calls.filter(c=>c.type==='start').length,0);
});

test('operator commands are allowlisted and publisher or player credentials cannot drive the presenter',async t=>{
  const f=await fixture(t);await f.request('/api/live/start',op({mode:'record'},'POST'));
  for(const value of [{type:'exec',command:'anything'},{type:'monitor',monitor:'unknown'},{type:'home',script:'ignored'}]){
    const r=await f.request('/api/live/command',op(value,'POST'));assert.equal(r.status,400);assert.equal(r.data.error,'INVALID_LIVE_COMMAND');
  }
  for(const token of [PRODUCER,PLAYER])assert.equal((await f.request('/api/live/command',{method:'POST',token,value:{type:'home'}})).status,401);
  const valid=await f.request('/api/live/command',op({type:'monitor',monitor:'right'},'POST'));assert.equal(valid.status,200);assert.equal(valid.data.ok,true);
  assert.deepEqual(f.process.calls.filter(c=>c.type==='command').map(c=>c.command),[{type:'monitor',monitor:'right'}]);
});

test('settings reject internal-token injection, prototype keys and credential-bearing URLs atomically',async t=>{
  const f=await fixture(t);const before=await f.request('/api/live/settings',{token:OPERATOR});
  for(const value of [{twitch:{accessToken:'injected'}},{tts:{baseUrl:'https://user:password@example.test/v1'}},{stream:{provider:'restream',server:'rtmps://other.example/live',key:SECRETS[0]}}]){
    const r=await f.request('/api/live/settings',op(value));assert.equal(r.status,400);hasNoSecrets(r.data);
  }
  const pollution=await f.request('/api/live/settings',{method:'PATCH',token:OPERATOR,raw:'{"tts":{"__proto__":{"apiKey":"injected"}}}'});assert.equal(pollution.status,400);
  assert.deepEqual((await f.request('/api/live/settings',{token:OPERATOR})).data,before.data);
  assert.equal((await f.request('/api/live/status?access_token=injected',{token:OPERATOR})).status,400);
});

test('the actual settings queue evaluates a token-save guard before applying a deferred OAuth patch',async t=>{
  const f=await fixture(t);await f.request('/api/live/settings',op({twitch:{clientId:'firstclient',clientSecret:'first-private-secret'}}));
  const original=f.gateway.live.store.get().twitch;
  const replacing=f.gateway.live.store.update({twitch:{clientId:'secondclient',clientSecret:'second-private-secret'}});
  const stale=f.chat.saveTokens({accessToken:'stale-private-access',refreshToken:'stale-private-refresh'},
    {guard:current=>current.twitch.clientId===original.clientId&&current.twitch.clientSecret===original.clientSecret});
  await replacing;await assert.rejects(stale,{code:'LIVE_SETTINGS_CONFLICT'});
  assert.equal(f.gateway.live.store.get().twitch.clientId,'secondclient');assert.equal(f.gateway.live.store.get().twitch.accessToken,'');
  const saved=JSON.parse(await readFile(path.join(f.config.dataDir,'live-settings.json'),'utf8'));assert.equal(saved.twitch.accessToken,'');
});
