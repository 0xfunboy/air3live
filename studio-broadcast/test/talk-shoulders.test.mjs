import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Air3AvatarRig } from '../public/air3-avatar.mjs';
import { createMocapClips } from '../public/air3-locomotion.mjs';
import { loadAvatarFixture } from './fixtures/avatar-fixture.mjs';
import { measureTalkShoulders } from './fixtures/talk-shoulder-fixture.mjs';

test('four full talk clips retain natural shoulder height, captured arm directions and original lower body', { timeout: 120_000 }, async () => {
  const result = await measureTalkShoulders();
  assert.equal(result.clips.length, 4); assert(result.sampledFrames > 3700);
  const m = result.metrics;
  assert(m.maximumUncorrectedShoulderDropMetres > .04, 'Fixture actually reproduces the reported collapse');
  assert(m.maximumCorrectedShoulderDropMetres <= .008001);
  assert(m.maximumCorrectedShoulderRiseMetres <= .008001);
  assert(m.maximumArmOrientationErrorRadians < 1e-6, 'No artificial change to shoulder/elbow/wrist gesture directions');
  assert.equal(m.maximumBonePositionDifferenceMetres, 0, 'No bone translations/lengths changed');
  assert.equal(m.maximumBoneScaleDifference, 0, 'No skeletal scale compensation');
  assert(m.maximumLowerBodyPositionDifferenceMetres < 1e-8);
});

test('talk correction restores cleanly on repeated seeks, zero delta updates and a transformed stage', async () => {
  const gltf = await loadAvatarFixture(), rig = new Air3AvatarRig(gltf);
  rig.setEyeContactEnabled(false); rig.setMicroExpressionsEnabled(false);
  const holder = new THREE.Group(); holder.scale.setScalar(1.37); holder.rotation.set(.05, 1.4, -.03); holder.position.set(3, .5, -2);
  holder.add(gltf.scene); holder.updateMatrixWorld(true);
  rig.setClip('MH_Talk01'); rig.setTime(3);
  const snapshots = ['clavicle_l', 'clavicle_r', 'upperarm_l', 'upperarm_r'].map(name => ({ name,
    quaternion: rig.bodyBones.get(name).quaternion.clone(), world: rig.bodyBones.get(name).getWorldPosition(new THREE.Vector3()) }));
  for (let n = 0; n < 50; n++) {
    if (n % 2) rig.setTime(3); else rig.update(0);
    for (const record of snapshots) {
      const bone = rig.bodyBones.get(record.name);
      assert(bone.quaternion.angleTo(record.quaternion) < 1e-6, record.name + ' must not accumulate');
      assert(bone.getWorldPosition(new THREE.Vector3()).distanceTo(record.world) < 1e-7);
    }
  }
  rig.setClip('MH_Idle01_UE'); rig.setTime(0);
  assert.equal(rig.talkShoulders.weight, 0); assert.equal(rig.talkShoulders.applied, false);
  rig.dispose();
});

test('rapid talk/idle changes crossfade shoulder correction without attachment pops or unnormalized weights', async () => {
  const gltf = await loadAvatarFixture(), rig = new Air3AvatarRig(gltf);
  rig.setEyeContactEnabled(false); rig.setMicroExpressionsEnabled(false); rig.setClip('MH_Idle01_UE'); rig.setTime(0);
  const position = side => rig.bodyBones.get(`upperarm_${side}`).getWorldPosition(new THREE.Vector3())
    .sub(rig.bodyBones.get('neck_01').getWorldPosition(new THREE.Vector3()));
  let previous = { l: position('l'), r: position('r') }, maximumStep = 0, previousWeight = 0, maximumWeightStep = 0;
  for (let frame = 0; frame < 780; frame++) {
    if ([12, 145, 278, 411].includes(frame)) rig.setSpeech({ phase: 'playing', mouthCue: 'D', amplitude: .3 });
    if ([110, 243, 376, 509].includes(frame)) rig.setSpeech({ phase: 'idle', mouthCue: 'X', amplitude: 0 });
    rig.update(1 / 60);
    maximumWeightStep = Math.max(maximumWeightStep, Math.abs(rig.talkShoulders.weight - previousWeight));
    previousWeight = rig.talkShoulders.weight;
    for (const side of ['l', 'r']) { const p = position(side); maximumStep = Math.max(maximumStep, p.distanceTo(previous[side])); previous[side] = p; }
    assert(Math.abs(rig.diagnostics().motionBlend.weightSum - 1) < 1e-8);
  }
  assert(maximumStep < .008, 'At 60 Hz the shoulder attachment relative to the neck has no multi-centimetre pop: ' + maximumStep);
  assert(maximumWeightStep < .1); assert.equal(rig.talkShoulders.weight, 0);
  rig.dispose();
});

test('manual mocap and idle tracks remain identical with talk stabilization enabled or disabled', async () => {
  const [left, right] = await Promise.all([loadAvatarFixture(), loadAvatarFixture()]);
  const fixed = new Air3AvatarRig(left), raw = new Air3AvatarRig(right, { stabilizeTalkShoulders: false });
  for (const rig of [fixed, raw]) { rig.setEyeContactEnabled(false); rig.registerClips(createMocapClips()); }
  for (const name of ['MH_Idle01_UE', 'MH_Idle02_UE', 'MH_Idle03_UE', 'ACCAD_Walk_Female', 'ACCAD_TurnLeft_Female']) {
    assert.equal(fixed.setClip(name), true); assert.equal(raw.setClip(name), true);
    for (const time of [0, .2, .7]) {
      fixed.setTime(time); raw.setTime(time);
      for (const [key, bone] of fixed.bodyBones) {
        const other = raw.bodyBones.get(key);
        assert(bone.position.distanceTo(other.position) < 1e-9);
        assert(bone.quaternion.clone().normalize().angleTo(other.quaternion.clone().normalize()) < 1e-6);
      }
    }
  }
  fixed.dispose(); raw.dispose();
});
