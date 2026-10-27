import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Air3AvatarRig } from '../public/air3-avatar.mjs';
import { blendMouthPoses, MOUTH_POSES } from '../public/air3-face.mjs';
import { mouthPoseWeightsAt, normalizeMouthCues } from '../public/lip-sync.mjs';
import { loadAvatarFixture } from './fixtures/avatar-fixture.mjs';

test('camera attention follows a real world lens with bounded neck and binocular eye rotations', { timeout: 120000 }, async () => {
  const gltf = await loadAvatarFixture(), rig = new Air3AvatarRig(gltf);
  const holder = new THREE.Group(); holder.add(gltf.scene); holder.scale.setScalar(1.13); holder.rotation.y = .46; holder.position.set(1, .1, -2);
  holder.updateMatrixWorld(true); rig.mixer.timeScale = 0; rig.setTime(0); rig.setMicroExpressionsEnabled(false);
  const camera = new THREE.PerspectiveCamera();
  camera.position.copy(holder.localToWorld(new THREE.Vector3(0, 1.58, 3)));
  rig.setCameraTarget(camera);
  const settle = () => { for (let frame = 0; frame < 180; frame++) rig.update(1 / 60); };
  const errors = target => ['L', 'R'].map(side => {
    const eye = gltf.scene.getObjectByName(`face__FACIAL_${side}_Eye`);
    const direction = new THREE.Vector3(0, 1, 0).transformDirection(eye.matrixWorld);
    const toward = new THREE.Vector3().subVectors(target, eye.getWorldPosition(new THREE.Vector3())).normalize();
    return direction.angleTo(toward) * 180 / Math.PI;
  });
  settle();
  assert.ok(errors(camera.position).every(error => error < 2), 'Both actual eyeball forward axes converge toward the lens');
  const before = rig.bodyBones.get('head').quaternion.clone();
  camera.position.copy(holder.localToWorld(new THREE.Vector3(1.6, 1.75, 2.8)));
  rig.update(1 / 60);
  assert.ok(before.angleTo(rig.bodyBones.get('head').quaternion) < .08, 'A camera cut is damped, not snapped');
  settle(); assert.ok(errors(camera.position).every(error => error < 2), 'Moving lens is followed under rotated/scaled stage transform');
  const monitor = holder.localToWorld(new THREE.Vector3(-1.2, 1.5, 2.2));
  rig.setAttentionTarget(monitor, { kind: 'monitor' }); settle();
  assert.equal(rig.diagnostics().attention.target, 'monitor');
  assert.ok(errors(monitor).every(error => error < 2));
  rig.clearAttentionTarget(); settle();
  assert.equal(rig.diagnostics().attention.target, 'camera');
  // Brief intentional micro-glances may add up to 2.8 degrees.
  assert.ok(errors(camera.position).every(error => error < 4));
  assert.equal(rig.setAttentionTarget({ x: NaN, y: 0, z: 0 }), false);
  rig.setAttentionTarget(holder.localToWorld(new THREE.Vector3(0, 5, -2))); settle();
  const d = rig.diagnostics().attention;
  assert.ok(Math.abs(d.headYawDegrees) <= 48.0001 && d.headPitchDegrees <= 20.0001 && d.headPitchDegrees >= -18.0001);
  assert.ok(Object.values(d.eyeYawDegrees).every(value => Math.abs(value) <= 24.0001));
  assert.ok(Object.values(d.eyePitchDegrees).every(value => Math.abs(value) <= 17.0001));
  for (const row of rig.attention.chain) assert.ok(Math.abs(row.node.quaternion.length() - 1) < 1e-6);
  rig.dispose();
});

test('pose layers cannot accumulate, and interrupted motion fades remain normalized', { timeout: 120000 }, async () => {
  const gltf = await loadAvatarFixture(), rig = new Air3AvatarRig(gltf);
  rig.mixer.timeScale = 0; rig.setTime(0);
  const rootX = rig.bodyRoot.position.x;
  rig.setBodyPoseLayer((dt, current) => { current.bodyRoot.position.x += .1; });
  for (let frame = 0; frame < 60; frame++) rig.update(1 / 60);
  assert.ok(Math.abs(rig.bodyRoot.position.x - rootX - .1) < 1e-6);
  rig.setBodyPoseLayer(null); rig.update(0);
  assert.ok(Math.abs(rig.bodyRoot.position.x - rootX) < 1e-6);
  for (let frame = 0; frame < 120; frame++) {
    if (frame % 5 === 0) rig.setSpeech({ phase: frame % 10 ? 'idle' : 'playing', mouthCue: 'X' });
    rig.update(1 / 60);
    assert.ok(Math.abs(rig.diagnostics().motionBlend.weightSum - 1) < 1e-10);
    for (const row of rig.motionActions.values()) assert.ok(row.weight >= 0 && row.weight <= 1);
  }
  rig.dispose();
});

test('audio-clock coarticulation is continuous through cue changes and preserves silence', () => {
  const cues = normalizeMouthCues([{ start: .1, end: .3, value: 'A' }, { start: .3, end: .6, value: 'D' }, { start: .8, end: 1, value: 'F' }], 1.2);
  for (const time of [-.1, 0, .7, 1.2]) assert.equal(mouthPoseWeightsAt(cues, time, 1.2).X, 1);
  let previous = null;
  for (let step = 0; step <= 1200; step++) {
    const weights = mouthPoseWeightsAt(cues, step / 1000, 1.2);
    assert.ok(Math.abs(Object.values(weights).reduce((a, b) => a + b, 0) - 1) < 1e-10);
    assert.ok(Object.values(weights).every(value => value >= 0 && value <= 1));
    const pose = blendMouthPoses(weights);
    assert.ok(pose.jaw >= 0 && pose.jaw <= MOUTH_POSES.D.jaw);
    if (previous) assert.ok(Math.abs(pose.jaw - previous.jaw) < .006, 'No step discontinuity at recognizer boundaries');
    previous = pose;
  }
  const boundary = mouthPoseWeightsAt(cues, .3, 1.2);
  assert.ok(boundary.A > 0 && boundary.D > 0, 'Adjacent real cues share the transition');
});
