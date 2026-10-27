import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),args=process.argv.slice(2);
const arg=(name,fallback)=>args.includes(name)?path.resolve(args[args.indexOf(name)+1]):fallback;
const outputRoot=arg('--output',path.resolve(here,'..'));
const threePath=arg('--three',path.resolve(here,'../../AIR3_Studio_Flow/studio-broadcast/node_modules/three'));
const {GLTFLoader}=await import(pathToFileURL(path.join(threePath,'examples/jsm/loaders/GLTFLoader.js')).href);
const {AnimationMixer,LoopOnce,Quaternion,Vector3}=await import(pathToFileURL(path.join(threePath,'build/three.module.js')).href);
const b=fs.readFileSync(path.join(outputRoot,'animations/body-clips.glb'));
const gltf=await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');
const names=['root','pelvis','head','thigh_l','calf_l','foot_l','thigh_r','calf_r','foot_r'];
const out={units:{translation:'meters',rotation:'degrees'},clips:[]};
for(const clip of gltf.animations){
 const scene=gltf.scene.clone(true);scene.updateMatrixWorld(true);
 const bones=new Map();scene.traverse(n=>bones.set(n.name,n));
 const rest=new Map(names.map(n=>[n,{p:bones.get(n).getWorldPosition(new Vector3()),q:bones.get(n).quaternion.clone()}]));
 const stats=Object.fromEntries(names.map(n=>[n,{worldMin:[Infinity,Infinity,Infinity],worldMax:[-Infinity,-Infinity,-Infinity],maxLocalRotationFromRestDegrees:0,maxWorldPositionFromRestMeters:0}]));
 const m=new AnimationMixer(scene),action=m.clipAction(clip).setLoop(LoopOnce,1);action.clampWhenFinished=true;action.play();
 let thighAngleMin=Infinity,thighAngleMax=-Infinity,maxScaleDeviation=0,scaleBone='';
 let firstPose,lastPose; let rootYawMin=Infinity,rootYawMax=-Infinity;
 const samples=Math.ceil(clip.duration*30)+1;
 for(let i=0;i<samples;i++){
  const t=Math.min(i/30,clip.duration-1e-6);m.setTime(t);scene.updateMatrixWorld(true);
  const rootForward=new Vector3(0,0,1).applyQuaternion(bones.get('root').quaternion);const yaw=Math.atan2(rootForward.x,rootForward.z)*180/Math.PI;rootYawMin=Math.min(rootYawMin,yaw);rootYawMax=Math.max(rootYawMax,yaw);
  if(i===0||i===samples-1){const pose=new Map(names.map(n=>[n,{p:bones.get(n).getWorldPosition(new Vector3()),q:bones.get(n).getWorldQuaternion(new Quaternion())}]));if(i===0)firstPose=pose;else lastPose=pose;}
  for(const name of names){const o=bones.get(name),r=rest.get(name),p=o.getWorldPosition(new Vector3()),s=stats[name];
   p.toArray().forEach((v,j)=>{s.worldMin[j]=Math.min(s.worldMin[j],v);s.worldMax[j]=Math.max(s.worldMax[j],v)});
   s.maxLocalRotationFromRestDegrees=Math.max(s.maxLocalRotationFromRestDegrees,o.quaternion.angleTo(r.q)*180/Math.PI);
   s.maxWorldPositionFromRestMeters=Math.max(s.maxWorldPositionFromRestMeters,p.distanceTo(r.p));
  }
  for(const side of ['l','r']){const hip=bones.get('thigh_'+side).getWorldPosition(new Vector3()),knee=bones.get('calf_'+side).getWorldPosition(new Vector3());const angle=knee.sub(hip).normalize().angleTo(new Vector3(0,-1,0))*180/Math.PI;thighAngleMin=Math.min(thighAngleMin,angle);thighAngleMax=Math.max(thighAngleMax,angle)}
  scene.traverse(n=>{if(!n.name)return;const deviation=Math.max(...n.scale.toArray().map(v=>Math.abs(v-1)));if(deviation>maxScaleDeviation){maxScaleDeviation=deviation;scaleBone=n.name}});
 }
 const loopSeam=Object.fromEntries(names.map(n=>[n,{positionJumpMeters:firstPose.get(n).p.distanceTo(lastPose.get(n).p),rotationJumpDegrees:firstPose.get(n).q.angleTo(lastPose.get(n).q)*180/Math.PI}]));
 const row={rootYawDegrees:{min:rootYawMin,max:rootYawMax},loopSeam,name:clip.name,durationSeconds:clip.duration,samples,bones:stats,thighAngleFromDownDegrees:{min:thighAngleMin,max:thighAngleMax},maxScaleDeviationFromOne:maxScaleDeviation,scaleBone,classification:stats.pelvis.worldMin[1]>.7&&thighAngleMax<45?'standing-not-seated':'inspect-pose-before-seated-use'};
 out.clips.push(row);console.log(JSON.stringify({name:row.name,pelvisY:stats.pelvis.worldMin[1]+'..'+stats.pelvis.worldMax[1],rootOffset:stats.root.maxWorldPositionFromRestMeters,rootRotation:stats.root.maxLocalRotationFromRestDegrees,pelvisRotation:stats.pelvis.maxLocalRotationFromRestDegrees,thighAngleMax,scale:maxScaleDeviation,scaleBone,classification:row.classification,pelvisOffset:stats.pelvis.maxWorldPositionFromRestMeters,rootYaw:row.rootYawDegrees,seamPelvis:row.loopSeam.pelvis,seamRoot:row.loopSeam.root}));
 action.stop();m.uncacheRoot(scene);
}
fs.writeFileSync(path.join(outputRoot,'reports/animation-motion-bounds.json'),JSON.stringify(out,null,2)+'\n');
