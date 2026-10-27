import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Air3AvatarRig } from '../public/air3-avatar.mjs';
import { createMocapClips, MOCAP_CATALOG } from '../public/air3-locomotion.mjs';
import { ACCAD_MOTION } from '../public/assets/air3/motion/accad-female1.mjs';

async function fixture() {
  const original = await fs.readFile(new URL('../public/assets/air3/models/AIR3-runtime.glb', import.meta.url));
  const length = original.readUInt32LE(12), data = JSON.parse(original.subarray(20, 20 + length));
  // Only raster materials are removed for Node. Real body geometry, weights,
  // bind matrices, morphs, bones and original animation buffers are retained.
  data.materials = data.materials.map(m => ({ name: m.name, pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: .7 } }));
  delete data.images; delete data.textures; delete data.extensionsRequired; delete data.extensionsUsed;
  const json = Buffer.from(JSON.stringify(data)), padded = Buffer.concat([json, Buffer.alloc((-json.length) & 3, 32)]);
  const bin = original.subarray(20 + length), header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + padded.length + bin.length, 8);
  header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const bytes = Buffer.concat([header, padded, bin]);
  return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
}

test('seven recorded captures retain source hashes, attribution and the exact target rig identity', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../../source-assets/motion/accad-female1/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.license, 'https://creativecommons.org/licenses/by/3.0/');
  assert.equal(manifest.clips.length, 7);
  for (const clip of [...manifest.clips, ...(manifest.variants ?? [])]) {
    const bytes = await fs.readFile(new URL('../../source-assets/motion/accad-female1/' + clip.source, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), clip.sha256);
    assert.match(bytes.toString(), /^HIERARCHY/);
  }
  const target = await fs.readFile(new URL('../public/assets/air3/models/AIR3-runtime.glb', import.meta.url));
  assert.equal(createHash('sha256').update(target).digest('hex'), ACCAD_MOTION.targetSha256);
  const runtime = await fs.readFile(new URL('../public/assets/air3/motion/accad-female1.mjs', import.meta.url));
  assert.equal(createHash('sha256').update(runtime).digest('hex'), manifest.outputSha256);
});

test('manual capture selection survives narration without adding walking to the automatic idle rotation', async () => {
  const rig = new Air3AvatarRig(await fixture()), idles = rig.idles.map(c => c.name);
  assert.equal(rig.registerClips(createMocapClips()), true);
  for (const entry of MOCAP_CATALOG) {
    assert.equal(rig.setClip(entry.name), true); rig.setTime(.3);
    assert.equal(rig.active.getClip().name, entry.name);
    assert.equal(rig.active.getClip().userData.motionCapture, true);
    const oneShot = !ACCAD_MOTION.clips[entry.id].loop;
    assert.equal(rig.active.loop, oneShot ? THREE.LoopOnce : THREE.LoopRepeat);
    assert.equal(rig.active.clampWhenFinished, oneShot);
    rig.setTime(entry.duration + .25);
    if (oneShot) {
      assert.equal(rig.active.paused, true, 'A finished transition holds its final frame');
      assert.equal(rig.active.time, entry.duration);
      rig.setClip(entry.name);
      assert.equal(rig.active.paused, false, 'Selecting a completed transition replays it');
      assert.equal(rig.active.time, 0);
    } else {
      assert.equal(rig.active.paused, false, 'Cyclic captures continue playing');
      assert(rig.active.time < entry.duration);
    }
  }
  rig.setClip('ACCAD_Walk_Female');
  rig.setSpeech({ phase: 'playing', mouthCue: 'D', amplitude: .4 }); rig.update(.05);
  assert.equal(rig.active.getClip().name, 'ACCAD_Walk_Female');
  assert.deepEqual(rig.idles.map(c => c.name), idles);
  assert.equal(rig.setClip('invalid-capture'), false);
  rig.setClip('MH_Idle01_UE'); assert.equal(rig.manualClip, null); rig.dispose();
});

test('retargeted human walking moves both legs, preserves segment lengths and crosses the loop without a pose jump', async () => {
  const rig = new Air3AvatarRig(await fixture(), { groundFeet: false });
  rig.registerClips(createMocapClips()); rig.setEyeContactEnabled(false); rig.setClip('ACCAD_Walk_Female');
  const names = ['calf_l', 'calf_r', 'foot_l', 'foot_r', 'lowerarm_l', 'lowerarm_r', 'hand_l', 'hand_r'];
  const initial = Object.fromEntries(names.map(n => [n, rig.bodyBones.get(n).position.clone()]));
  const height = { l: [], r: [] }, forward = { l: [], r: [] }, duration = rig.active.getClip().duration;
  for (let frame = 0; frame < 90; frame++) {
    rig.setTime(duration * frame / 90);
    for (const name of names) {
      const bone = rig.bodyBones.get(name);
      assert(bone.position.distanceTo(initial[name]) < .000001, 'Fixed segment length: ' + name);
      assert(bone.scale.distanceTo(new THREE.Vector3(1, 1, 1)) < .000001, 'No stretch: ' + name);
      assert([...bone.position, ...bone.quaternion, ...bone.scale].every(Number.isFinite));
    }
    for (const side of ['l', 'r']) {
      const foot = rig.bodyBones.get('foot_' + side).getWorldPosition(new THREE.Vector3());
      height[side].push(foot.y); forward[side].push(foot.z);
    }
  }
  for (const side of ['l', 'r']) {
    assert(Math.max(...height[side]) - Math.min(...height[side]) > .07, 'Recorded foot lift');
    assert(Math.max(...forward[side]) - Math.min(...forward[side]) > .45, 'Recorded stride');
  }
  const sample = t => { rig.setTime(t); return Object.fromEntries(names.map(n => [n, rig.bodyBones.get(n).getWorldPosition(new THREE.Vector3())])); };
  const before = sample(duration - .0001), after = sample(duration + .0001);
  for (const name of names) assert(before[name].distanceTo(after[name]) < .001, 'Continuous loop: ' + name);
  rig.dispose();
});
