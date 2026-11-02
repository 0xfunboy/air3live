// Explicitly scoped to the already configured air3agent test output. The
// original source, settings, DB, credentials and stream destination stay intact.
import{promises as fs}from'node:fs';
import{constants}from'node:fs';
import{randomBytes,createHash}from'node:crypto';
import{parseEnv,promisify}from'node:util';
import{execFile}from'node:child_process';
import{homedir}from'node:os';
import{join,resolve}from'node:path';
import{fileURLToPath}from'node:url';
const exec=promisify(execFile),root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const directory=join(homedir(),'.local/state/air3live-air3agent-canary');
const source='/home/funboy/air3live/studio-broadcast';
const dropin=join(homedir(),'.config/systemd/user/air3-live.service.d/50-air3agent-canary.conf');
const env=parseEnv(await fs.readFile(join(source,'.env'),'utf8'));
const original=JSON.parse(await fs.readFile(join(source,'data/live-settings.json'),'utf8'));
if(original.twitch.channel!=='air3agent'||original.twitch.enabled||original.stream.provider!=='restream'||!original.stream.key)throw new Error('TEST_OUTPUT_SCOPE_NOT_PROVEN');
const command=process.argv[2]??'prepare';
const request=async(path,method='GET',body,role='operator')=>{
 const token=role==='operator'?env.AIR3_OPERATOR_TOKEN:env.AIR3_PRODUCER_TOKEN;
 const response=await fetch('http://127.0.0.1:5890'+path,{method,redirect:'error',signal:AbortSignal.timeout(45000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const value=await response.json();if(!response.ok)throw new Error(`LIVE_${response.status}_${/^[A-Z_]+$/.test(value.error??'')?value.error:'REQUEST_FAILED'}`);return value;
};
async function privateDirectory(path){await fs.mkdir(path,{recursive:true,mode:0o700});const s=await fs.lstat(path);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077))throw new Error('PRIVATE_DIRECTORY_REQUIRED');}
async function writePrivate(path,value){await fs.writeFile(path,value,{flag:'wx',mode:0o600});}
async function waitGateway(){for(let i=0;i<60;i++){try{return await request('/api/health');}catch{await new Promise(r=>setTimeout(r,500));}}throw new Error('GATEWAY_NOT_READY');}
async function restore(){
 await request('/api/live/stop','POST',{}).catch(()=>{});
 await fs.rename(dropin,join(directory,'50-air3agent-canary.conf.disabled'));
 await exec('systemctl',['--user','daemon-reload']);await exec('systemctl',['--user','restart','air3-live.service']);await waitGateway();
 await request('/api/live/start','POST',{mode:'live'});
}
if(command==='prepare'){
 await privateDirectory(directory);
 const status=await request('/api/live/status');
 if(!['running','reconnecting'].includes(status.broadcast.phase))throw new Error('ORIGINAL_TEST_STREAM_NOT_RUNNING');
 const credentials=JSON.parse(await fs.readFile(join(homedir(),'.local/state/air3live-v2-preview/credentials.json'),'utf8'));
 const settings=structuredClone(original);settings.tts={...settings.tts,baseUrl:'http://127.0.0.1:8881/v1/editorial/audio/speech',apiKey:credentials.tts};
 await writePrivate(join(directory,'live-settings.json'),JSON.stringify(settings));
 await writePrivate(join(directory,'producer.json'),JSON.stringify({channel:'air3agent',channelId:'1529779649',producerToken:env.AIR3_PRODUCER_TOKEN}));
 await writePrivate(join(directory,'gateway.env'),`AIR3_DATA_DIR=${directory}\nAIR3_EDITORIAL_ENABLED=true\nAIR3_EDITORIAL_ENVIRONMENT=preview\nAIR3_EDITORIAL_PRODUCER_ID=eliza-air3agent-canary\nAIR3_EDITORIAL_CHANNEL_ID=1529779649\nAIR3_TTS_EDITORIAL_TRANSPORT=true\n`);
 await writePrivate(join(directory,'cutover.json'),JSON.stringify({stage:'prepared',channel:'air3agent',sourceCodeUnchanged:true,originalData:join(source,'data'),streamDestinationUnchanged:true,originalPhase:status.broadcast.phase,at:Date.now()}));
 console.log(JSON.stringify({stage:'prepared',channel:'air3agent',credentialsNeverPrinted:true,streamDestinationUnchanged:true}));
}else if(command==='activate'){
 const queue=await request('/api/health');if(Object.entries(queue.queue).some(([key,value])=>['queued','generating','ready','leased','playing'].includes(key)&&value))throw new Error('ORIGINAL_VOICE_QUEUE_NOT_DRAINED');
 let installed=false;
 try{
  await fs.lstat(dropin).then(()=>{throw new Error('CANARY_DROPIN_ALREADY_EXISTS');},error=>{if(error.code!=='ENOENT')throw error;});
  await request('/api/live/stop','POST',{});
  await fs.mkdir(join(homedir(),'.config/systemd/user/air3-live.service.d'),{recursive:true,mode:0o700});
  await fs.copyFile(join(root,'ops/air3-live-air3agent-canary.conf'),dropin,constants.COPYFILE_EXCL);installed=true;
  await exec('systemctl',['--user','daemon-reload']);await exec('systemctl',['--user','restart','air3-live.service']);await waitGateway();
  const caps=await request('/api/producer/v1/capabilities','GET',undefined,'producer');
  if(caps.channelId!=='1529779649'||caps.environment!=='preview'||!caps.features.physicalTtsCancellation)throw new Error('WRONG_CANARY_GATEWAY');
  const initial=await request('/api/live/status');
  if(['stopped','idle'].includes(initial.broadcast.phase)){
    await request('/api/live/preflight','POST',{mode:'live'});await request('/api/live/start','POST',{mode:'live'});
  }else if(!['running','starting','preflight','reconnecting'].includes(initial.broadcast.phase))throw new Error('CANARY_START_STATE_UNCERTAIN');
  let status;for(let i=0;i<90;i++){status=await request('/api/live/status');if(status.broadcast.phase==='running'&&status.broadcast.frame>0)break;await new Promise(r=>setTimeout(r,500));}
  if(status.broadcast.phase!=='running'||!status.broadcast.frame)throw new Error('TEST_BROADCAST_NOT_RUNNING');
  await fs.writeFile(join(directory,'cutover.json'),JSON.stringify({stage:'active',channel:'air3agent',at:Date.now(),streamDestinationUnchanged:true,publicSourceUnchanged:true,broadcast:{phase:status.broadcast.phase,frame:status.broadcast.frame,renderFps:status.broadcast.renderFps}}),{mode:0o600});
  console.log(JSON.stringify({stage:'active',channel:'air3agent',broadcast:{phase:status.broadcast.phase,frame:status.broadcast.frame,renderFps:status.broadcast.renderFps},streamDestinationUnchanged:true}));
 }catch(error){if(installed)await restore();else await request('/api/live/start','POST',{mode:'live'}).catch(()=>{});throw new Error(error.message==='CANARY_DROPIN_ALREADY_EXISTS'?error.message:'CANARY_ACTIVATION_FAILED_ORIGINAL_RESTORED');}
}else if(command==='qualify-runtime'){
 const state=await request('/api/producer/v1/state','GET',undefined,'producer');
 if(state.pendingChat)throw new Error('WAIT_FOR_CHAT_DRAIN');
 const token=randomBytes(32).toString('hex');
 await writePrivate(join(directory,'tts.env'),`AIR3_TTS_HOST=127.0.0.1\nAIR3_TTS_PORT=8882\nAIR3_TTS_EDITORIAL_ENABLED=true\nAIR3_TTS_EDITORIAL_TOKEN=${token}\n`);
 await fs.copyFile(join(root,'ops/air3-tts-air3agent-canary.service'),join(homedir(),'.config/systemd/user/air3-tts-air3agent-canary.service'),constants.COPYFILE_EXCL);
 await exec('systemctl',['--user','daemon-reload']);await exec('systemctl',['--user','start','air3-tts-air3agent-canary.service']);
 let healthy=false;for(let i=0;i<120;i++){try{const r=await fetch('http://127.0.0.1:8882/health',{signal:AbortSignal.timeout(1000)});if(r.ok){healthy=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
 if(!healthy)throw new Error('DEDICATED_TTS_NOT_READY');
 await request('/api/live/settings','PATCH',{tts:{baseUrl:'http://127.0.0.1:8882/v1/editorial/audio/speech',apiKey:token}});
 const current=JSON.parse(await fs.readFile(join(directory,'live-settings.json'),'utf8'));
 await writePrivate(join(directory,'autorun.json'),JSON.stringify({channel:'air3agent',channelId:'1529779649',streamHash:createHash('sha256').update(JSON.stringify(current.stream)).digest('hex'),approvedAt:Date.now()}));
 await fs.copyFile(join(root,'ops/air3-live-air3agent-canary.conf'),dropin);
 await exec('systemctl',['--user','daemon-reload']);
 await exec('/home/funboy/.local/bin/node',[join(root,'tools/resume-air3agent-canary.mjs')]);
 console.log(JSON.stringify({qualified:true,channel:'air3agent',ttsPort:8882,rebootRecoveryConfigured:true,mainServicesUntouched:true}));
}else if(command==='rollback'){
 const state=await request('/api/producer/v1/state','GET',undefined,'producer'),health=await request('/api/health');
 if(state.pendingChat||Object.entries(health.queue).some(([key,value])=>['queued','generating','ready','leased','playing'].includes(key)&&value))throw new Error('STOP_AND_DRAIN_CANARY_FIRST');
 await restore();console.log(JSON.stringify({stage:'restored-original-test-studio',channel:'air3agent'}));
}else throw new Error('UNKNOWN_CANARY_COMMAND');
