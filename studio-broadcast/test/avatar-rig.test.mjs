import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Air3AvatarRig, prepareExtendedSkinning, patchSkinMaterial } from '../public/air3-avatar.mjs';
import { MOUTH_POSES } from '../public/air3-face.mjs';

async function fixture() {
  const original = await fs.readFile(new URL('../public/assets/air3/models/AIR3-runtime.glb', import.meta.url));
  const length = original.readUInt32LE(12), document = JSON.parse(original.subarray(20, 20 + length));
  // Node has no HTML image decoder. This in-memory material-only substitution
  // retains actual geometry, morphs, skeletons, weights and animation buffers.
  const data = structuredClone(document);
  data.materials = data.materials.map(m => ({ name: m.name, pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: .7 } }));
  delete data.images; delete data.textures; delete data.extensionsRequired; delete data.extensionsUsed;
  const json = Buffer.from(JSON.stringify(data)), padded = Buffer.concat([json, Buffer.alloc((-json.length) & 3, 32)]);
  const bin = original.subarray(20 + length), header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + padded.length + bin.length, 8);
  header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const bytes = Buffer.concat([header, padded, bin]);
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  return { gltf, document };
}

test('actual avatar: retargeting, complete skinning and bounded facial controls', { timeout: 120_000 }, async (t) => {
  const { gltf, document } = await fixture(), rig = new Air3AvatarRig(gltf);
  await t.test('all seven delivered clips carry destination translation retarget metadata', () => {
    assert.equal(gltf.animations.length, 7);
    for (const clip of document.animations) assert.equal(clip.extras.air3TranslationRetargeted, true, clip.name);
    assert.equal(document.extras.air3TranslationRetarget.geometryChanged, false);
    assert.equal(document.extras.air3TranslationRetarget.weightsChanged, false);
  });
  await t.test('animation never restores the wider foreign shoulder and longer foot segments', () => {
    const names = ['upperarm_l', 'upperarm_r', 'spine_05', 'foot_l', 'foot_r', 'ball_l', 'ball_r'];
    const expected = Object.fromEntries(names.map(name => [name, new THREE.Vector3(...document.nodes.find(n => n.name === 'body__' + name).translation)]));
    let samples = 0;
    for (const clip of gltf.animations) {
      rig.setClip(clip.name);
      for (const fraction of [0, .25, .5, .75, .999]) {
        rig.setTime(clip.duration * fraction);
        for (const name of names) assert(rig.bodyBones.get(name).position.distanceTo(expected[name]) < .00015, `${clip.name}: ${name}`);
        samples++;
      }
    }
    assert.equal(samples, 35);
  });
  await t.test('twelve-weight restoration remains normalized and idempotent', () => {
    const meshes = []; gltf.scene.traverse(o => { if (o.isSkinnedMesh) meshes.push(o); });
    for (const mesh of meshes) {
      const a = mesh.geometry.attributes;
      for (let i = 0; i < a.skinWeight.count; i += 7) {
        let sum = 0; for (const name of ['skinWeight', 'weights_1', 'weights_2']) for (let c = 0; c < 4; c++) sum += a[name]?.getComponent(i, c) ?? 0;
        assert(Math.abs(sum - 1) < 1e-6, mesh.name);
      }
    }
    const before = meshes.map(o => ({ material: o.material, weights: o.geometry.attributes.skinWeight.array.slice() }));
    prepareExtendedSkinning(gltf.scene);
    for (let i = 0; i < meshes.length; i++) { assert.equal(meshes[i].material, before[i].material); assert.deepEqual(meshes[i].geometry.attributes.skinWeight.array, before[i].weights); }
    assert.equal(rig.extendedMeshes, 7);
  });
  await t.test('skin shader composes with the eye/hair shader and supports normal passes', () => {
    const material = new THREE.MeshNormalMaterial();
    material.onBeforeCompile = shader => { shader.vertexShader = '// retained material hook\n' + shader.vertexShader; };
    material.customProgramCacheKey = () => 'actual-material-profile-v1';
    patchSkinMaterial(material, 3);
    const shader = { vertexShader: THREE.ShaderLib.normal.vertexShader };
    material.onBeforeCompile(shader);
    assert(shader.vertexShader.startsWith('// retained material hook'));
    assert.equal((shader.vertexShader.match(/air3SkinMatrix \+=/g) || []).length, 12);
    assert(material.customProgramCacheKey().startsWith('actual-material-profile-v1|'));
  });
  await t.test('named morph subset is bounded and ready for the supplied face', () => {
    const face = document.meshes.find(m => m.name === 'face__AI_MetaHumanIdentity_FaceMesh');
    assert.equal(face.extras.targetNames.length, 29);
    assert(face.extras.targetNames.includes('head_lod0_mesh__jaw_open'));
    assert(face.extras.targetNames.includes('cartilage_lod0_mesh__eye_blink_L'));
    assert.equal(rig.face.ready, true); assert.equal(rig.face.bones.size, 35);
  });
  await t.test('jaw articulation moves lower teeth and tongue while keeping upper teeth fixed', () => {
    rig.setClip('MH_Idle01_UE'); rig.setTime(.5);
    const world = name => gltf.scene.getObjectByName('face__' + name).getWorldPosition(new THREE.Vector3());
    rig.setFacialPreview({ mouthCue: 'X', blink: 0, gazeX: 0, gazeY: 0, emotion: 'neutral', intensity: 0 });
    const upper = world('FACIAL_C_TeethUpper'), lower = world('FACIAL_C_TeethLower'), tongue = world('FACIAL_C_Tongue3');
    rig.setFacialPreview({ mouthCue: 'D', blink: 0, gazeX: 0, gazeY: 0, emotion: 'neutral', intensity: 0 });
    assert(world('FACIAL_C_TeethUpper').distanceTo(upper) < 1e-8);
    assert(world('FACIAL_C_TeethLower').distanceTo(lower) > .01);
    assert(world('FACIAL_C_Tongue3').distanceTo(tongue) > .008);
  });
  await t.test('all nine audio cues produce finite bounded controls and reset without accumulation', () => {
    for (const mouthCue of Object.keys(MOUTH_POSES)) {
      rig.setFacialPreview({ mouthCue, blink: 0, emotion: 'neutral', intensity: 0 });
      assert.equal(rig.face.currentCue, mouthCue);
      for (const { node } of rig.face.bones.values()) {
        for (const value of [...node.position, ...node.quaternion, ...node.scale]) assert(Number.isFinite(value));
        assert(Math.abs(node.quaternion.length() - 1) < 1e-5);
      }
    }
    rig.setFacialPreview({ mouthCue: 'X', blink: 0, emotion: 'neutral', intensity: 0 });
    const jaw = rig.face.bones.get('FACIAL_C_Jaw'); assert(jaw.node.quaternion.angleTo(jaw.quaternion) < 1e-6);
    rig.clearFacialPreview(); rig.setSpeech({ phase: 'idle', mouthCue: 'X' });
    for (let i = 0; i < 20; i++) rig.update(.05);
    assert.equal(rig.face.currentCue, 'X');
  });
  await t.test('foot grounding is invariant under a stage transform', () => {
    const holder = new THREE.Group(); holder.scale.setScalar(1.5); holder.rotation.y = .4; holder.position.set(2, .4, -3); holder.add(gltf.scene); holder.updateMatrixWorld(true);
    rig.setClip('MH_Talk02'); rig.setTime(2);
    const inverse = new THREE.Matrix4().copy(gltf.scene.matrixWorld).invert(), point = new THREE.Vector3(); let min = Infinity;
    for (const { node, index } of rig.groundAnchors) { node.getVertexPosition(index, point).applyMatrix4(node.matrixWorld).applyMatrix4(inverse); min = Math.min(min, point.y); }
    assert(Math.abs(min - rig.groundY) < 1e-6);
  });
  rig.dispose();
});
