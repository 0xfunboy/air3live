/** Deterministic 60 Hz locomotion regression; not a realtime rendering benchmark. */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { loadAvatarFixture } from '../test/fixtures/avatar-fixture.mjs';
import { Air3AvatarRig } from '../public/air3-avatar.mjs';
import { Air3StageMotion } from '../public/air3-stage-motion.mjs';
import { STAGE_LAYOUT } from '../public/studio-scene.mjs';

const position = node => node.getWorldPosition(new THREE.Vector3());
const gltf = await loadAvatarFixture(), rig = new Air3AvatarRig(gltf);
rig.setEyeContactEnabled(false); rig.setClip('MH_Idle01_UE'); rig.setTime(0);
const avatar = new THREE.Group(), holder = new THREE.Group(); holder.add(gltf.scene);
holder.scale.setScalar(1.0308577209468792);
gltf.scene.position.set(-.0271459225, .034982888, -.044700652);
avatar.add(holder); avatar.position.fromArray(STAGE_LAYOUT.home); avatar.rotation.y = .05; avatar.updateWorldMatrix(true, true);
const motion = new Air3StageMotion(rig, avatar, STAGE_LAYOUT), dt = 1 / 60;
const shoulders = Object.fromEntries(['l', 'r'].map(side => [side,
  position(rig.bodyBones.get('neck_01')).y - position(rig.bodyBones.get('upperarm_' + side)).y]));
const previousFeet = Object.fromEntries(['l', 'r'].map(side => [side, position(rig.bodyBones.get('foot_' + side))]));
let previousRoot = avatar.position.clone(), previousPelvis = position(motion.pelvis), previousVelocity = new THREE.Vector3();
let previousState = '', frames = 0, turnsObserved = 0, error = null;
const events = [], journeys = [], captureClipsExercised = new Set();
const metrics = { maximumRootStepMetres: 0, maximumRootAccelerationMetresPerSecondSquared: 0,
  maximumPelvisStepMetres: 0, maximumFootStepMetres: 0, maximumShoulderDropRelativeToNeckMetres: 0,
  maximumSettledTurnPivotOffsetMetres: 0, maximumSupportAnchorDriftMetres: 0, maximumIKErrorMetres: 0,
  maximumOutgoingTurnSteps: 0, maximumReturnTurnSteps: 0, maximumTurnCaptureLoops: 0, settledTurnSamples: 0 };

function advance() {
  motion.update(dt); rig.update(dt); frames++;
  const state = motion.phase + '/' + motion.travelState + '/' + motion.locomotion.id;
  if (state !== previousState) {
    events.push({ frame: frames, seconds: frames * dt, phase: motion.phase, action: motion.travelState,
      capture: motion.locomotion.id, captureTime: motion.locomotion.time, position: avatar.position.toArray(),
      heading: motion.heading, returning: motion.returning, plannedTurnSteps: motion.turnPlan?.steps ?? null });
    previousState = state;
  }
  captureClipsExercised.add(motion.locomotion.id);
  const step = avatar.position.distanceTo(previousRoot), velocity = avatar.position.clone().sub(previousRoot).divideScalar(dt);
  const pelvis = position(motion.pelvis);
  metrics.maximumRootStepMetres = Math.max(metrics.maximumRootStepMetres, step);
  metrics.maximumRootAccelerationMetresPerSecondSquared = Math.max(metrics.maximumRootAccelerationMetresPerSecondSquared, velocity.distanceTo(previousVelocity) / dt);
  metrics.maximumPelvisStepMetres = Math.max(metrics.maximumPelvisStepMetres, pelvis.distanceTo(previousPelvis));
  previousRoot.copy(avatar.position); previousVelocity.copy(velocity); previousPelvis.copy(pelvis);
  for (const side of ['l', 'r']) {
    const foot = position(rig.bodyBones.get('foot_' + side)), leg = motion.legs[side];
    metrics.maximumFootStepMetres = Math.max(metrics.maximumFootStepMetres, foot.distanceTo(previousFeet[side])); previousFeet[side].copy(foot);
    const gap = position(rig.bodyBones.get('neck_01')).y - position(rig.bodyBones.get('upperarm_' + side)).y;
    metrics.maximumShoulderDropRelativeToNeckMetres = Math.max(metrics.maximumShoulderDropRelativeToNeckMetres, gap - shoulders[side]);
    if (leg.stance && leg.contactWeight > .99 && motion.walkWeight > .99) {
      const support = position(leg.supportNode);
      metrics.maximumSupportAnchorDriftMetres = Math.max(metrics.maximumSupportAnchorDriftMetres, Math.hypot(support.x - leg.anchor.x, support.z - leg.anchor.z));
      metrics.maximumIKErrorMetres = Math.max(metrics.maximumIKErrorMetres, motion.contactErrors[side]);
    }
  }
  if (motion.phase === 'turning') {
    turnsObserved++;
    const key = motion.returning ? 'maximumReturnTurnSteps' : 'maximumOutgoingTurnSteps';
    metrics[key] = Math.max(metrics[key], motion.turnPlan.steps);
    metrics.maximumTurnCaptureLoops = Math.max(metrics.maximumTurnCaptureLoops, motion.locomotion.cycles);
    if (motion.turnWarp > .99 && motion.walkWeight > .999) {
      const centre = position(avatar); metrics.settledTurnSamples++;
      metrics.maximumSettledTurnPivotOffsetMetres = Math.max(metrics.maximumSettledTurnPivotOffsetMetres, Math.hypot(pelvis.x - centre.x, pelvis.z - centre.z));
    }
  }
}
function until(predicate) {
  for (let n = 0; n < 1600; n++) { advance(); if (predicate()) return; }
  throw new Error('Finite sequence did not finish: ' + JSON.stringify(motion.diagnostics()));
}
try {
  for (const target of ['left', 'center', 'right']) {
    motion.presentMonitor(target); until(() => motion.phase === 'presenting');
    const arrivalError = avatar.position.distanceTo(new THREE.Vector3().fromArray(STAGE_LAYOUT.monitorSpots[target]));
    for (let n = 0; n < 60; n++) advance();
    motion.returnHome(); until(() => motion.phase === 'home');
    const homeError = avatar.position.distanceTo(new THREE.Vector3().fromArray(STAGE_LAYOUT.home));
    for (let n = 0; n < 75; n++) advance();
    journeys.push({ target, arrivalErrorMetres: arrivalError, homeErrorMetres: homeError, sourceGroundingRestored: rig.groundFeet });
  }
} catch (caught) { error = caught.stack; }
const sources = {};
for (const name of ['public/assets/air3/models/AIR3-runtime.glb', 'public/air3-stage-motion.mjs', 'public/air3-locomotion.mjs',
  'public/air3-avatar.mjs', 'public/studio-scene.mjs', 'public/assets/air3/motion/accad-female1.mjs', '../tools/retarget_accad_motion.py',
  'scripts/qa-motion-refinement.mjs']) {
  const bytes = await fs.readFile(new URL('../' + name, import.meta.url));
  sources[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
const result = { schema: 'air3.motion-refinement-qa.v1', date: new Date().toISOString(),
  environment: { platform: process.platform, arch: process.arch, node: process.version, graphicalRenderer: 'none; real GLB skeleton' },
  sources, fixture: { uniformScale: holder.scale.y, modelTranslation: [-.0271459225, .034982888, -.044700652],
    referenceAnimation: 'MH_Idle01_UE frame 0', shoulderToNeckGapMetres: shoulders, deltaSeconds: dt,
    method: 'Fixed previous-release base-avatar fit; no clothing/hair bounds dependency, no speech in this comparison. Speech/cancellation are exercised by qa-stage-motion.' },
  metrics, simulatedFrames: frames, simulatedSeconds: frames * dt, turnsObserved, captureClipsExercised: [...captureClipsExercised], events, journeys,
  passed: !error && journeys.length === 3 && journeys.every(j => j.arrivalErrorMetres < .001 && j.homeErrorMetres < .001 && j.sourceGroundingRestored) &&
    metrics.maximumFootStepMetres < .07 && metrics.maximumRootAccelerationMetresPerSecondSquared < 10 &&
    metrics.maximumShoulderDropRelativeToNeckMetres < .018 && metrics.maximumSettledTurnPivotOffsetMetres < .003 &&
    metrics.maximumOutgoingTurnSteps === 1 && metrics.maximumReturnTurnSteps <= 2 && metrics.maximumTurnCaptureLoops === 0 &&
    metrics.maximumSupportAnchorDriftMetres < .05 && metrics.maximumIKErrorMetres < .005,
  limitations: ['Finite deterministic 60 Hz sampling is not a GPU/FPS benchmark.',
    'Foot step is full 3D displacement over one frame, including intended human swing velocity; it is not a sole-slip measurement.',
    'Shoulder drop is the change of each upper-arm attachment relative to the neck, not total body vertical motion.',
    'The turn step count describes the selected finite capture interval, not a contact-label counter; short turns use one step and reversal uses two.',
    'Pose blending, angular and stride adaptation are not Unreal motion matching. Source optical contact labels and 20mm maximum pelvis correction do not provide perfect sole contact.',
    'Raster images are substituted only in memory for Node; this report does not rate rendered appearance.'], error };
motion.dispose(); rig.dispose();
const output = resolve(process.env.AIR3_QA_DIR || fileURLToPath(new URL('../../docs/validation/current/', import.meta.url)));
await fs.mkdir(output, { recursive: true }); await fs.writeFile(resolve(output, 'motion-refinement-report.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ passed: result.passed, output, simulatedFrames: frames, metrics, journeys }));
if (!result.passed) process.exitCode = 1;
