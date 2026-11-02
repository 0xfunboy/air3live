import{createHash}from'node:crypto';
import{mkdirSync,lstatSync,writeFileSync,readFileSync,readdirSync,unlinkSync,existsSync}from'node:fs';
import{join}from'node:path';
import{QueueError}from'./queue.mjs';
export function decodeEditorialChart(chart){
 if(!chart||Object.keys(chart).sort().join(',')!=='dataBase64,mimeType,sha256'||chart.mimeType!=='image/png'||!/^[a-f0-9]{64}$/.test(chart.sha256??'')||typeof chart.dataBase64!=='string'||chart.dataBase64.length>524288||!/^[A-Za-z0-9+/]+={0,2}$/.test(chart.dataBase64))throw new QueueError('INVALID_EDITORIAL_CHART');
 const bytes=Buffer.from(chart.dataBase64,'base64');
 if(bytes.length<24||bytes.length>393216||bytes.toString('base64')!==chart.dataBase64||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.toString('ascii',12,16)!=='IHDR'||createHash('sha256').update(bytes).digest('hex')!==chart.sha256)throw new QueueError('INVALID_EDITORIAL_CHART');
 const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
 if(width<1||height<1||width>2048||height>2048||width*height>2097152)throw new QueueError('INVALID_EDITORIAL_CHART');
 return{bytes,width,height,sha256:chart.sha256};
}
export function storeEditorialChart(directory,decoded,expiresAt){
 if(!directory)throw new QueueError('EDITORIAL_CHART_DISABLED',503);
 mkdirSync(directory,{recursive:true,mode:0o700});const info=lstatSync(directory);
 if(info.isSymbolicLink()||!info.isDirectory()||info.uid!==process.getuid()||(info.mode&0o077))throw new QueueError('EDITORIAL_CHART_STORAGE_UNSAFE',503);
 const file=join(directory,decoded.sha256+'.png');
 const files=readdirSync(directory).filter(name=>/^[a-f0-9]{64}\.png$/.test(name));
 if(!existsSync(file)&&(files.length>=1024||files.reduce((sum,name)=>sum+lstatSync(join(directory,name)).size,0)+decoded.bytes.length>128*1024*1024))throw new QueueError('EDITORIAL_CHART_STORAGE_FULL',503);
 try{writeFileSync(file,decoded.bytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;const st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>393216||createHash('sha256').update(readFileSync(file)).digest('hex')!==decoded.sha256)throw new QueueError('EDITORIAL_CHART_STORAGE_UNSAFE',503);}
 return{sha256:decoded.sha256,path:`/api/editorial-charts/${decoded.sha256}.png`,width:decoded.width,height:decoded.height,expiresAt};
}
export function pruneEditorialCharts(directory,retained,now=Date.now()){
 if(!directory||!existsSync(directory))return;
 for(const name of readdirSync(directory)){
  if(!/^[a-f0-9]{64}\.png$/.test(name)||retained.has(name.slice(0,64)))continue;
  const file=join(directory,name),info=lstatSync(file);
  if(info.isFile()&&!info.isSymbolicLink()&&info.mtimeMs<now-3600000)unlinkSync(file);
 }
}
