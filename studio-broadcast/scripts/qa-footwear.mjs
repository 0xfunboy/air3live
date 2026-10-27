import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
const project=path.resolve(import.meta.dirname,'..');
const output=path.resolve(process.env.AIR3_QA_DIR || path.join(project,'../docs/validation/current'),'footwear');
await mkdir(output,{recursive:true});
const chrome=process.env.AIR3_CHROME_PATH || (await readFile(path.join(project,'.browser-path'),'utf8')).trim();
const html=`<html><link rel="icon" href="data:,"><style>body{margin:0}canvas{display:block}</style><script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script><script type="module">
import * as THREE from 'three';import{GLTFLoader}from'three/addons/loaders/GLTFLoader.js';import{Air3AvatarRig}from'/air3-avatar.mjs';import{applyAvatarMaterials}from'/avatar-materials.mjs';import{createFootwearController}from'/air3-footwear.mjs';
const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setSize(960,960);renderer.setPixelRatio(1);renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1;document.body.append(renderer.domElement);const scene=new THREE.Scene();scene.background=new THREE.Color('#252a31');scene.add(new THREE.HemisphereLight(0xffffff,0x574d4a,.7));const key=new THREE.DirectionalLight(0xffffff,2.5);key.position.set(2,3,3);scene.add(key);const fill=new THREE.DirectionalLight(0xaacfff,.65);fill.position.set(-3,1,-1);scene.add(fill);const gltf=await new GLTFLoader().loadAsync('/assets/air3/models/AIR3-runtime.glb');await applyAvatarMaterials(gltf,{renderer});scene.add(gltf.scene);const rig=new Air3AvatarRig(gltf);rig.setEyeContactEnabled(false);rig.setMicroExpressionsEnabled(false);rig.setTime(.6);const ctrl=await createFootwearController({avatarRoot:gltf.scene,rig});window.ctrl=ctrl;window.rig=rig;window.scene=scene;window.model=gltf.scene;window.createController=createFootwearController;const plane=new THREE.Mesh(new THREE.PlaneGeometry(4,4),new THREE.MeshStandardMaterial({color:0x555963,roughness:.86}));plane.rotation.x=-Math.PI/2;plane.position.y=-.035;scene.add(plane);
const camera=new THREE.PerspectiveCamera(32,1,.01,100);window.go=async function(style,view='front',time=.6){await ctrl.setStyle(style);rig.setTime(time);ctrl.update();const c=view==='full'?new THREE.Vector3(0,.78,0):new THREE.Vector3(0,.16,.045);camera.position.copy(c).add(view==='full'?new THREE.Vector3(1.35,.4,3.4):view==='side'?new THREE.Vector3(.75,.12,.24):new THREE.Vector3(.36,.18,.85));camera.lookAt(c);renderer.render(scene,camera);const bounds=[];const p=new THREE.Vector3();scene.traverseVisible(m=>{if(m.isSkinnedMesh&&m.visible&&m.userData.air3Footwear){let min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];for(let i=0;i<m.geometry.attributes.position.count;i++){m.getVertexPosition(i,p);for(let k=0;k<3;k++){min[k]=Math.min(min[k],p.getComponent(k));max[k]=Math.max(max[k],p.getComponent(k));}}bounds.push({name:m.name,min,max,triangles:m.geometry.index.count/3});}});return {diagnostics:ctrl.diagnostics(),bounds};};window.output=()=>renderer.domElement.toDataURL();window.ready=true;
</script></html>`;
const types={'.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.glb':'model/gltf-binary','.png':'image/png','.webp':'image/webp'};
const requests={};
const server=createServer(async(req,res)=>{try{requests[req.url]=(requests[req.url]||0)+1;if(req.url.startsWith('/slow-footwear/')){await new Promise(resolve=>setTimeout(resolve,200));req.url='/assets/air3/footwear/'+req.url.slice('/slow-footwear/'.length);}if(req.url==='/'){res.setHeader('content-type','text/html');res.end(html);return;}const base=req.url.startsWith('/node_modules/')?project:path.join(project,'public');const decoded=decodeURIComponent(req.url);if(decoded.includes('\\')||decoded.includes('\0'))throw new Error('Invalid path');const p=path.resolve(base,'.'+decoded);if(!p.startsWith(base+path.sep)||!types[path.extname(p)]||decoded.split('/').some(x=>x.startsWith('.')))throw new Error('Not found');const b=await readFile(p);res.setHeader('content-type',types[path.extname(p)]||'application/octet-stream');res.end(b);}catch(e){res.statusCode=404;res.end(e.message)}}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});const errors=[];try{const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction('window.ready',{timeout:120000});
const initialRace=await page.evaluate(async()=>{
 const one=ctrl.setStyle('boot'),two=ctrl.setStyle('boot');await ctrl.setStyle('original');const completed=await Promise.all([one,two]);
 if(ctrl.getState().style!=='original'||completed.some(Boolean))throw new Error('Stale request overrode original selection');
 return {duplicateLoadCoalesced:true,originalWon:true,completed,state:ctrl.getState()};
});
assert.equal(requests['/assets/air3/footwear/boot.glb'],1,'concurrent requests share one GLB load');
const reports=[];for(const style of ['original','boot','shoes-test'])for(const view of ['front','side','full']){const r=await page.evaluate((s,v)=>go(s,v),style,view);reports.push({style,view,...r});const s=await page.evaluate(()=>output());await writeFile(path.join(output,style+'-'+view+'.png'),Buffer.from(s.split(',')[1],'base64'));}const switching=await page.evaluate(async()=>{
 let unknownRejected=false;const old=ctrl.getState().style;
 try{await ctrl.setStyle('missing-style')}catch(e){unknownRejected=e instanceof RangeError}
 if(!unknownRejected||ctrl.getState().style!==old)throw new Error('Invalid selection changed current footwear');
 await ctrl.setStyle('original');const [first,second]=await Promise.all([ctrl.setStyle('boot'),ctrl.setStyle('shoes-test')]);
 if(ctrl.getState().style!=='shoes-test')throw new Error('Last selection did not win');
 await ctrl.setStyle('original');const state=ctrl.getState(),diagnostics=ctrl.diagnostics();
 if(state.style!=='original'||state.loading)throw new Error('Original shoes not restored');
 return {unknownRejected,lastSelectionWins:true,originalRestored:true,state,diagnostics};
 });
 const disposedWhileLoading=await page.evaluate(async()=>{
 ctrl.dispose();const second=await createController({avatarRoot:model,rig,assetBase:'/slow-footwear/'});
 const loading=second.setStyle('boot');second.dispose();const applied=await loading;
 const groups=[];model.traverse(n=>{if(n.name==='AIR3 interchangeable footwear')groups.push(n.name)});
 if(applied||groups.length||model.userData.air3Footwear)throw new Error('Pending disposal retained an accessory');
 return {applied,accessoryGroupsAfterDispose:groups.length};
});
const assets={};for(const f of ['boot.glb','shoes-test.glb'])assets[f]=createHash('sha256').update(await readFile(path.join(project,'public/assets/air3/footwear',f))).digest('hex');
 const result={schema:'air3.footwear-visual-qa.v1',passed:errors.length===0,date:new Date().toISOString(),browser:await browser.version(),sourceHash:createHash('sha256').update(await readFile(path.join(project,'public/air3-footwear.mjs'))).digest('hex'),assets,errors,reports,initialRace,switching,disposedWhileLoading,limitations:['Source-module WebGL fitting check; final compiled app is covered separately','SwiftShader functional rendering is not a GPU performance benchmark','Open-toe item is a noncommercial demo; supplied toe fitting patch, no high-heel-specific mocap']};
 await writeFile(path.join(output,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,captures:reports.length,output,errors,initialRace,switching,disposedWhileLoading},null,2));assert.equal(errors.length,0);}finally{await browser.close();server.close();}
