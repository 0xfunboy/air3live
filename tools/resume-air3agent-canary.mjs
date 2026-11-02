// Reboot recovery for the explicitly approved TEST output only. No arbitrary
// stream destination, main-channel bot or production Eliza startup authority.
import{promises as fs}from'node:fs';
import{parseEnv}from'node:util';
import{homedir}from'node:os';
import{join}from'node:path';
import{createHash}from'node:crypto';
const directory=join(homedir(),'.local/state/air3live-air3agent-canary');
const policy=JSON.parse(await fs.readFile(join(directory,'autorun.json'),'utf8'));
const settings=JSON.parse(await fs.readFile(join(directory,'live-settings.json'),'utf8'));
const hash=createHash('sha256').update(JSON.stringify(settings.stream)).digest('hex');
if(policy.channel!=='air3agent'||policy.channelId!=='1529779649'||hash!==policy.streamHash||settings.twitch.channel!=='air3agent')throw new Error('CANARY_AUTORUN_SCOPE_CHANGED');
const env=parseEnv(await fs.readFile('/home/funboy/air3live/studio-broadcast/.env','utf8'));
const request=async(path,method='GET',body)=>{
 const response=await fetch('http://127.0.0.1:5890'+path,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${env.AIR3_OPERATOR_TOKEN}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 if(!response.ok)throw new Error('CANARY_RESUME_HTTP_FAILED');return response.json();
};
let healthy=false;
for(let i=0;i<120;i++){try{
 const tts=await fetch('http://127.0.0.1:8882/health',{signal:AbortSignal.timeout(1000)});if(tts.ok){await request('/api/health');healthy=true;break;}
}catch{}await new Promise(r=>setTimeout(r,500));}
if(!healthy)throw new Error('CANARY_DEPENDENCIES_NOT_READY');
let status=await request('/api/live/status');
if(['stopped','idle'].includes(status.broadcast.phase))await request('/api/live/start','POST',{mode:'live'});
else if(!['running','starting','preflight','reconnecting'].includes(status.broadcast.phase))throw new Error('CANARY_RESUME_STATE_UNCERTAIN');
for(let i=0;i<90;i++){status=await request('/api/live/status');if(status.broadcast.phase==='running'&&status.broadcast.frame>0){console.log(JSON.stringify({recovered:true,channel:'air3agent',frame:status.broadcast.frame}));break;}if(i===89)throw new Error('CANARY_STREAM_NOT_RUNNING');await new Promise(r=>setTimeout(r,500));}
