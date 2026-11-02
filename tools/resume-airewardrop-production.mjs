// Boot recovery is pinned to the explicitly approved production stream hash.
import{promises as fs}from'node:fs';import{parseEnv}from'node:util';
import{homedir}from'node:os';import{join}from'node:path';import{createHash}from'node:crypto';
const directory=join(homedir(),'.local/state/air3live-airewardrop-production');
const policy=JSON.parse(await fs.readFile(join(directory,'autorun.json'),'utf8'));
const settings=JSON.parse(await fs.readFile(join(directory,'live-settings.json'),'utf8'));
if(policy.channel!=='airewardrop'||policy.channelId!=='1276896937'||settings.twitch.channel!=='airewardrop'||settings.twitch.enabled||
 createHash('sha256').update(JSON.stringify(settings.stream)).digest('hex')!==policy.streamHash)throw new Error('PRODUCTION_AUTORUN_SCOPE_CHANGED');
if(!Number.isSafeInteger(policy.broadcastApprovedAt)||policy.broadcastApprovedAt<1){console.log(JSON.stringify({prepared:true,channel:'airewardrop',streamHeld:true,reason:'WAIT_FOR_LEGACY_ENCODER_STOP'}));process.exit(0);}
const env=parseEnv(await fs.readFile('/home/funboy/air3live/studio-broadcast/.env','utf8'));
const request=async(path,method='GET',body)=>{
 const r=await fetch('http://127.0.0.1:5890'+path,{method,redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:`Bearer ${env.AIR3_OPERATOR_TOKEN}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 if(!r.ok)throw new Error('PRODUCTION_RESUME_HTTP_FAILED');return r.json();
};
let ready=false;for(let i=0;i<60;i++){try{const t=await fetch('http://127.0.0.1:8882/health',{signal:AbortSignal.timeout(1000)});if(t.ok){await request('/api/health');ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
if(!ready)throw new Error('PRODUCTION_DEPENDENCIES_NOT_READY');
let status=await request('/api/live/status');
if(['stopped','idle'].includes(status.broadcast.phase))await request('/api/live/start','POST',{mode:'live'});
else if(!['running','starting','preflight','reconnecting'].includes(status.broadcast.phase))throw new Error('PRODUCTION_RESUME_STATE_UNCERTAIN');
for(let i=0;i<80;i++){status=await request('/api/live/status');if(status.broadcast.phase==='running'&&status.broadcast.frame>0){console.log(JSON.stringify({recovered:true,channel:'airewardrop',frame:status.broadcast.frame}));break;}if(i===79)throw new Error('PRODUCTION_STREAM_NOT_RUNNING');await new Promise(r=>setTimeout(r,500));}
