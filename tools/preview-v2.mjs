// Private preview only. No production environment is loaded into this process,
// no Twitch consumer or market poller is started, and streaming is denied.
import { promises as fs } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { loadConfig } from '../studio-broadcast/src/config.mjs';
import { createGateway } from '../studio-broadcast/src/gateway.mjs';
import { createLiveSettingsStore, defaultLiveSettings } from '../studio-broadcast/src/live-settings.mjs';

const args=process.argv.slice(2);
const option=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const directory=resolve(option('--data-dir',join(homedir(),'.local/state/air3live-v2-preview')));
const python=option('--python');
if(!python?.startsWith('/') || !directory.startsWith('/') || directory==='/' || directory===root || directory.startsWith(root+'/')) throw new Error('EXPLICIT_PRIVATE_PREVIEW_PATHS_REQUIRED');
await fs.access(python);
await fs.mkdir(directory,{recursive:true,mode:0o700});
const info=await fs.lstat(directory);
if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid()||(info.mode&0o077))throw new Error('PRIVATE_PREVIEW_DIRECTORY_REQUIRED');
const credentialsFile=join(directory,'credentials.json');
let credentials;
try {
  const stat=await fs.lstat(credentialsFile);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077)||stat.size>4096)throw new Error('INVALID_PREVIEW_CREDENTIAL_FILE');
  try{credentials=JSON.parse(await fs.readFile(credentialsFile,'utf8'));}catch{throw new Error('INVALID_PREVIEW_CREDENTIAL_FILE');}
} catch(error) {
  if(error.code!=='ENOENT')throw error;
  credentials=Object.fromEntries(['producer','player','operator','tts'].map(k=>[k,randomBytes(32).toString('hex')]));
  await fs.writeFile(credentialsFile,JSON.stringify(credentials),{flag:'wx',mode:0o600});
}
if(Object.keys(credentials).length!==4||new Set(Object.values(credentials)).size!==4||!Object.values(credentials).every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)))throw new Error('INVALID_PREVIEW_CREDENTIALS');
const sourceOrigin=new URL(option('--source-origin','http://127.0.0.1:5890'));
if(!['127.0.0.1','localhost','[::1]'].includes(sourceOrigin.hostname)||sourceOrigin.username||sourceOrigin.password||sourceOrigin.search||sourceOrigin.hash||sourceOrigin.pathname!=='/')throw new Error('INVALID_PREVIEW_SOURCE_ORIGIN');
async function publicSource(path){
  const response=await fetch(sourceOrigin.origin+path,{redirect:'error',signal:AbortSignal.timeout(3000)});
  if(!response.ok)throw new Error('PREVIEW_SOURCE_UNAVAILABLE');
  let size=0;const chunks=[];
  for await(const chunk of response.body){size+=chunk.length;if(size>262144)throw new Error('PREVIEW_SOURCE_TOO_LARGE');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const source=await publicSource('/api/public-config');
const sourceProgram=await publicSource('/api/live/program');
const env={AIR3_HOST:'127.0.0.1',AIR3_PORT:'5891',AIR3_DATA_DIR:directory,
  AIR3_PRODUCER_TOKEN:credentials.producer,AIR3_PLAYER_TOKEN:credentials.player,AIR3_OPERATOR_TOKEN:credentials.operator,
  AIR3_LIVE_ENABLED:'true',AIR3_LOCAL_OPERATOR:'true',AIR3_PUBLIC_ORIGIN:'http://127.0.0.1:5891',
  AIR3_EDITORIAL_ENABLED:'true',AIR3_EDITORIAL_CHANNEL_ID:'900000000000001',AIR3_EDITORIAL_PRODUCER_ID:'eliza-v2-preview',
  AIR3_EDITORIAL_ENVIRONMENT:'preview',
  AIR3_TTS_EDITORIAL_TRANSPORT:'true',AIR3_TTS_BASE_URL:'http://127.0.0.1:8881/v1/editorial/audio/speech',
  AIR3_TTS_API_KEY:credentials.tts,AIR3_TTS_VOICE_EN:'af_jessica',AIR3_TTS_VOICE_IT:'if_sara',
  AIR3_LIPSYNC_MODE:'auto',AIR3_RHUBARB_PATH:option('--rhubarb-path',''),
  AIR3_AVATAR_URL:source.avatarUrl??'',AIR3_RENDER_QUALITY:source.renderQuality??'auto',AIR3_WIDTH:'1280',AIR3_HEIGHT:'720',AIR3_FPS:'15'};
const config=loadConfig(env);
config.previewOnly=true;
const settingsFile=join(directory,'live-settings.json');
let settingsPresent=false;try{await fs.access(settingsFile);settingsPresent=true;}catch{}
if(!settingsPresent){
  const store=await createLiveSettingsStore(directory,defaultLiveSettings(config));
  // Only appearance and scene; no stream credentials, TTS secrets or Twitch auth.
  await store.update({look:sourceProgram.look,scene:sourceProgram.scene});
}
// The public Live config comes from settings.stream, not only loadConfig(env).
// Preserve the already-qualified render path; never force the HDR composer.
const previewSettings=await createLiveSettingsStore(directory,defaultLiveSettings(config));
await previewSettings.update({stream:{quality:source.renderQuality??'software',profile:'720p30'}});
const noStreaming=()=>{throw new Error('PREVIEW_STREAMING_DISABLED');};
config.liveDependencies={baseEnv:{AIR3_OUTPUT_MODE:'file'},
  processFactory:()=>({snapshot:()=>({phase:'idle',mode:'file',previewOnly:true}),start:noStreaming,
    stop:async()=>({stopped:true}),command:noStreaming,close:async()=>{},requestPreview(){}}),
  marketFactory:()=>({start:async()=>{},stop:()=>{},snapshot:()=>({schema:'air3.live.market.v1',updatedAt:Date.now(),previewOnly:true,feeds:{},wallpanel:null}),
    publicConfig:()=>({enabled:false,previewOnly:true}),configure:async()=>{},setWallpanel:noStreaming}),
  chatFactory:()=>({start:async()=>{},stop(){},publicState:()=>({enabled:false,readOnly:true,authorized:false}),
    configure:async()=>{},authorize:noStreaming,callback:noStreaming,clearAuth:async()=>{}})};
const ttsEnv={PATH:process.env.PATH,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',OMP_NUM_THREADS:'2',MKL_NUM_THREADS:'2',
  AIR3_TTS_HOST:'127.0.0.1',AIR3_TTS_PORT:'8881',AIR3_TTS_EDITORIAL_ENABLED:'true',AIR3_TTS_EDITORIAL_TOKEN:credentials.tts};
if(process.env.LD_LIBRARY_PATH)ttsEnv.LD_LIBRARY_PATH=process.env.LD_LIBRARY_PATH;
// Do not kill anything already listening: fail and let the supervisor report it.
async function ensureUnused(port){const net=await import('node:net');await new Promise((ok,fail)=>{
  const probe=net.createServer();probe.once('error',()=>fail(new Error('PREVIEW_PORT_OCCUPIED')));probe.listen(port,'127.0.0.1',()=>probe.close(ok));});}
await ensureUnused(8881);await ensureUnused(5891);
const tts=spawn(python,[join(root,'services/tts-server/server.py')],{cwd:root,env:ttsEnv,stdio:['ignore','inherit','inherit']});
let gateway;let stopping=false;
async function close(){if(stopping)return;stopping=true;await gateway?.close();tts.kill('SIGTERM');}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
tts.once('error',()=>{process.exitCode=1;void close();});
tts.once('exit',()=>{if(!stopping){process.exitCode=1;void close();}});
try{
  const until=Date.now()+120000;let healthy=false;
  while(!stopping&&Date.now()<until){
    try{const response=await fetch('http://127.0.0.1:8881/health',{signal:AbortSignal.timeout(1000)});if(response.ok){healthy=true;break;}}catch{}
    await new Promise(r=>setTimeout(r,500));
  }
  if(!healthy)throw new Error('PREVIEW_TTS_NOT_READY');
  gateway=await createGateway(config);
  await new Promise((ok,fail)=>{gateway.server.once('error',fail);gateway.server.listen(config.port,config.host,ok);});
  process.stdout.write(JSON.stringify({service:'air3-live-v2-preview',ready:true,origin:'http://127.0.0.1:5891',
    previewOnly:true,streaming:false,twitch:false,credentialsFile})+'\n');
}catch(error){process.exitCode=1;process.stderr.write('PREVIEW_START_FAILED\n');await close();}
