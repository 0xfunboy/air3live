import{promises as fs}from'node:fs';import{parseEnv,promisify}from'node:util';
import{execFile}from'node:child_process';import{homedir}from'node:os';
import{join,resolve}from'node:path';import{fileURLToPath}from'node:url';import{randomBytes,createHash}from'node:crypto';
import{mergeLiveSettings}from'../studio-broadcast/src/live-settings.mjs';
const exec=promisify(execFile),root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const directory=join(homedir(),'.local/state/air3live-airewardrop-production');
const dropin=join(homedir(),'.config/systemd/user/air3-live.service.d/60-airewardrop-production.conf');
const bridgeDropin=join(homedir(),'.config/systemd/user/air3-dapp-bridge.service.d/60-airewardrop-production.conf');
const env=parseEnv(await fs.readFile('/home/funboy/air3live/studio-broadcast/.env','utf8'));
const request=async(path,method='GET',body)=>{
 const r=await fetch('http://127.0.0.1:5890'+path,{method,redirect:'error',signal:AbortSignal.timeout(25000),headers:{Authorization:`Bearer ${env.AIR3_OPERATOR_TOKEN}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 if(!r.ok)throw new Error(`PRODUCTION_HTTP_${r.status}`);return r.json();
};
const privateFile=(path,text)=>fs.writeFile(path,text,{flag:'wx',mode:0o600});
const gatewayReady=async()=>{for(let i=0;i<60;i++){try{return await request('/api/live/status');}catch{await new Promise(r=>setTimeout(r,500));}}throw new Error('PRODUCTION_GATEWAY_NOT_READY');};
async function activateBridge(){
 const status=await gatewayReady();if(status.settings?.twitch?.channel!=='airewardrop')throw new Error('BRIDGE_PRODUCTION_GATEWAY_REQUIRED');
 await fs.mkdir(join(homedir(),'.config/systemd/user/air3-dapp-bridge.service.d'),{recursive:true,mode:0o700});
 const content=`[Unit]\nAfter=air3-live.service\nPartOf=air3-live.service\n\n[Service]\nWorkingDirectory=${root}\nExecStart=\nExecStart=/home/funboy/.local/bin/node --env-file=/home/funboy/air3live/.env --env-file=${directory}/gateway.env ${root}/adapters/dapp-wallpanel.mjs\n`;
 let exists;try{exists=await fs.readFile(bridgeDropin,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
 if(exists!==undefined&&exists!==content)throw new Error('BRIDGE_OVERRIDE_CHANGED_REVIEW_REQUIRED');
 if(exists===undefined)await privateFile(bridgeDropin,content);
 await exec('systemctl',['--user','daemon-reload']);await exec('systemctl',['--user','restart','air3-dapp-bridge.service']);
 const deadline=Date.now()+20000;
 while(Date.now()<deadline){const snapshot=await request('/api/live/market');
  if(snapshot.wallpanel?.updatedAt>=deadline-20000&&!snapshot.wallpanel.stale)return{fresh:true,tradeCount:snapshot.wallpanel.trades?.length??0,updatedAt:snapshot.wallpanel.updatedAt};
  await new Promise(r=>setTimeout(r,500));
 }throw new Error('BRIDGE_PUBLICATION_NOT_CONFIRMED');
}
const command=process.argv[2]??'status';
if(command==='prepare'){
 let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>4096)throw new Error('INPUT_TOO_LARGE');}
 const value=JSON.parse(input);
 if(!['rtmps://live.restream.io:1935/live','rtmp://live.restream.io/live'].includes(value.server)||!/^re_[a-zA-Z0-9_]{10,100}$/.test(value.key??''))throw new Error('INVALID_APPROVED_RESTREAM_DESTINATION');
 await fs.mkdir(directory,{mode:0o700});
 const previous=JSON.parse(await fs.readFile(join(homedir(),'.local/state/air3live-air3agent-canary/live-settings.json'),'utf8'));
 if(previous.twitch.channel!=='air3agent'||previous.twitch.enabled)throw new Error('WRONG_SOURCE_STUDIO');
 const settings=mergeLiveSettings(previous,{stream:{provider:'restream',server:value.server,key:value.key},twitch:{enabled:false,channel:'airewardrop'}});
 const token=randomBytes(32).toString('hex');
 await privateFile(join(directory,'live-settings.json'),JSON.stringify(settings));
 await privateFile(join(directory,'producer.json'),JSON.stringify({channel:'airewardrop',channelId:'1276896937',producerToken:token}));
 await privateFile(join(directory,'gateway.env'),`AIR3_DATA_DIR=${directory}\nAIR3_EDITORIAL_ENABLED=true\nAIR3_EDITORIAL_ENVIRONMENT=production\nAIR3_EDITORIAL_PRODUCER_ID=eliza-airewardrop-v2\nAIR3_EDITORIAL_CHANNEL_ID=1276896937\nAIR3_TTS_EDITORIAL_TRANSPORT=true\nAIR3_PRODUCER_TOKEN=${token}\n`);
 await privateFile(join(directory,'autorun.json'),JSON.stringify({channel:'airewardrop',channelId:'1276896937',streamHash:createHash('sha256').update(JSON.stringify(settings.stream)).digest('hex'),approvedAt:Date.now()}));
 console.log(JSON.stringify({prepared:true,channel:'airewardrop',encryptedTransport:settings.stream.server.startsWith('rtmps:'),remoteChatDisabled:true,credentialsNeverPrinted:true}));
}else if(command==='activate'){
 const health=await request('/api/health');
 if(Object.entries(health.queue??{}).some(([key,n])=>['queued','generating','ready','leased','playing'].includes(key)&&n))throw new Error('DRAIN_OLD_VOICE_BEFORE_CUTOVER');
 await fs.lstat(dropin).then(()=>{throw new Error('PRODUCTION_DROPIN_ALREADY_EXISTS');},error=>{if(error.code!=='ENOENT')throw error;});
 await request('/api/live/stop','POST',{});
 const stopped=await request('/api/live/status');if(!['stopped','idle'].includes(stopped.broadcast.phase))throw new Error('OLD_STREAM_STOP_NOT_PROVEN');
 await privateFile(dropin,`[Unit]\nRequires=air3-tts-air3agent-canary.service\nAfter=air3-tts-air3agent-canary.service\n\n[Service]\nWorkingDirectory=${root}/studio-broadcast\nExecStart=\nExecStart=/home/funboy/.local/bin/node --env-file=/home/funboy/air3live/studio-broadcast/.env --env-file=${directory}/gateway.env ${root}/studio-broadcast/src/main.mjs\nExecStartPost=\nExecStartPost=/home/funboy/.local/bin/node ${root}/tools/resume-airewardrop-production.mjs\n`);
 await exec('systemctl',['--user','daemon-reload']);
 await exec('systemctl',['--user','restart','air3-live.service'],{timeout:120000});
 const status=await gatewayReady();
 if(!['idle','stopped','running'].includes(status.broadcast.phase))throw new Error('PRODUCTION_GATEWAY_STATE_UNCERTAIN');
 await activateBridge();
 console.log(JSON.stringify({gatewayActive:true,channel:'airewardrop',streamHeld:status.broadcast.phase!=='running',phase:status.broadcast.phase,frame:status.broadcast.frame,renderFps:status.broadcast.renderFps}));
}else if(command==='bridge'){
 console.log(JSON.stringify({bridge:await activateBridge(),credentialsFromActiveGateway:true}));
}else if(command==='start'){
 const file=join(directory,'autorun.json'),policy=JSON.parse(await fs.readFile(file,'utf8'));
 if(policy.channel!=='airewardrop'||policy.channelId!=='1276896937')throw new Error('WRONG_AUTORUN_POLICY');
 policy.broadcastApprovedAt=Date.now();const temp=file+'.pending';await privateFile(temp,JSON.stringify(policy));await fs.rename(temp,file);
 await exec('/home/funboy/.local/bin/node',[join(root,'tools/resume-airewardrop-production.mjs')],{timeout:120000});
 console.log(JSON.stringify({started:true,channel:'airewardrop',bootRecoveryEnabled:true}));
}else if(command==='status'){
 const status=await request('/api/live/status'),market=await request('/api/live/market');
 console.log(JSON.stringify({phase:status.broadcast.phase,frame:status.broadcast.frame,renderFps:status.broadcast.renderFps,channel:status.settings?.twitch?.channel,remoteChatEnabled:status.settings?.twitch?.enabled,
  wallpanel:{fresh:!!market.wallpanel?.updatedAt&&!market.wallpanel.stale,updatedAt:market.wallpanel?.updatedAt??null,tradeCount:market.wallpanel?.trades?.length??0}}));
}else if(command==='stop'){
 const file=join(directory,'autorun.json'),policy=JSON.parse(await fs.readFile(file,'utf8'));policy.broadcastApprovedAt=null;
 const temp=file+'.stop-pending';await privateFile(temp,JSON.stringify(policy));await fs.rename(temp,file);
 await request('/api/live/stop','POST',{});const status=await request('/api/live/status');if(!['stopped','idle'].includes(status.broadcast.phase))throw new Error('STREAM_STOP_NOT_PROVEN');console.log(JSON.stringify({stopped:true}));
}else if(command==='rollback-to-test'){
 await request('/api/live/stop','POST',{});const status=await request('/api/live/status');if(!['stopped','idle'].includes(status.broadcast.phase))throw new Error('STREAM_STOP_NOT_PROVEN');
 await fs.rename(dropin,join(directory,'60-airewardrop-production.conf.disabled'));
 try{await fs.rename(bridgeDropin,join(directory,'60-bridge-production.conf.disabled'));}catch(error){if(error.code!=='ENOENT')throw error;}
 await exec('systemctl',['--user','daemon-reload']);await exec('systemctl',['--user','restart','air3-live.service'],{timeout:120000});
 await exec('systemctl',['--user','restart','air3-dapp-bridge.service']);
 console.log(JSON.stringify({restored:'air3agent-test',mainLegacyBroadcastRequiresOperator:false}));
}else throw new Error('UNKNOWN_PRODUCTION_COMMAND');
