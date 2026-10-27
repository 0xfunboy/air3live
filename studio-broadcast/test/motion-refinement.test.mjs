import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { loadAvatarFixture } from './fixtures/avatar-fixture.mjs';
import { Air3AvatarRig } from '../public/air3-avatar.mjs';
import { Air3StageMotion } from '../public/air3-stage-motion.mjs';
import { Air3MocapLocomotion, createMocapClips } from '../public/air3-locomotion.mjs';
import { ACCAD_MOTION } from '../public/assets/air3/motion/accad-female1.mjs';
import { STAGE_LAYOUT } from '../public/studio-scene.mjs';

const position = node => node.getWorldPosition(new THREE.Vector3());

test('all finite turns end once, with a measured clockwise variant of the same human capture', () => {
  for (const id of ['turnLeft', 'turnRight', 'turnAround']) assert.equal(ACCAD_MOTION.clips[id].loop, false);
  const left = ACCAD_MOTION.clips.turnAround, right = ACCAD_MOTION.variants.turnAroundRight;
  assert.equal(right.loop, false); assert.equal(right.source, left.source);
  assert.equal(right.duration, left.duration);
  assert(Math.abs(left.yawChange + right.yawChange) < .00001, 'Reflection reverses captured turn direction');
  for (let frame = 0; frame < left.contacts.length; frame++) {
    assert.equal(left.contacts[frame][0], right.contacts[frame][1], 'The actual left/right contacts are exchanged');
    assert.equal(left.contacts[frame][1], right.contacts[frame][0]);
  }
});

test('capture crossfades remain continuous at completion and preserve the shoulder baseline at partial weights', async () => {
  const rig = new Air3AvatarRig(await loadAvatarFixture(), { groundFeet: false });
  rig.setEyeContactEnabled(false); rig.setClip('MH_Idle01_UE'); rig.setTime(0);
  const gap = side => position(rig.bodyBones.get('neck_01')).y - position(rig.bodyBones.get('upperarm_' + side)).y;
  const reference = { l: gap('l'), r: gap('r') };
  const capture = new Air3MocapLocomotion(rig);
  assert.equal(capture.setClip('toString'), false, 'Inherited object properties are not capture IDs');
  capture.advance(.1); capture.setClip('walk', { phase: .3, blend: .3 });
  for (const dt of [.1, .1, .0999]) capture.advance(dt);
  const before = capture.pose.map(q => q.clone()), previousPelvis = capture.pelvis.clone();
  capture.advance(.0002);
  assert(Math.max(...before.map((q, i) => q.angleTo(capture.pose[i]))) < .005,
    'No quaternion jump at the end of a blend (including its destination alias)');
  assert(previousPelvis.distanceTo(capture.pelvis) < .001);
  rig.registerClips(createMocapClips());
  for (const weight of [0, .25, .5, .75, 1]) {
    rig.setClip('MH_Idle01_UE'); rig.setTime(0);
    capture.setClip('stand', { restart: true, blend: .01 }); capture.advance(.1);
    capture.apply(weight);
    for (const side of ['l', 'r']) assert(gap(side) - reference[side] < .015,
      `Shoulder attachment remains close to original idle at ${weight}: ${side}`);
  }
  rig.dispose();
});

test('60 Hz finite journeys retain centred turns, shoulder height and continuous feet/root motion', { timeout: 120_000 }, async () => {
  const gltf = await loadAvatarFixture(), rig = new Air3AvatarRig(gltf);
  rig.setEyeContactEnabled(false); rig.setClip('MH_Idle01_UE'); rig.setTime(0);
  const avatar = new THREE.Group(), holder = new THREE.Group(); holder.add(gltf.scene);
  // Fixed prior release fit: this regression isolates motion from changes to
  // hair or clothing bounds and never changes the model's skeleton lengths.
  holder.scale.setScalar(1.0308577209468792);
  gltf.scene.position.set(-.0271459225, .034982888, -.044700652);
  avatar.add(holder); avatar.position.fromArray(STAGE_LAYOUT.home); avatar.rotation.y = .05; avatar.updateWorldMatrix(true, true);
  const motion = new Air3StageMotion(rig, avatar, STAGE_LAYOUT), dt = 1 / 60;
  const shoulders = Object.fromEntries(['l', 'r'].map(side => [side,
    position(rig.bodyBones.get('neck_01')).y - position(rig.bodyBones.get('upperarm_' + side)).y]));
  let previousRoot = avatar.position.clone(), previousVelocity = new THREE.Vector3(), frames = 0, centredSamples = 0;
  const previousFeet = Object.fromEntries(['l', 'r'].map(side => [side, position(rig.bodyBones.get('foot_' + side))]));
  let maximumFootStep = 0, maximumAcceleration = 0, maximumShoulderDrop = 0, maximumAnchorDrift = 0;
  const step = () => {
    motion.update(dt); rig.update(dt); frames++;
    const velocity = avatar.position.clone().sub(previousRoot).divideScalar(dt);
    maximumAcceleration = Math.max(maximumAcceleration, velocity.distanceTo(previousVelocity) / dt);
    previousRoot.copy(avatar.position); previousVelocity.copy(velocity);
    for (const side of ['l', 'r']) {
      const foot = position(rig.bodyBones.get('foot_' + side));
      maximumFootStep = Math.max(maximumFootStep, foot.distanceTo(previousFeet[side])); previousFeet[side].copy(foot);
      const gap = position(rig.bodyBones.get('neck_01')).y - position(rig.bodyBones.get('upperarm_' + side)).y;
      maximumShoulderDrop = Math.max(maximumShoulderDrop, gap - shoulders[side]);
      const leg = motion.legs[side];
      if (leg.stance && leg.contactWeight > .99) {
        const support = position(leg.supportNode);
        maximumAnchorDrift = Math.max(maximumAnchorDrift, Math.hypot(support.x - leg.anchor.x, support.z - leg.anchor.z));
      }
    }
    if (motion.phase === 'turning') {
      assert.equal(motion.locomotion.cycles, 0, 'Turn captures never wrap');
      assert(motion.turnPlan.steps <= (motion.returning ? 2 : 1));
      if (motion.turnWarp > .99 && motion.walkWeight > .999) {
        const pelvis = position(motion.pelvis), centre = position(avatar);
        assert(Math.hypot(pelvis.x - centre.x, pelvis.z - centre.z) < .003, 'Settled pelvis projection is within 3mm of the turn axis'); centredSamples++;
      }
    }
  };
  const until = predicate => {
    for (let n = 0; n < 1600; n++) { step(); if (predicate()) return; }
    assert.fail('Finite action sequence did not finish: ' + JSON.stringify(motion.diagnostics()));
  };
  for (const id of ['left', 'center', 'right']) {
    motion.presentMonitor(id); until(() => motion.phase === 'presenting');
    assert(avatar.position.distanceTo(new THREE.Vector3().fromArray(STAGE_LAYOUT.monitorSpots[id])) < .001);
    for (let n = 0; n < 60; n++) step();
    motion.returnHome(); until(() => motion.phase === 'home');
    assert(avatar.position.distanceTo(new THREE.Vector3().fromArray(STAGE_LAYOUT.home)) < .001);
    for (let n = 0; n < 75; n++) step();
    assert.equal(rig.groundFeet, true, 'Original grounding is restored after the walking layer fades out');
  }
  assert(frames > 2500 && centredSamples > 100);
  assert(maximumFootStep < .07, 'No foot teleport: ' + maximumFootStep);
  assert(maximumAcceleration < 10, 'Root never snaps to the destination or through a path corner: ' + maximumAcceleration);
  assert(maximumShoulderDrop < .018, 'Shoulder-to-neck relation stays natural: ' + maximumShoulderDrop);
  assert(maximumAnchorDrift < .05, 'Reachable support remains within 5cm at 60 Hz: ' + maximumAnchorDrift);
  motion.dispose(); rig.dispose();
});
