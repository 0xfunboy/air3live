import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {load,THREE} from './avatar-qa-loader.mjs';
import {Air3AvatarRig} from '../public/air3-avatar.mjs';
const base=fileURLToPath(new URL('../../', import.meta.url));
const original=await load(base+'source-assets/AIR3-runtime.before-quality.glb');const corrected=await load(base+'studio-broadcast/public/assets/air3/models/AIR3-runtime.glb');
const a=new Air3AvatarRig(original,{groundFeet:false}),b=new Air3AvatarRig(corrected,{groundFeet:true});
const p=new THREE.Vector3(),q=new THREE.Vector3();
function measure(g,r){const bone=n=>r.bodyBones.get(n).getWorldPosition(new THREE.Vector3());let bodyWidth=0,shoeMinY=Infinity,allMinY=Infinity,allMaxY=-Infinity;
 const face=g.scene.getObjectByName('face__AI_MetaHumanIdentity_FaceMesh');const shoes=g.scene.getObjectByName('outfit__ScothSkirtWhitheShirtNewBalance');const shoePos=shoes.geometry.attributes.position;
 let heel=-1,toe=-1,minZ=Infinity,maxZ=-Infinity;
 for(let i=0;i<shoePos.count;i++){if(shoePos.getX(i)<0)continue;if(shoePos.getZ(i)<minZ){minZ=shoePos.getZ(i);heel=i;}if(shoePos.getZ(i)>maxZ){maxZ=shoePos.getZ(i);toe=i;}}
 shoes.getVertexPosition(toe,p).applyMatrix4(shoes.matrixWorld);shoes.getVertexPosition(heel,q).applyMatrix4(shoes.matrixWorld);const toeHeel=p.distanceTo(q);
 for(let i=0;i<shoePos.count;i++){shoes.getVertexPosition(i,p).applyMatrix4(shoes.matrixWorld);shoeMinY=Math.min(shoeMinY,p.y);}
 g.scene.traverse(o=>{if(!o.isMesh)return;const pos=o.geometry.attributes.position;for(let i=0;i<pos.count;i+=4){o.getVertexPosition(i,p).applyMatrix4(o.matrixWorld);allMinY=Math.min(allMinY,p.y);allMaxY=Math.max(allMaxY,p.y);}});
 return {shoulderJointSpanMeters:bone('upperarm_l').distanceTo(bone('upperarm_r')),headPivotHeightMeters:bone('head').y,leftShoeToeHeelDistanceMeters:toeHeel,shoeLowestY:shoeMinY,approximateHeightMeters:allMaxY-allMinY};}
const rows=[];
for(const c of corrected.animations){a.setClip(c.name);b.setClip(c.name);const samples=[];for(const fraction of [0,.25,.5,.75,.999]){let t=c.duration*fraction;a.setTime(t);b.setTime(t);samples.push({timeSeconds:t,before:measure(original,a),after:measure(corrected,b)});}rows.push({clip:c.name,samples});}
const result={scope:'Numerical measurements of actual skinned geometry and body joint world transforms; original supplied animation versus corrected destination translations. Source geometry and bone weights unchanged.',groundTargetY:b.groundY,clips:rows};
fs.writeFileSync(base+'docs/validation/avatar-proportion-measurements.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(rows.map(r=>({clip:r.clip,before:r.samples[0].before,after:r.samples[0].after})),null,2));
