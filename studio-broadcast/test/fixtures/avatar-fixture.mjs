import { readFile } from 'node:fs/promises';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Node cannot decode browser image URLs. Geometry, morphs, animation and
// skeleton buffers remain byte-for-byte the delivered asset.
export async function loadAvatarFixture() {
  const original = await readFile(new URL('../../public/assets/air3/models/AIR3-runtime.glb', import.meta.url));
  const length = original.readUInt32LE(12), data = JSON.parse(original.subarray(20, 20 + length));
  data.materials = data.materials.map(material => ({ name: material.name,
    pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: .7 } }));
  delete data.images; delete data.textures; delete data.extensionsRequired; delete data.extensionsUsed;
  const json = Buffer.from(JSON.stringify(data)), padded = Buffer.concat([json, Buffer.alloc((-json.length) & 3, 32)]);
  const binary = original.subarray(20 + length), header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + padded.length + binary.length, 8);
  header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const bytes = Buffer.concat([header, padded, binary]);
  return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
}
