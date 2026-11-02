// One explicit operator/system audio test, never a fabricated viewer question.
import{promises as fs}from'node:fs';
import{parseEnv}from'node:util';
import{homedir}from'node:os';
import{join}from'node:path';
import{DatabaseSync}from'node:sqlite';
const directory=join(homedir(),'.local/state/air3live-air3agent-canary');
const env=parseEnv(await fs.readFile('/home/funboy/air3live/studio-broadcast/.env','utf8'));
const request=async(path,method='GET',body,token=env.AIR3_OPERATOR_TOKEN)=>{
 const response=await fetch('http://127.0.0.1:5890'+path,{method,redirect:'error',signal:AbortSignal.timeout(5000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 if(!response.ok)throw new Error('CANARY_AUDIO_HTTP_FAILED');return response.json();
};
const caps=await request('/api/producer/v1/capabilities','GET',undefined,env.AIR3_PRODUCER_TOKEN);
if(caps.channelId!=='1529779649')throw new Error('CANARY_AUDIO_SCOPE_VIOLATION');
const state=await request('/api/producer/v1/state','GET',undefined,env.AIR3_PRODUCER_TOKEN);if(state.pendingChat)throw new Error('CHAT_HAS_PRIORITY');
const outputCheck=process.argv.includes('--output-check');
const id=outputCheck?'air3agent-audio-output-check-20261101':'air3agent-system-audio-20261101';
if(!process.argv.includes('--inspect')){
 if(outputCheck)await fs.writeFile(join(directory,'audio-output-check-intent.json'),JSON.stringify({id,at:Date.now(),status:'stored-do-not-replay'}),{mode:0o600,flag:'wx'});
 await request('/api/live/narrations','POST',{id,language:'en',text:outputCheck?
  'This is the AIR3 V2 audio output check. If you hear this sentence on Twitch, the test stream audio is reaching you. The main channel is unchanged.':
  'This is a system audio test for AIR3 V2 on the air three agent test channel. The main channel and trading system are unchanged.',expiresAt:Date.now()+60000});
}
let job;
for(let i=0;i<120;i++){
 job=await request(`/api/live/narrations/${id}`);
 if(['finished','cancelled','failed','expired'].includes(job.status))break;
 await new Promise(r=>setTimeout(r,500));
}
const status=await request('/api/live/status');
const db=new DatabaseSync(join(directory,'narrations.sqlite'),{readOnly:true});
const detail=db.prepare('SELECT duration_ms,lip_sync_json,ready_at,started_at,ended_at FROM narrations WHERE id=?').get(id);db.close();
const lip=JSON.parse(detail?.lip_sync_json??'null');
const report={channel:'air3agent',operatorTest:true,job:id,status:job.status,lipSync:lip?.kind??null,audioDurationMs:detail?.duration_ms??null,
 synthesisMs:lip?.synthesisMs??null,alignmentMs:lip?.processingMs??null,playerStartedAt:detail?.started_at??null,playerEndedAt:detail?.ended_at??null,
 broadcaster:{phase:status.broadcast.phase,frame:status.broadcast.frame,fps:status.broadcast.fps,renderFps:status.broadcast.renderFps,lastProgressAt:status.broadcast.lastProgressAt},at:Date.now()};
await fs.writeFile(join(directory,outputCheck?'audio-output-check-report.json':'system-audio-report.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify(report));if(!['finished','cancelled'].includes(job.status))process.exitCode=1;
