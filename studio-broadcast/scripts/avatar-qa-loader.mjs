import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
export { THREE };
export async function load(file) {
 const bytes=fs.readFileSync(file), jl=bytes.readUInt32LE(12),j=JSON.parse(bytes.subarray(20,20+jl).toString());
 j.materials=(j.materials??[]).map(m=>({name:m.name,pbrMetallicRoughness:{baseColorFactor:[1,1,1,1],roughnessFactor:.7,metallicFactor:0}}));
 delete j.images;delete j.textures;delete j.extensionsUsed;delete j.extensionsRequired;
 const jb=Buffer.from(JSON.stringify(j)),jp=Buffer.concat([jb,Buffer.alloc((-jb.length)&3,32)]),bin=bytes.subarray(20+jl),h=Buffer.alloc(20);
 h.writeUInt32LE(0x46546c67);h.writeUInt32LE(2,4);h.writeUInt32LE(20+jp.length+bin.length,8);h.writeUInt32LE(jp.length,12);h.writeUInt32LE(0x4e4f534a,16);
 const glb=Buffer.concat([h,jp,bin]);return await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset,glb.byteOffset+glb.byteLength),'');
}
