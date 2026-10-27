import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {loadAvatarFixture} from './fixtures/avatar-fixture.mjs';
import {Air3AvatarRig} from '../public/air3-avatar.mjs';
import {createClothingController} from '../public/air3-clothing.mjs';
import {createFootwearController, BOOT_FITS} from '../public/air3-footwear.mjs';
import {setBodyDrawMask,releaseBodyDrawMask} from '../public/air3-garment-mask.mjs';
async function assetFixture(name){
 const original=await readFile(new URL('../public/assets/air3/'+name,import.meta.url));const length=original.readUInt32LE(12),data=JSON.parse(original.subarray(20,20+length));
 data.materials=data.materials.map(m=>({name:m.name,pbrMetallicRoughness:{metallicFactor:0,roughnessFactor:.8}}));delete data.images;delete data.textures;delete data.extensionsRequired;delete data.extensionsUsed;
 const bytes=Buffer.from(JSON.stringify(data)),json=Buffer.concat([bytes,Buffer.alloc((-bytes.length)&3,32)]),binary=original.subarray(20+length),header=Buffer.alloc(20);header.writeUInt32LE(0x46546c67);header.writeUInt32LE(2,4);header.writeUInt32LE(20+json.length+binary.length,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16);
 const glb=Buffer.concat([header,json,binary]);return new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset,glb.byteOffset+glb.byteLength),'');
}
const loader={loadAsync:url=>assetFixture(url.replace('/assets/air3/',''))};

test('body draw masks compose across top and footwear and restore the exact source geometry',()=>{
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,1,0,0,0,0,1, 0,1,0,1,1,0,0,1,1, 0,2,0,1,2,0,0,2,1],3));geometry.setIndex([0,1,2,3,4,5,6,7,8]);const mesh=new THREE.Mesh(geometry);
 setBodyDrawMask(mesh,'footwear','on',(p,a)=>p.getY(a)>0);assert.deepEqual([...mesh.geometry.index.array],[3,4,5,6,7,8]);
 setBodyDrawMask(mesh,'top','on',(p,a)=>p.getY(a)!==1);assert.deepEqual([...mesh.geometry.index.array],[6,7,8]);
 releaseBodyDrawMask(mesh,'footwear');assert.deepEqual([...mesh.geometry.index.array],[0,1,2,6,7,8]);
 releaseBodyDrawMask(mesh,'top');assert.equal(mesh.geometry,geometry);assert.equal(geometry.index.count,9);
});

test('supplied crop top binds after animation, stays finite and restores clothing independently of the boots',async()=>{
 const gltf=await loadAvatarFixture(),rig=new Air3AvatarRig(gltf);rig.setTime(.7);const holder=new THREE.Group();holder.scale.setScalar(1.17);holder.position.set(2,0,-1);holder.add(gltf.scene);holder.updateMatrixWorld(true);
 const body=gltf.scene.getObjectByName('body__root_mesh'),originalGeometry=body.geometry,originalPosition=body.geometry.attributes.position.array.slice();
 const shoes=await createFootwearController({avatarRoot:gltf.scene,rig,loader});const top=await createClothingController({avatarRoot:gltf.scene,rig,loader});
 await shoes.setStyle('boot',{fit:'relaxed'});const shoeIndexCount=body.geometry.index.count;await top.setStyle('crop');const combinedIndexCount=body.geometry.index.count;assert.ok(combinedIndexCount<shoeIndexCount);
 const mesh=gltf.scene.getObjectByName('AIR3_crop_top'),p=new THREE.Vector3();assert.ok(mesh.isSkinnedMesh);assert.equal(mesh.geometry.index.count/3,12052);
 for(let i=0;i<mesh.geometry.attributes.position.count;i++){mesh.getVertexPosition(i,p);assert.ok(p.toArray().every(Number.isFinite));const w=mesh.geometry.attributes.skinWeight;assert.ok(Math.abs(w.getX(i)+w.getY(i)+w.getZ(i)+w.getW(i)-1)<1e-6);}
 await shoes.setStyle('original');assert.ok(body.geometry.index.count>combinedIndexCount);assert.ok(body.geometry.index.count<originalGeometry.index.count);
 await top.setStyle('original');assert.equal(body.geometry,originalGeometry);assert.deepEqual(body.geometry.attributes.position.array,originalPosition);
 await top.setStyle('crop');await shoes.setStyle('boot',{fit:'low-cut'});assert.equal(shoes.getState().fit,'low-cut');assert.ok(shoes.diagnostics().triangles<40746);
 top.dispose();assert.equal(shoes.getState().style,'boot');assert.equal(body.geometry.index.count,shoeIndexCount);shoes.dispose();assert.equal(body.geometry,originalGeometry);rig.dispose();
});

test('top selection handles superseded and failed loads and closes pending assets without retaining the garment',async()=>{
 const gltf=await loadAvatarFixture(),rig=new Air3AvatarRig(gltf);let resolveLoad;const slow={loadAsync:()=>new Promise(done=>{resolveLoad=done})};const top=await createClothingController({avatarRoot:gltf.scene,rig,loader:slow});
 const first=top.setStyle('crop');await top.setStyle('original');resolveLoad(await assetFixture('clothing/crop-top.glb'));assert.equal(await first,false);assert.equal(top.getState().style,'original');
 await top.setStyle('crop');top.dispose();assert.equal(gltf.scene.getObjectByName('AIR3_crop_top'),undefined);
 const broken=await createClothingController({avatarRoot:gltf.scene,rig,loader:{loadAsync:async()=>{throw new Error('test load failure')}}});await assert.rejects(broken.setStyle('crop'),/test load failure/);assert.equal(broken.getState().style,'original');broken.dispose();
 const pending=await createClothingController({avatarRoot:gltf.scene,rig,loader:slow});const request=pending.setStyle('crop');pending.dispose();resolveLoad(await assetFixture('clothing/crop-top.glb'));assert.equal(await request,false);assert.equal(gltf.scene.getObjectByName('AIR3 interchangeable top'),undefined);rig.dispose();
});

test('boot fits reject unknown modes before altering the selection',async()=>{
 const gltf=await loadAvatarFixture(),rig=new Air3AvatarRig(gltf);const shoes=await createFootwearController({avatarRoot:gltf.scene,rig,loader});
 assert.equal(BOOT_FITS.length,2);await shoes.setStyle('boot',{fit:'relaxed'});await assert.rejects(shoes.setFit('missing'),RangeError);assert.equal(shoes.getState().fit,'relaxed');assert.equal(shoes.getState().style,'boot');shoes.dispose();rig.dispose();
});
