// Private, real CUDA cancellation canary. No player, Twitch or production TTS.
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
const directory=join(homedir(),'.local/state/air3live-v2-preview');
const credentials=JSON.parse(await fs.readFile(join(directory,'credentials.json'),'utf8'));
const base='http://127.0.0.1:8881';
const health=async()=>{const r=await fetch(base+'/health',{signal:AbortSignal.timeout(2000)});if(!r.ok)throw new Error('PREVIEW_TTS_UNAVAILABLE');return(await r.json()).editorial;};
const before=await health();if(before.active||before.pending)throw new Error('PREVIEW_TTS_BUSY');
const unauthorized=await fetch(base+'/v1/editorial/audio/speech/fixture-unauthorized',{method:'DELETE',signal:AbortSignal.timeout(2000)});
if(unauthorized.status!==401)throw new Error('CANCELLATION_AUTH_BOUNDARY_FAILED');
const controller=new AbortController();
const lowId=randomUUID();
const speech=(text,kind,signal,id=randomUUID())=>fetch(base+'/v1/editorial/audio/speech',{method:'POST',signal,headers:{Authorization:`Bearer ${credentials.tts}`,
  'Content-Type':'application/json','X-AIR3-Class':kind,'X-AIR3-Language':'en','X-AIR3-Request-ID':id},body:JSON.stringify({input:text,speed:1,response_format:'wav'})});
const low=speech('This is an intentionally long private test sentence about the studio, its lighting, its monitors, the voice of the presenter, the waiting questions, the independent news ticker, and the importance of yielding synthesis immediately when a higher priority response is waiting.','filler',controller.signal,lowId).then(r=>r.arrayBuffer()).catch(()=>null);
let active=false;for(let i=0;i<100;i++){if((await health()).active){active=true;break;}await new Promise(r=>setTimeout(r,25));}
if(!active)throw new Error('ACTIVE_SYNTHESIS_NOT_OBSERVED');
const at=performance.now();controller.abort();
try{
  const cancelled=await fetch(`${base}/v1/editorial/audio/speech/${lowId}`,{method:'DELETE',headers:{Authorization:`Bearer ${credentials.tts}`},signal:AbortSignal.timeout(2000)});
  if(!cancelled.ok)throw new Error('EXPLICIT_CANCELLATION_FAILED');
  const response=await speech('This private chat response follows a physically cancelled synthesis.','chat',AbortSignal.timeout(10000));
  const wav=Buffer.from(await response.arrayBuffer());if(!response.ok||wav.toString('ascii',0,4)!=='RIFF')throw new Error('CHAT_SYNTHESIS_FAILED');
  await low;const after=await health();
  const report={previewOnly:true,result:after.cancelled>before.cancelled&&!after.active?'PASS':'FAIL',before,after,chatWavAfterAbortMs:Math.round(performance.now()-at),wavBytes:wav.length};
  await fs.writeFile(join(directory,'tts-cancellation-report.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify(report));if(report.result!=='PASS')process.exitCode=1;
}finally{controller.abort();await low;}
