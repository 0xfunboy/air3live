// Anonymous, receive-only Twitch check. Never prints signed playback URLs.
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const require=createRequire(new URL('../studio-broadcast/package.json',import.meta.url));
const {launch}=require('puppeteer-core');
const run=promisify(execFile);
const directory=join(homedir(),'.local/state/air3live-air3agent-canary',`receiver-${Date.now()}-${randomUUID().slice(0,8)}`);
await fs.mkdir(directory,{recursive:true,mode:0o700});
const executablePath=(await fs.readFile('/home/funboy/air3live/studio-broadcast/.browser-path','utf8')).trim();
const report={receiveOnly:true,channel:'air3agent',startedAt:Date.now(),playlists:[],fragments:[],errors:[],video:[]};
let browser,writing=Promise.resolve(),totalBytes=0;
try{
 browser=await launch({executablePath,headless:true,ignoreDefaultArgs:['--mute-audio'],timeout:30000,
  env:{PATH:process.env.PATH,HOME:homedir(),LANG:'en_US.UTF-8',XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR,
   LD_LIBRARY_PATH:'/home/funboy/.local/lib/nvidia/usr/lib/x86_64-linux-gnu:/home/funboy/.local/usr/lib/x86_64-linux-gnu'},
  args:['--no-sandbox','--autoplay-policy=no-user-gesture-required','--disable-dev-shm-usage'],
  defaultViewport:{width:960,height:540}});
 const page=await browser.newPage();
 page.on('response',response=>{
  const url=new URL(response.url());
  if(!/(^|\.)ttvnw\.net$/.test(url.hostname))return;
  const playlist=url.pathname.endsWith('.m3u8');
  const fragment=url.pathname.endsWith('.ts');
  if(playlist)report.playlists.push({status:response.status(),at:Date.now()});
  if(!fragment||!response.ok())return;
  writing=writing.then(async()=>{
   if(totalBytes>=40*1024*1024)return;
   const bytes=await response.buffer();
   if(bytes.length>8*1024*1024||bytes.length+totalBytes>40*1024*1024)return;
   const file=`fragment-${report.fragments.length}.ts`;
   await fs.writeFile(join(directory,file),bytes,{mode:0o600});totalBytes+=bytes.length;
   report.fragments.push({file,bytes:bytes.length,at:Date.now()});
  }).catch(()=>{report.errors.push('FRAGMENT_CAPTURE_FAILED');});
 });
 await page.goto('https://www.twitch.tv/air3agent',{waitUntil:'domcontentloaded',timeout:30000});
 for(let i=0;i<12;i++){
  await new Promise(r=>setTimeout(r,5000));
  const state=await page.evaluate(async()=>{
   const v=document.querySelector('video');if(!v)return{present:false};
   v.muted=false;v.volume=1;await v.play().catch(()=>{});
   return{present:true,paused:v.paused,muted:v.muted,volume:v.volume,readyState:v.readyState,time:v.currentTime,width:v.videoWidth,height:v.videoHeight,error:v.error?.code??null};
  });report.video.push({at:Date.now(),...state});
 }
 await writing;
 const videoElement=await page.$('video');
 if(videoElement){await videoElement.screenshot({path:join(directory,'receiver-video.png')});report.videoFrame='receiver-video.png';}
 for(const fragment of report.fragments){
  try{
   const result=await run('/home/funboy/.local/bin/ffmpeg',['-hide_banner','-i',join(directory,fragment.file),'-vn','-af','volumedetect','-f','null','-'],{timeout:15000,maxBuffer:128*1024});
   fragment.meanDb=Number(result.stderr.match(/mean_volume:\s*([-\d.]+) dB/)?.[1]??NaN);
   fragment.maxDb=Number(result.stderr.match(/max_volume:\s*([-\d.]+) dB/)?.[1]??NaN);
  }catch{fragment.analysisError='FRAGMENT_AUDIO_DECODE_FAILED';}
 }
}catch(error){report.errors.push('RECEIVER_PROBE_FAILED');report.detail=String(error.message??'').replace(/https?:\/\/\S+/g,'[URL]').slice(0,1200);process.exitCode=1;}
finally{
 if(browser)await browser.close().catch(()=>{});
 report.endedAt=Date.now();report.totalBytes=totalBytes;
 await fs.writeFile(join(directory,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify({directory,...report}));
}
