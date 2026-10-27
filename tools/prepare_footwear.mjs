/** Reproducible footwear conversion. Input assets stay untouched.
 * Needs meshoptimizer@0.24.0, installed separately from production dependencies:
 * npm install --prefix tools/converter-deps --no-save --no-package-lock --ignore-scripts meshoptimizer@0.24.0
 * Run: node tools/prepare_footwear.mjs [INPUT_DIRECTORY] [--output DIRECTORY]
 * --meshopt FILE (or AIR3_MESHOPT_MODULE) accepts a module path or file URL.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from '../studio-broadcast/node_modules/three/build/three.module.js';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let inputOption, outputOption, moduleOption = process.env.AIR3_MESHOPT_MODULE;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
 if (args[i] === '--help' || args[i] === '-h') {
  console.log('Usage: node tools/prepare_footwear.mjs [INPUT_DIRECTORY] [--output DIRECTORY] [--meshopt MODULE_FILE]');
  console.log('Defaults are relative to the project, independently of the current working directory.');
  process.exit(0);
 }
 if (args[i] === '--output' || args[i] === '--meshopt') {
  const option = args[i], value = args[++i];
  if (!value || value.startsWith('--')) throw new Error('Missing value for ' + option);
  if (option === '--output') outputOption = value; else moduleOption = value;
 } else if (args[i].startsWith('-') || inputOption) throw new Error('Unexpected argument: ' + args[i]);
 else inputOption = args[i];
}
const input = path.resolve(inputOption || path.join(project, 'source-assets/footwear'));
const out = path.resolve(outputOption || path.join(project, 'studio-broadcast/public/assets/air3/footwear'));
let moduleUrl;
if (moduleOption) {
 // A Windows C:\... path is not an ESM URL. Convert every native path with
 // pathToFileURL rather than handing a drive letter directly to import().
 moduleUrl = moduleOption.startsWith('file:') ? moduleOption : pathToFileURL(path.resolve(moduleOption)).href;
} else {
 for (const base of ['tools/converter-deps', 'studio-broadcast', 'tools']) {
  try { moduleUrl = pathToFileURL(createRequire(path.join(project, base, 'package.json')).resolve('meshoptimizer')).href; break; } catch {}
 }
 if (!moduleUrl) throw new Error('Missing conversion dependency. Run: npm install --prefix tools/converter-deps --no-save --no-package-lock --ignore-scripts meshoptimizer@0.24.0');
}
const imported = await import(moduleUrl);
const MeshoptSimplifier = imported.MeshoptSimplifier || imported.default?.MeshoptSimplifier;
if (!MeshoptSimplifier) throw new Error('The supplied module does not export MeshoptSimplifier');
await MeshoptSimplifier.ready;
await mkdir(out, { recursive: true });
function readGLB(bytes) {
 const n=bytes.readUInt32LE(12), json=JSON.parse(bytes.subarray(20,20+n));
 const bin=bytes.subarray(28+n);
 const sizes={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16};
 const types={5121:Uint8Array,5123:Uint16Array,5125:Uint32Array,5126:Float32Array};
 function a(i) {const s=json.accessors[i],v=json.bufferViews[s.bufferView],T=types[s.componentType],k=sizes[s.type],r=new T(s.count*k),dv=new DataView(bin.buffer,bin.byteOffset,bin.byteLength),off=(v.byteOffset||0)+(s.byteOffset||0),stride=v.byteStride||k*T.BYTES_PER_ELEMENT;
  const read={5121:'getUint8',5123:'getUint16',5125:'getUint32',5126:'getFloat32'}[s.componentType];
  for(let n=0;n<s.count;n++)for(let j=0;j<k;j++)r[n*k+j]=dv[read](off+n*stride+j*T.BYTES_PER_ELEMENT,true);return r; }
 return {json,bin,a};
}
function writeGLB(json, buffers) {
 const bufferViews=[];let len=0;const chunks=[];
 for(const v of buffers){const data=Buffer.from(v.buffer||v,v.byteOffset||0,v.byteLength??v.length);bufferViews.push({buffer:0,byteOffset:len,byteLength:data.length});chunks.push(data);const pad=(4-data.length%4)%4;if(pad)chunks.push(Buffer.alloc(pad));len+=data.length+pad;}
 json.bufferViews=bufferViews;json.buffers=[{byteLength:len}];let j=Buffer.from(JSON.stringify(json));const pad=(4-j.length%4)%4;if(pad)j=Buffer.concat([j,Buffer.alloc(pad,32)]);const header=Buffer.alloc(20);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(28+j.length+len,8);header.writeUInt32LE(j.length,12);header.writeUInt32LE(0x4e4f534a,16);const bh=Buffer.alloc(8);bh.writeUInt32LE(len,0);bh.writeUInt32LE(0x004e4942,4);return Buffer.concat([header,j,bh,...chunks]);
}
function nodeWorld(json,index){const p=json.nodes.findIndex(n=>(n.children||[]).includes(index)),n=json.nodes[index];const m=n.matrix?new THREE.Matrix4().fromArray(n.matrix):new THREE.Matrix4().compose(new THREE.Vector3().fromArray(n.translation||[0,0,0]),new THREE.Quaternion().fromArray(n.rotation||[0,0,0,1]),new THREE.Vector3().fromArray(n.scale||[1,1,1]));return p<0?m:nodeWorld(json,p).multiply(m);}
const report={schema:'air3.footwear-assets.v1',generatedAt:new Date().toISOString(),converter:'meshoptimizer 0.24.0; attribute-aware simplification; no anatomy edits',assets:[]};
for(const config of [
 {source:'boot.glb',id:'boot',meshes:[0,1,2,3],ratio:.055,target:20000,kind:'closed-boot'},
 {source:'shoes_test.glb',id:'shoes-test',meshes:[0,1,4],ratio:.12,target:16000,kind:'open-toe-demo'}
]){
 const bytes=await readFile(path.join(input,config.source));const src=readGLB(bytes);let positions=[];
 let transform;
 if(config.id==='boot') {
  // Surveyed sole toe/heel landmarks. Rotate the scanned boot, not the avatar.
  const z=new THREE.Vector3(-67,-13,-163).normalize(), up=new THREE.Vector3(0,-1,0),x=new THREE.Vector3().crossVectors(up,z).normalize(),y=new THREE.Vector3().crossVectors(z,x).normalize();
  transform=new THREE.Matrix4().set(x.x,x.y,x.z,0,y.x,y.y,y.z,0,z.x,z.y,z.z,0,0,0,0,1);
 }
 for(const mi of config.meshes){const primitive=src.json.meshes[mi].primitives[0],attrs={};for(const [k,a]of Object.entries(primitive.attributes))attrs[k]=src.a(a);const indices=Uint32Array.from(src.a(primitive.indices));const ni=src.json.nodes.findIndex(n=>n.mesh===mi);const mat=transform||nodeWorld(src.json,ni);const nmat=new THREE.Matrix3().getNormalMatrix(mat);const p=new THREE.Vector3();for(let i=0;i<attrs.POSITION.length;i+=3){p.fromArray(attrs.POSITION,i).applyMatrix4(mat).toArray(attrs.POSITION,i);if(attrs.NORMAL)p.fromArray(attrs.NORMAL,i).applyNormalMatrix(nmat).toArray(attrs.NORMAL,i);}positions.push({mi,attrs,indices,proxy:config.id==='shoes-test'&&mi===0});}
 if(config.id==='boot') {
  // Sketchfab split a single scanned surface at 16-bit limits. Reunite exact
  // position/UV/normal duplicates before reducing; UV seams remain separate.
  const seen=new Map(),values={},indices=[];const names=Object.keys(positions[0].attrs);for(const name of names)values[name]=[];
  for(const mesh of positions){const remap=new Uint32Array(mesh.attrs.POSITION.length/3);for(let i=0;i<remap.length;i++){
   const key=names.map(name=>{const a=mesh.attrs[name],n=a.length/remap.length;return Array.from(a.subarray(i*n,i*n+n)).map(v=>v.toFixed(name==='NORMAL'?5:7)).join(',');}).join(';');
   let j=seen.get(key);if(j===undefined){j=seen.size;seen.set(key,j);for(const name of names){const a=mesh.attrs[name],n=a.length/remap.length;values[name].push(...a.subarray(i*n,i*n+n));}}remap[i]=j;
  }for(const i of mesh.indices)indices.push(remap[i]);}
  positions=[{mi:0,attrs:Object.fromEntries(names.map(name=>[name,new Float32Array(values[name])])),indices:new Uint32Array(indices),proxy:false}];
 }
 const box=new THREE.Box3();for(const m of positions)for(let i=0;i<m.attrs.POSITION.length;i+=3)box.expandByPoint(new THREE.Vector3().fromArray(m.attrs.POSITION,i));const size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
 // Canonical metres, toes +Z, sole at Y=0. Every footwear retains one shared
 // coordinate system; the runtime fits it to the existing rest foot landmarks.
 const scale=.25/size.z;
 for(const m of positions){const p=m.attrs.POSITION;for(let i=0;i<p.length;i+=3){p[i]=(p[i]-center.x)*scale;p[i+1]=(p[i+1]-box.min.y)*scale;p[i+2]=(p[i+2]-box.min.z)*scale;}}
 const json={asset:{version:'2.0',generator:'AIR3 footwear converter / meshoptimizer 0.24.0',extras:src.json.asset.extras},scene:0,scenes:[{nodes:[]}],nodes:[],meshes:[],accessors:[],materials:[],extras:{air3Footwear:{id:config.id,kind:config.kind,lengthMeters:.25,sourceFile:config.source,canonical:'metres, +Y up, +Z toe, sole Y=0'}}};const buffers=[];
 const append=(arr,type)=>{const view=buffers.push(arr)-1,acc={bufferView:view,componentType:arr instanceof Float32Array?5126:arr instanceof Uint32Array?5125:5123,count:arr.length/({SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[type]),type};if(type==='VEC3'){acc.min=[Infinity,Infinity,Infinity];acc.max=[-Infinity,-Infinity,-Infinity];for(let i=0;i<arr.length;i++){acc.min[i%3]=Math.min(acc.min[i%3],arr[i]);acc.max[i%3]=Math.max(acc.max[i%3],arr[i]);}}return json.accessors.push(acc)-1;};
 if(config.id==='boot'){
  const original=src.json.materials[0].extensions.KHR_materials_pbrSpecularGlossiness,textureIndex=original.diffuseTexture.index,image=src.json.images[src.json.textures[textureIndex].source],view=src.json.bufferViews[image.bufferView];const data=src.bin.subarray(view.byteOffset||0,(view.byteOffset||0)+view.byteLength);const imageView=buffers.push(data)-1;json.images=[{bufferView:imageView,mimeType:image.mimeType}];json.textures=[{source:0}];json.materials=[{name:'Aquateknica / original scanned leather',pbrMetallicRoughness:{baseColorTexture:{index:0},baseColorFactor:[1,1,1,1],metallicFactor:0,roughnessFactor:.74},doubleSided:true}];
 }else json.materials=[{name:'Shoes test / black leather',pbrMetallicRoughness:{baseColorFactor:[.032,.025,.026,1],metallicFactor:0,roughnessFactor:.52},doubleSided:true},{name:'Shoes test / ankle ties',pbrMetallicRoughness:{baseColorFactor:[.027,.023,.022,1],metallicFactor:0,roughnessFactor:.6},doubleSided:true},{name:'Shoes test / supplied fitting foot',pbrMetallicRoughness:{baseColorFactor:[.66,.46,.37,1],metallicFactor:0,roughnessFactor:.73},doubleSided:true}];
 let trianglesBefore=0,trianglesAfter=0;const rows=[];
 for(const m of positions){const normals=m.attrs.NORMAL||new Float32Array(m.attrs.POSITION.length),uv=m.attrs.TEXCOORD_0;const attr=new Float32Array(m.attrs.POSITION.length/3*(uv?5:3));for(let i=0;i<m.attrs.POSITION.length/3;i++){attr.set(normals.subarray(i*3,i*3+3),i*(uv?5:3));if(uv)attr.set(uv.subarray(i*2,i*2+2),i*5+3);}
  const target=Math.max(240,Math.round(m.indices.length*config.ratio/3)*3);const [idx,error]=MeshoptSimplifier.simplifyWithAttributes(m.indices,m.attrs.POSITION,3,attr,uv?5:3,uv?[.05,.05,.05,.8,.8]:[.05,.05,.05],null,target,.009,['LockBorder']);
  const oldCount=m.attrs.POSITION.length/3;const map=new Map();const used=[];for(let i=0;i<idx.length;i++){const orig=idx[i];if(!map.has(orig)){map.set(orig,map.size);used.push(orig);}idx[i]=map.get(orig);}const attributes={};
  for(const [k,a]of Object.entries(m.attrs)){if(!['POSITION','NORMAL','TEXCOORD_0','COLOR_0'].includes(k))continue;const count=a.length/oldCount,arr=new Float32Array(used.length*count);for(let n=0;n<used.length;n++)for(let j=0;j<count;j++)arr[n*count+j]=a[used[n]*count+j];attributes[k]=append(arr,'VEC'+count);}
  const material=config.id==='boot'?0:m.mi===4?0:m.mi===1?1:2;const index=append(idx,'SCALAR');const meshIndex=json.meshes.push({name:m.proxy?'AIR3 supplied fitting foot':'AIR3 '+config.id,primitives:[{attributes,indices:index,material}]})-1;const nodeIndex=json.nodes.push({name:m.proxy?'footwear-proxy-foot':'footwear-'+config.id+'-'+m.mi,mesh:meshIndex,extras:{air3FittingProxy:m.proxy}})-1;json.scenes[0].nodes.push(nodeIndex);trianglesBefore+=m.indices.length/3;trianglesAfter+=idx.length/3;rows.push({sourceMesh:m.mi,before:m.indices.length/3,after:idx.length/3,error,proxy:m.proxy});
 }
 const output=writeGLB(json,buffers);await writeFile(path.join(out,config.id+'.glb'),output);report.assets.push({id:config.id,source:config.source,sourceBytes:bytes.length,optimizedBytes:output.length,trianglesBefore,trianglesAfter,sourceBounds:box.toArray?.()||{min:box.min.toArray(),max:box.max.toArray()},canonicalSize:[size.x*scale,size.y*scale,.25],meshes:rows,license:src.json.asset.extras});
}
await writeFile(path.join(out,'assets-manifest.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
