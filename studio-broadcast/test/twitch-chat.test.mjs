import test from 'node:test';
import assert from 'node:assert/strict';
import { createTwitchChat } from '../src/twitch-chat.mjs';

const REDIRECT = 'http://127.0.0.1:5890/api/live/twitch/callback';
const SESSION = 'operator-session-for-unit-test-0001';
const wait = async () => { for (let i=0;i<8;i++) await new Promise(resolve => setImmediate(resolve)); };
const response = (data, status=200, headers={}) => new Response(JSON.stringify(data), { status, headers });
function harness({ token = 'test-access', enabled = true, fetchHook, saveHook } = {}) {
  let time=1_790_000_000_000, timerCount=0, messageCount=0;
  const timers=new Map(), sockets=[], calls=[], saves=[];
  const config={ enabled, clientId:'test-client', clientSecret:'test-client-secret', channel:'air3_test',
    accessToken:token, refreshToken:'test-refresh', userId:token?'123':'', login:token?'chat_reader':'', scopes:token?['user:read:chat']:[], expiresAt:0 };
  class Socket extends EventTarget {
    constructor(url) { super(); this.url=url; this.closed=false; sockets.push(this); }
    close() { this.closed=true; this.dispatchEvent(new Event('close')); }
    send() { throw new Error('The read-only client must never send socket messages'); }
    frame(data) { this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)})); }
  }
  const fetchImpl=async (url,options) => {
    calls.push({url,options});
    const hooked=await fetchHook?.({url,options,config,calls}); if(hooked) return hooked;
    if(url.endsWith('/validate')) return response({client_id:config.clientId,user_id:'123',login:'chat_reader',scopes:['user:read:chat'],expires_in:3600});
    if(url.endsWith('/token')) return response({access_token:'test-new-access',refresh_token:'test-new-refresh',scope:['user:read:chat'],expires_in:3600});
    if(url.includes('/users?')) return response({data:[{id:'456',login:config.channel||'chat_reader'}]});
    if(url.endsWith('/eventsub/subscriptions')) return response({data:[{id:'subscription-'+calls.length}]},202);
    throw new Error('Unexpected HTTP request in unit test');
  };
  const chat=createTwitchChat({getConfig:()=>({...config}),saveTokens:async(patch,options={})=>{
    await saveHook?.({patch,options,config});
    if(options.guard&&!options.guard({twitch:{...config}}))throw Object.assign(new Error('LIVE_SETTINGS_CONFLICT'),{code:'LIVE_SETTINGS_CONFLICT',statusCode:409});
    saves.push({...patch});Object.assign(config,patch);
  },fetchImpl,WebSocketImpl:Socket,now:()=>time,
    setTimeoutImpl:(fn,delay)=>{const id=++timerCount;timers.set(id,{fn,delay,at:time+delay});return id;},clearTimeoutImpl:id=>timers.delete(id)});
  const metadata=(type,extra={})=>({message_id:'event-'+(++messageCount),message_type:type,message_timestamp:new Date(time).toISOString(),...extra});
  const welcome=(socket=sockets.at(-1),id='session-'+sockets.length)=>socket.frame({metadata:metadata('session_welcome'),payload:{session:{id,keepalive_timeout_seconds:30}}});
  const notification=(type,event,extra={},socket=sockets.at(-1))=>socket.frame({metadata:metadata('notification',extra),payload:{subscription:{type,condition:{broadcaster_user_id:'456',user_id:'123'}},event:{broadcaster_user_id:'456',...event}}});
  const message=(id,text='Hello',userId='999',extra={})=>notification('channel.chat.message',{message_id:id,chatter_user_id:userId,chatter_user_login:'viewer',chatter_user_name:'Viewer',message:{text},color:'#33aaFF',...extra});
  async function tick(ms) { const target=time+ms; for(;;) {const next=[...timers.entries()].filter(([,v])=>v.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;time=next[1].at;timers.delete(next[0]);await next[1].fn();await wait();} time=target;await wait(); }
  async function fireDelay(ms) {const entry=[...timers.entries()].find(([,v])=>v.delay===ms);assert.ok(entry,'Expected scheduled task '+ms);timers.delete(entry[0]);await entry[1].fn();await wait();}
  return {chat,config,sockets,calls,saves,timers,welcome,notification,message,tick,fireDelay,metadata,setTime:value=>{time=value;},now:()=>time};
}
async function connected(h) { await h.chat.start(); h.welcome(); await wait(); assert.equal(h.chat.publicState().state,'connected'); }

test('Twitch OAuth state is random, session bound, expiring and single use; grant stays server-only',async()=>{
  const h=harness({token:'',enabled:false}), {chat}=h;
  const result=chat.authorize({redirectUri:REDIRECT,sessionId:SESSION}), url=new URL(result.url), state=url.searchParams.get('state');
  assert.equal(url.origin,'https://id.twitch.tv');assert.equal(url.searchParams.get('scope'),'user:read:chat');assert.equal(url.searchParams.get('response_type'),'code');
  assert.match(state,/^[0-9a-f]{64}$/);assert.equal(url.searchParams.has('client_secret'),false);
  const view=await chat.callback({code:'test-code',state,redirectUri:REDIRECT,sessionId:SESSION});
  assert.equal(h.config.accessToken,'test-new-access');assert.equal(h.config.userId,'123');assert.equal(h.config.login,'chat_reader');assert.equal(view.authorized,true);
  assert.ok(!JSON.stringify(view).includes('test-new-access'));assert.ok(!JSON.stringify(view).includes('test-client-secret'));assert.equal(h.sockets.length,0);
  await assert.rejects(chat.callback({code:'test-code',state,redirectUri:REDIRECT,sessionId:SESSION}),{code:'TWITCH_OAUTH_STATE_INVALID'});
  const wrong=new URL(chat.authorize({redirectUri:REDIRECT,sessionId:SESSION}).url).searchParams.get('state');
  await assert.rejects(chat.callback({code:'test-code',state:wrong,redirectUri:REDIRECT,sessionId:SESSION+'other'}),{code:'TWITCH_OAUTH_STATE_INVALID'});
  const expired=new URL(chat.authorize({redirectUri:REDIRECT,sessionId:SESSION}).url).searchParams.get('state');h.setTime(h.now()+601_000);
  await assert.rejects(chat.callback({code:'test-code',state:expired,redirectUri:REDIRECT,sessionId:SESSION}),{code:'TWITCH_OAUTH_STATE_INVALID'});chat.stop();
});

test('OAuth rejects remote HTTP redirects, swapped redirect/client, missing session and wrong token scopes',async()=>{
  const h=harness({token:'',enabled:false});
  assert.throws(()=>h.chat.authorize({redirectUri:'http://example.test/callback',sessionId:SESSION}),{code:'TWITCH_REDIRECT_INVALID'});
  assert.throws(()=>h.chat.authorize({redirectUri:REDIRECT,sessionId:'short'}),{code:'TWITCH_OPERATOR_SESSION_REQUIRED'});
  const first=new URL(h.chat.authorize({redirectUri:REDIRECT,sessionId:SESSION}).url).searchParams.get('state');
  await assert.rejects(h.chat.callback({code:'test-code',state:first,redirectUri:'http://localhost:5890/callback',sessionId:SESSION}),{code:'TWITCH_OAUTH_STATE_INVALID'});
  const scoped=harness({token:'',enabled:false,fetchHook:({url})=>url.endsWith('/validate')?response({client_id:'test-client',user_id:'123',login:'chat_reader',scopes:[]}):undefined});
  const second=new URL(scoped.chat.authorize({redirectUri:REDIRECT,sessionId:SESSION}).url).searchParams.get('state');
  await assert.rejects(scoped.chat.callback({code:'test-code',state:second,redirectUri:REDIRECT,sessionId:SESSION}),{code:'TWITCH_SCOPE_REQUIRED'});assert.equal(scoped.saves.length,0);
  const mismatch=harness({token:'',enabled:false,fetchHook:({url})=>url.endsWith('/validate')?response({client_id:'other-client',user_id:'123',login:'chat_reader',scopes:['user:read:chat']}):undefined});
  const third=new URL(mismatch.chat.authorize({redirectUri:REDIRECT,sessionId:SESSION}).url).searchParams.get('state');
  await assert.rejects(mismatch.chat.callback({code:'test-code',state:third,redirectUri:REDIRECT,sessionId:SESSION}),{code:'TWITCH_AUTH_INVALID'});assert.equal(mismatch.saves.length,0);
});

test('chat validates initial authorization and subscribes only to the four read-only EventSub types',async()=>{
  const h=harness();await connected(h);
  assert.equal(h.sockets.length,1);assert.equal(new URL(h.sockets[0].url).hostname,'eventsub.wss.twitch.tv');
  assert.ok(h.calls[0].url.endsWith('/validate'));
  const subscriptions=h.calls.filter(c=>c.url.endsWith('/eventsub/subscriptions')).map(c=>JSON.parse(c.options.body));
  assert.deepEqual(subscriptions.map(s=>s.type).sort(),['channel.chat.clear','channel.chat.clear_user_messages','channel.chat.message','channel.chat.message_delete']);
  assert.ok(subscriptions.every(s=>s.condition.user_id==='123'&&s.condition.broadcaster_user_id==='456'&&s.transport.method==='websocket'&&s.transport.session_id==='session-1'));
  assert.equal(h.calls.some(c=>/chat\/messages|chat\/announcements/.test(c.url)),false);
  assert.ok(h.calls.every(c=>c.options.redirect==='error'));h.chat.stop();assert.equal(h.timers.size,0);
});

test('read-only cache deduplicates, caps at 200 and honors deletes, user clears and room clears',async()=>{
  const h=harness();await connected(h);
  h.message('message-1','First');h.message('message-1','Duplicate');await wait();assert.equal(h.chat.publicState().messages.length,1);
  h.notification('channel.chat.message_delete',{message_id:'message-1'});h.message('message-1','Late duplicate');await wait();assert.equal(h.chat.publicState().messages.length,0);
  h.message('message-2','User A','100');h.message('message-3','User B','101');await wait();
  h.notification('channel.chat.clear_user_messages',{target_user_id:'100'});await wait();assert.deepEqual(h.chat.publicState().messages.map(m=>m.id),['message-3']);
  h.notification('channel.chat.clear',{});await wait();assert.equal(h.chat.publicState().messages.length,0);
  h.setTime(h.now()+1);
  for(let i=0;i<220;i++)h.message('bounded-'+i,'Message '+i);await wait();
  const view=h.chat.publicState();assert.equal(view.messages.length,200);assert.equal(view.messages[0].id,'bounded-20');view.messages[0].text='Changed externally';assert.notEqual(h.chat.publicState().messages[0].text,view.messages[0].text);h.chat.stop();
});

test('chat sanitizes controls and treats user text as data, ignoring foreign channel notifications',async()=>{
  const h=harness();await connected(h);
  h.message('controls','Text\u0000\u202E<script>test</script>','999',{color:'url(https://example.test)',chatter_user_name:'Name\u0000'});
  h.message('wrong','Foreign','999',{broadcaster_user_id:'other'});await wait();
  const [row]=h.chat.publicState().messages;assert.equal(h.chat.publicState().messages.length,1);assert.equal(row.text,'Text  <script>test</script>');assert.equal(row.color,'#d9e3f0');assert.equal(row.userName,'Name ');h.chat.stop();
});

test('server-directed WebSocket handover preserves the old socket until welcome without resubscribing',async()=>{
  const h=harness();await connected(h);const original=h.sockets[0], reconnect='wss://eventsub.wss.twitch.tv/ws?reconnect=test-ticket';
  original.frame({metadata:h.metadata('session_reconnect'),payload:{session:{reconnect_url:reconnect}}});await wait();
  assert.equal(h.sockets.length,2);assert.equal(h.sockets[1].url,reconnect);assert.equal(original.closed,false);
  h.notification('channel.chat.message',{message_id:'during-handover',chatter_user_id:'999',message:{text:'Kept'}},{},original);await wait();
  h.welcome(h.sockets[1],'migrated-session');await wait();assert.equal(original.closed,true);assert.equal(h.chat.publicState().state,'connected');
  assert.equal(h.calls.filter(c=>c.url.endsWith('/eventsub/subscriptions')).length,4);assert.equal(h.chat.publicState().messages[0].text,'Kept');h.chat.stop();
});

test('ordinary disconnect resubscribes, heartbeat resets on keepalive and explicit stop cancels all retries',async()=>{
  const h=harness();await connected(h);h.sockets[0].close();await wait();assert.equal(h.chat.publicState().state,'reconnecting');
  await h.tick(1000);assert.equal(h.sockets.length,2);h.welcome();await wait();assert.equal(h.calls.filter(c=>c.url.endsWith('/eventsub/subscriptions')).length,8);
  await h.tick(20_000);h.sockets.at(-1).frame({metadata:h.metadata('session_keepalive'),payload:{}});await wait();
  await h.tick(20_000);assert.equal(h.chat.publicState().state,'connected');
  await h.tick(11_001);assert.equal(h.chat.publicState().state,'reconnecting');assert.ok(h.chat.publicState().reconnects>=2);
  h.chat.stop();const count=h.sockets.length;await h.tick(120_000);assert.equal(h.sockets.length,count);assert.equal(h.timers.size,0);
});

test('untrusted reconnect URLs never open a second connection and errors do not reflect token-bearing data',async()=>{
  const h=harness();await connected(h);
  h.sockets[0].frame({metadata:h.metadata('session_reconnect'),payload:{session:{reconnect_url:'wss://evil.example/private?token=test-client-secret'}}});await wait();
  assert.equal(h.sockets.length,1);assert.equal(h.chat.publicState().state,'reconnecting');assert.ok(!JSON.stringify(h.chat.publicState()).includes('test-client-secret'));h.chat.stop();
});

test('expired access is refreshed once, URL encoded and revalidated before use',async()=>{
  const h=harness({fetchHook:({url,options})=>url.endsWith('/validate')&&options.headers.Authorization==='OAuth test-access'?response({message:'test-access secret response'},401):undefined});
  h.config.refreshToken='test+refresh/=?';await connected(h);
  const grants=h.calls.filter(c=>c.url.endsWith('/token'));assert.equal(grants.length,1);const body=new URLSearchParams(grants[0].options.body);
  assert.equal(body.get('refresh_token'),'test+refresh/=?');assert.equal(body.get('grant_type'),'refresh_token');assert.equal(h.config.refreshToken,'test-new-refresh');
  assert.ok(h.calls.filter(c=>c.url.endsWith('/validate')).length>=2);assert.ok(!JSON.stringify(h.chat.publicState()).includes('test-new-access'));h.chat.stop();
});

test('hourly validation and revoked authorization end the live chat session',async()=>{
  let revoked=false;const h=harness({fetchHook:({url})=>revoked&&(url.endsWith('/validate')||url.endsWith('/token'))?response({message:'private error'},401):undefined});await connected(h);
  const count=h.calls.filter(c=>c.url.endsWith('/validate')).length;await h.fireDelay(3_600_000);assert.equal(h.calls.filter(c=>c.url.endsWith('/validate')).length,count+1);
  revoked=true;await h.fireDelay(3_600_000);assert.equal(h.chat.publicState().state,'auth_required');assert.equal(h.chat.publicState().authorized,false);assert.equal(h.sockets[0].closed,true);assert.equal(h.timers.size,0);h.chat.stop();
});

test('event revocation and authorization failure do not reconnect in an endless loop',async()=>{
  const h=harness();await connected(h);h.sockets[0].frame({metadata:h.metadata('revocation'),payload:{subscription:{type:'channel.chat.message',status:'authorization_revoked'}}});await wait();
  assert.equal(h.chat.publicState().state,'auth_required');await h.tick(60_000);assert.equal(h.sockets.length,1);
  const forbidden=harness({fetchHook:({url})=>url.endsWith('/eventsub/subscriptions')?response({message:'forbidden'},403):undefined});await forbidden.chat.start();forbidden.welcome();await wait();assert.equal(forbidden.chat.publicState().state,'auth_required');assert.equal(forbidden.timers.size,0);h.chat.stop();forbidden.chat.stop();
});

test('clearing authorization prevents an in-flight OAuth callback from restoring credentials',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;});const h=harness({token:'',enabled:false,fetchHook:async({url})=>{if(url.endsWith('/token')){await held;return response({access_token:'test-late-access',refresh_token:'test-late-refresh'});}}});
  const state=new URL(h.chat.authorize({redirectUri:REDIRECT,sessionId:SESSION}).url).searchParams.get('state');
  const callback=h.chat.callback({code:'test-code',state,redirectUri:REDIRECT,sessionId:SESSION});await wait();await h.chat.clearAuth();release();
  await assert.rejects(callback,{code:'TWITCH_OAUTH_STATE_INVALID'});assert.equal(h.config.accessToken,'');assert.equal(h.config.refreshToken,'');assert.equal(h.sockets.length,0);
});

test('configure avoids unnecessary reconnects, clears cache on channel changes and stops when disabled',async()=>{
  const h=harness();await h.chat.configure();h.welcome();await wait();h.message('original-channel','A');await wait();
  await h.chat.configure();assert.equal(h.sockets.length,1);assert.equal(h.chat.publicState().messages.length,1);
  h.config.channel='second_channel';await h.chat.configure();assert.equal(h.sockets.length,2);assert.equal(h.sockets[0].closed,true);assert.equal(h.chat.publicState().messages.length,0);h.welcome();await wait();
  assert.equal(h.chat.publicState().channel,'second_channel');h.config.enabled=false;await h.chat.configure();assert.equal(h.chat.publicState().state,'disabled');assert.equal(h.timers.size,0);
});

test('concurrent unauthorized subscription requests share one refresh instead of racing token writes',async()=>{
  const h=harness({fetchHook:({url,options})=>url.endsWith('/eventsub/subscriptions')&&options.headers.Authorization==='Bearer test-access'?response({message:'expired'},401):undefined});
  await connected(h);
  assert.equal(h.calls.filter(c=>c.url.endsWith('/token')).length,1);
  assert.equal(h.calls.filter(c=>c.url.endsWith('/eventsub/subscriptions')).length,8);
  assert.equal(h.saves.filter(s=>s.accessToken).length,1);h.chat.stop();
});

test('stopping while initial validation is in flight cannot open a later WebSocket',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;});
  const h=harness({fetchHook:async({url})=>{if(url.endsWith('/validate'))await held;}});
  const starting=h.chat.start();await wait();h.chat.stop();release();await starting;
  assert.equal(h.sockets.length,0);assert.equal(h.chat.publicState().state,'stopped');assert.equal(h.timers.size,0);
});

test('rate limiting respects retry-after and never surfaces a remote credential-bearing error body',async()=>{
  let limited=true;
  const h=harness({fetchHook:({url})=>limited&&url.endsWith('/validate')?response({message:'test-client-secret test-access'},429,{'Retry-After':'45'}):undefined});
  await h.chat.start();assert.equal(h.chat.publicState().state,'reconnecting');assert.ok(!JSON.stringify(h.chat.publicState()).includes('test-client-secret'));
  limited=false;await h.tick(44_999);assert.equal(h.sockets.length,0);await h.tick(1);assert.equal(h.sockets.length,1);h.welcome();await wait();assert.equal(h.chat.publicState().state,'connected');h.chat.stop();
});

test('queued OAuth token persistence is guarded at write time against logout and client replacement',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;});let reached=false;
  const h=harness({token:'',enabled:false,saveHook:async({patch})=>{if(patch.accessToken){reached=true;await held;}}});
  const state=new URL(h.chat.authorize({redirectUri:REDIRECT,sessionId:SESSION}).url).searchParams.get('state');
  const callback=h.chat.callback({code:'test-code',state,redirectUri:REDIRECT,sessionId:SESSION});await wait();assert.equal(reached,true);
  await h.chat.clearAuth();h.config.clientId='replacement-client';h.config.clientSecret='replacement-secret';release();
  await assert.rejects(callback,{code:'LIVE_SETTINGS_CONFLICT'});assert.equal(h.config.accessToken,'');assert.equal(h.config.refreshToken,'');assert.equal(h.config.clientId,'replacement-client');
});

test('queued refresh cannot overwrite credentials issued by a newer login',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;});let reached=false;
  const h=harness({fetchHook:({url,options})=>url.endsWith('/validate')&&options.headers.Authorization==='OAuth test-access'?response({},401):undefined,
    saveHook:async({patch})=>{if(patch.accessToken){reached=true;await held;}}});
  const starting=h.chat.start();await wait();assert.equal(reached,true);
  h.config.accessToken='newer-login-access';h.config.refreshToken='newer-login-refresh';release();await starting;
  assert.equal(h.config.accessToken,'newer-login-access');assert.equal(h.config.refreshToken,'newer-login-refresh');assert.equal(h.saves.length,0);h.chat.stop();
});
