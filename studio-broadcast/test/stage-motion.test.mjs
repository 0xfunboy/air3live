import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Air3AvatarRig } from '../public/air3-avatar.mjs';
import { Air3StageMotion } from '../public/air3-stage-motion.mjs';
import { createAir3Hair } from '../public/air3-hair.mjs';
import { STAGE_LAYOUT } from '../public/studio-scene.mjs';

function installFixtureHair(gltf) {
  // Browser materials mark the face and supply the source coverage texture.
  // The numerical fixture needs the same surface tag and a harmless 1px map;
  // image pixels do not influence the hair geometry or the visible bounds.
  const texture = new THREE.DataTexture(new Uint8Array([60, 45, 35, 255]), 1, 1);
  texture.needsUpdate = true;
  gltf.scene.traverse(node => {
    if (node.isMesh && node.material.name === 'face__MI_HeadSynthesized_Baked') node.userData.air3Surface = 'skin-face';
    if (node.isMesh && node.name.startsWith('hair__')) node.material.map = texture;
  });
  return { hair: createAir3Hair(gltf.scene, { quality: 'software' }), texture };
}

function visibleBounds(root) {
  root.updateMatrixWorld(true); const bounds = new THREE.Box3();
  root.traverseVisible(obj => { if (obj.isMesh) bounds.union(new THREE.Box3().setFromObject(obj, true)); });
  return bounds;
}

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

test('actual avatar walks to all monitors with planted feet and returns through the clear aisle', { timeout: 120_000 }, async () => {
  const { gltf } = await fixture(), { hair, texture } = installFixtureHair(gltf), rig = new Air3AvatarRig(gltf);
  rig.setClip('MH_Idle01_UE'); rig.setTime(0);
  const bounds = visibleBounds(gltf.scene), size = bounds.getSize(new THREE.Vector3());
  const avatar = new THREE.Group(), scale = new THREE.Group(); scale.add(gltf.scene);
  scale.scale.setScalar(1.76 / size.y);
  gltf.scene.position.sub(new THREE.Vector3((bounds.min.x + bounds.max.x) / 2, bounds.min.y, (bounds.min.z + bounds.max.z) / 2));
  avatar.add(scale); avatar.position.fromArray(STAGE_LAYOUT.home); avatar.rotation.y = .05; avatar.updateWorldMatrix(true, true);
  const motion = new Air3StageMotion(rig, avatar, STAGE_LAYOUT);
  assert.equal(motion.ready, true); assert.equal(motion.enabled, false);
  assert.equal(hair.diagnostics().legacyBunHidden, true);
  assert(visibleBounds(gltf.scene).getSize(new THREE.Vector3()).y < 1.761, 'Avatar bounds match the visible hairstyle scale');
  assert.equal(motion.presentMonitor('not-a-screen'), false);
  const lengths = Object.fromEntries(['calf_l', 'calf_r', 'foot_l', 'foot_r', 'lowerarm_l', 'lowerarm_r', 'hand_l', 'hand_r']
    .map(name => [name, { position: rig.bodyBones.get(name).position.clone(), scale: rig.bodyBones.get(name).scale.clone() }]));
  let maximumLift = 0, checkedFrames = 0, speechSwitches = 0;
  const step = () => {
    // Narration can begin while a manual journey is already in progress.
    // Cycle real talk/idle clips through their normal rig API during footsteps.
    if (checkedFrames % 220 === 130) { rig.setSpeech({ phase: 'playing', mouthCue: 'D', amplitude: .35 }); speechSwitches++; }
    if (checkedFrames % 220 === 200) { rig.setSpeech({ phase: 'idle', mouthCue: 'X', amplitude: 0 }); speechSwitches++; }
    motion.update(.04); rig.update(.04); hair.update(.04); checkedFrames++;
    for (const [name, original] of Object.entries(lengths)) {
      const bone = rig.bodyBones.get(name);
      assert(bone.position.distanceTo(original.position) < .00015, 'IK must not change bone length: ' + name);
      assert(bone.scale.distanceTo(original.scale) < .001, 'IK must not stretch bones: ' + name);
      assert([...bone.position, ...bone.quaternion, ...bone.scale].every(Number.isFinite));
    }
    const { center, halfSize } = STAGE_LAYOUT.desk;
    const outsideExpandedDesk = Math.abs(avatar.position.x - center[0]) > halfSize[0] + .22 ||
      Math.abs(avatar.position.z - center[2]) > halfSize[2] + .22;
    assert(outsideExpandedDesk, 'Presenter clearance from the desk');
    for (const [side, leg] of Object.entries(motion.legs)) {
      maximumLift = Math.max(maximumLift, leg.position.y - avatar.position.y - leg.ankleHeight);
      if (leg.stance && leg.contactWeight > .99 && motion.walkWeight > .99) {
        assert(motion.contactErrors[side] < .005, 'Planted ankle stays within 5mm: ' + side + ' ' + motion.contactErrors[side]);
        // The recorded turns contain heel/toe roll. A full quaternion angle
        // from a flat rest shoe is not its yaw and must not suppress that roll.
        // Contact IK must preserve the captured foot orientation instead.
        const actual = leg.end.getWorldQuaternion(new THREE.Quaternion());
        assert(actual.angleTo(leg.quaternion) < .025, 'Contact IK preserves captured foot rotation');
        const support = leg.supportNode.getWorldPosition(new THREE.Vector3());
        assert(Math.hypot(support.x - leg.anchor.x, support.z - leg.anchor.z) < .05,
          'Measured heel/forefoot support drift stays below 5cm');
      }
    }
  };
  const until = (predicate, limit = 1600) => {
    for (let i = 0; i < limit; i++) { step(); if (predicate()) return i + 1; }
    assert.fail('Journey did not finish: ' + JSON.stringify(motion.diagnostics()));
  };
  for (let i = 0; i < 10; i++) step();
  assert(avatar.position.distanceTo(new THREE.Vector3().fromArray(STAGE_LAYOUT.home)) < 1e-8);
  for (const id of ['left', 'center', 'right']) {
    assert.equal(motion.presentMonitor(id), true);
    until(() => motion.phase === 'presenting' && motion.targetId === id);
    assert(avatar.position.distanceTo(new THREE.Vector3().fromArray(STAGE_LAYOUT.monitorSpots[id])) < .001);
    for (let i = 0; i < 40; i++) step();
    assert(motion.pointWeight > .79); assert(['l', 'r'].includes(motion.pointingSide));
    assert(motion.stanceFlex < .006, 'A settled presenter must release the walking crouch');
    assert.equal(motion.returnHome(), true);
    until(() => motion.phase === 'home');
    for (let i = 0; i < 30; i++) step();
    assert.equal(rig.groundFeet, true);
    assert(avatar.position.distanceTo(new THREE.Vector3().fromArray(STAGE_LAYOUT.home)) < .001);
  }
  assert(maximumLift > .035, 'Feet actually lift instead of sliding an idle animation');
  assert.equal(motion.diagnostics().motionCapture, true);
  assert.equal(motion.diagnostics().syntheticGait, false);
  assert(motion.stepNumber > 15); assert(checkedFrames > 500); assert(speechSwitches >= 8, 'Live speech transitions exercise all talk clips while moving');
  // Cancelling a journey follows its recorded clear route back to home.
  motion.presentMonitor('right'); for (let i = 0; i < 130; i++) step();
  motion.returnHome(); until(() => motion.phase === 'home');
  for (let i = 0; i < 30; i++) step();
  assert.equal(motion.pendingId, null);
  assert.equal(rig.groundFeet, true);
  motion.dispose(); assert.equal(rig.bodyPoseLayer, null); assert.equal(rig.groundFeet, true); rig.dispose(); hair.dispose(); texture.dispose();
});
