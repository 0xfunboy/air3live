import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createFBXImporter } from './fbx-import.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2);
const arg=(name,fallback)=>args.includes(name)?path.resolve(args[args.indexOf(name)+1]):fallback;
const out=arg('--output',path.resolve(here,'..'));
const source=arg('--source',path.resolve(here,'../../../review/asset-import-2026-10-24/exported'));
const threePath=arg('--three',path.resolve(here,'../../AIR3_Studio_Flow/studio-broadcast/node_modules/three'));
const {FBXLoader,THREE}=await createFBXImporter(threePath);
const {GLTFLoader}=await import(pathToFileURL(path.join(threePath,'examples/jsm/loaders/GLTFLoader.js')).href);
const {AnimationMixer,LoopOnce,Vector3,Quaternion}=THREE;
const animationPath=path.join(out,'animations');
const B=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),-Math.PI/2),Bi=B.clone().invert();
const report={kind:'Independent world-space comparison after GLTFLoader deserialization',sourceInterpolation:'Three.js FBXLoader baked-sample linear interpolation; original FBX cubic tangents not reproduced',checks:[]};
for(const [filename,type] of [['body-clips.glb','body'],['face-spectrum-source.glb','face']]){
 const b=fs.readFileSync(path.join(animationPath,filename));
 const loaded=await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');
 if(!loaded.animations.length)throw new Error('No clips');
 const target=loaded.scene;const targetBones=new Map();target.traverse(o=>targetBones.set(o.name,o));
 for(const clip of loaded.animations){
  const fb=fs.readFileSync(path.join(source,'animations',clip.name+'.fbx'));
  const object=new FBXLoader().parse(fb.buffer.slice(fb.byteOffset,fb.byteOffset+fb.byteLength),'');
  const sourceClip=object.animations[0];const sourceBones=[];object.traverse(o=>{if(o.isBone)sourceBones.push(o)});
  const sm=new AnimationMixer(object),tm=new AnimationMixer(target);
  const sa=sm.clipAction(sourceClip).setLoop(LoopOnce,1);sa.clampWhenFinished=true;sa.play();
  const ta=tm.clipAction(clip).setLoop(LoopOnce,1);ta.clampWhenFinished=true;ta.play();
  let maxPos=0,maxAng=0,worstPos='',worstAng='';let comparisons=0;
  const times=Array.from({length:31},(_,i)=>i/30*(sourceClip.duration-1e-6));
  for(const time of times){
   sm.setTime(time);tm.setTime(time);object.updateMatrixWorld(true);target.updateMatrixWorld(true);
   for(const s of sourceBones){const t=targetBones.get(s.name);if(!t)throw new Error('Missing '+s.name);
    const sp=s.getWorldPosition(new Vector3()).multiplyScalar(.01),tp=t.getWorldPosition(new Vector3());
    const sq=s.getWorldQuaternion(new Quaternion()).multiply(Bi).normalize(),tq=t.getWorldQuaternion(new Quaternion()).normalize();
    const pe=sp.distanceTo(tp),qe=sq.angleTo(tq);
    if(pe>maxPos){maxPos=pe;worstPos=s.name}if(qe>maxAng){maxAng=qe;worstAng=s.name}comparisons++;
   }
  }
  sa.stop();ta.stop();sm.uncacheRoot(object);tm.uncacheRoot(target);
  // Local reductions can accumulate along the skeleton; allow <=0.5mm / 0.25deg globally.
  if(maxPos>.0005||maxAng>Math.PI/720)throw new Error(`Pose mismatch ${clip.name}: ${maxPos}m ${maxAng}rad`);
  const r={file:filename,name:clip.name,kind:type,loadedTracks:clip.tracks.length,duration:clip.duration,times:times.length,boneComparisons:comparisons,maxWorldPositionErrorMeters:maxPos,maxWorldAngleErrorRadians:maxAng,worstPositionBone:worstPos,worstRotationBone:worstAng,status:'PASS'};
  report.checks.push(r);console.log(JSON.stringify(r));
 }
}
report.status='PASS';fs.writeFileSync(path.join(out,'reports/animation-world-validation.json'),JSON.stringify(report,null,2)+'\n');
