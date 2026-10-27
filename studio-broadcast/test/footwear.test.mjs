import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {FOOTWEAR_STYLES} from '../public/air3-footwear.mjs';
const folder=new URL('../public/assets/air3/footwear/',import.meta.url);
function glb(bytes){assert.equal(bytes.readUInt32LE(0),0x46546c67);assert.equal(bytes.readUInt32LE(4),2);assert.equal(bytes.readUInt32LE(8),bytes.length);const length=bytes.readUInt32LE(12);const json=JSON.parse(bytes.subarray(20,20+length)),bin=bytes.subarray(length+28);return {json,bin};}

test('footwear GLBs retain attributed sources, compatible PBR, finite compact geometry and valid indices',async()=>{
 for(const id of ['boot','shoes-test']){
  const bytes=await readFile(new URL(id+'.glb',folder)),{json,bin}=glb(bytes);
  assert.match(json.asset.extras.source,/^https:\/\/sketchfab\.com\/3d-models\//);
  assert.ok(!json.extensionsRequired?.includes('KHR_materials_pbrSpecularGlossiness'));
  let triangles=0;
  for(const mesh of json.meshes)for(const p of mesh.primitives){
   const pos=json.accessors[p.attributes.POSITION],ix=json.accessors[p.indices];triangles+=ix.count/3;
   const pv=json.bufferViews[pos.bufferView],iv=json.bufferViews[ix.bufferView];const v=new DataView(bin.buffer,bin.byteOffset,bin.byteLength);
   assert.ok(pos.min[1]>=-1e-6);assert.ok(pos.max[2]<=.251);assert.ok(pos.max[0]-pos.min[0]<.16);
   for(let n=0;n<pos.count*3;n++)assert.ok(Number.isFinite(v.getFloat32(pv.byteOffset+n*4,true)));
   for(let n=0;n<ix.count;n++)assert.ok(v.getUint32(iv.byteOffset+n*4,true)<pos.count);
  }
  assert.ok(triangles<26000,'one foot stays under 26k triangles');assert.ok(bytes.length<3500000);
  if(id==='boot'){assert.match(json.asset.extras.license,/CC-BY-4.0/);assert.equal(json.images.length,1);assert.ok(json.materials[0].pbrMetallicRoughness.baseColorTexture);}
  else {assert.match(json.asset.extras.license,/CC-BY-NC-4.0/);assert.equal(FOOTWEAR_STYLES.find(s=>s.id===id).commercialUse,false);assert.match(FOOTWEAR_STYLES.find(s=>s.id===id).label,/non commerciale/);}
 }
});

test('uploaded footwear originals are preserved byte-for-byte',async()=>{
 for(const [name,expected]of [['boot.glb','9b984c04554fd014d02ead42c38393d6aa730731084a2b0030355f3d5374c4a7'],['shoes_test.glb','af9237cebfd7019c8a921cf3c619ffb9f489d53a8ca197376cc19792431f4a1a']]){
  const bytes=await readFile(new URL('../../source-assets/footwear/'+name,import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),expected);
 }
});
