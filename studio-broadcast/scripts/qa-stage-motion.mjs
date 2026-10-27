/** Numerical QA on the delivered GLB. Fixed simulation time is not a GPU/FPS benchmark. */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Air3AvatarRig } from '../public/air3-avatar.mjs';
import { Air3StageMotion } from '../public/air3-stage-motion.mjs';
import { createAir3Hair } from '../public/air3-hair.mjs';
import { STAGE_LAYOUT } from '../public/studio-scene.mjs';
import { MOCAP_CATALOG } from '../public/air3-locomotion.mjs';

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

const started = performance.now(), { gltf } = await fixture(), { hair, texture } = installFixtureHair(gltf), rig = new Air3AvatarRig(gltf);
rig.setClip('MH_Idle01_UE'); rig.setTime(0);
const bounds = visibleBounds(gltf.scene), size = bounds.getSize(new THREE.Vector3());
const avatar = new THREE.Group(), holder = new THREE.Group(); holder.add(gltf.scene); holder.scale.setScalar(1.76 / size.y);
gltf.scene.position.sub(new THREE.Vector3((bounds.min.x + bounds.max.x) / 2, bounds.min.y, (bounds.min.z + bounds.max.z) / 2));
avatar.add(holder); avatar.position.fromArray(STAGE_LAYOUT.home); avatar.rotation.y = .05; avatar.updateWorldMatrix(true, true);
const motion = new Air3StageMotion(rig, avatar, STAGE_LAYOUT), delta = .04;
const baselineHands = Object.fromEntries(['l', 'r'].map(s => [s, rig.bodyBones.get('hand_' + s).quaternion.clone()]));
const metrics = { simulatedFrames: 0, maximumSwingLiftMetres: 0, maximumPlantedAnkleErrorMetres: 0,
  maximumPlantedPlanarFootYawOffsetDegrees: 0, maximumCapturedFootRotationErrorDegrees: 0,
  maximumSupportAnchorDriftMetres: 0, maximumPlantedDisplacementPerFrameMetres: 0,
  maximumPelvisLoweringMetres: 0, minimumDeskClearanceMetres: Infinity, reversedKneeSamples: 0, nonfiniteTransforms: 0 };
const previousFeet = {}, speechSwitches = [], captureClipsExercised = new Set();
function advance() {
  if (metrics.simulatedFrames % 220 === 130) {
    rig.setSpeech({ phase: 'playing', mouthCue: 'D', amplitude: .35 });
    speechSwitches.push({ simulatedFrame: metrics.simulatedFrames, speech: 'playing', stagePhase: motion.phase, clip: rig.active?.getClip().name });
  }
  if (metrics.simulatedFrames % 220 === 200) {
    rig.setSpeech({ phase: 'idle', mouthCue: 'X', amplitude: 0 });
    speechSwitches.push({ simulatedFrame: metrics.simulatedFrames, speech: 'idle', stagePhase: motion.phase, clip: rig.active?.getClip().name });
  }
  motion.update(delta); rig.update(delta); hair.update(delta); metrics.simulatedFrames++;
  captureClipsExercised.add(motion.locomotion.id);
  metrics.maximumPelvisLoweringMetres = Math.max(metrics.maximumPelvisLoweringMetres, motion.pelvisDrop || 0);
  const centre = STAGE_LAYOUT.desk.center, half = STAGE_LAYOUT.desk.halfSize;
  const dx = Math.max(0, Math.abs(avatar.position.x - centre[0]) - half[0]);
  const dz = Math.max(0, Math.abs(avatar.position.z - centre[2]) - half[2]);
  metrics.minimumDeskClearanceMetres = Math.min(metrics.minimumDeskClearanceMetres, Math.hypot(dx, dz));
  for (const bone of rig.bodyBones.values()) if (![...bone.position, ...bone.quaternion, ...bone.scale].every(Number.isFinite)) metrics.nonfiniteTransforms++;
  for (const [side, leg] of Object.entries(motion.legs)) {
    metrics.maximumSwingLiftMetres = Math.max(metrics.maximumSwingLiftMetres, leg.position.y - avatar.position.y - leg.ankleHeight);
    const actual = leg.end.getWorldPosition(new THREE.Vector3());
    if (leg.stance && leg.contactWeight > .99 && motion.walkWeight > .99) {
      metrics.maximumPlantedAnkleErrorMetres = Math.max(metrics.maximumPlantedAnkleErrorMetres, actual.distanceTo(leg.position));
      const ball = rig.bodyBones.get('ball_' + side).getWorldPosition(new THREE.Vector3());
      const footYaw = Math.atan2(ball.x - actual.x, ball.z - actual.z);
      metrics.maximumPlantedPlanarFootYawOffsetDegrees = Math.max(metrics.maximumPlantedPlanarFootYawOffsetDegrees,
        Math.abs(THREE.MathUtils.radToDeg(Math.atan2(Math.sin(footYaw - motion.heading), Math.cos(footYaw - motion.heading)))));
      metrics.maximumCapturedFootRotationErrorDegrees = Math.max(metrics.maximumCapturedFootRotationErrorDegrees,
        THREE.MathUtils.radToDeg(leg.end.getWorldQuaternion(new THREE.Quaternion()).angleTo(leg.quaternion)));
      const support = leg.supportNode.getWorldPosition(new THREE.Vector3());
      metrics.maximumSupportAnchorDriftMetres = Math.max(metrics.maximumSupportAnchorDriftMetres,
        Math.hypot(support.x - leg.anchor.x, support.z - leg.anchor.z));
      const previous = previousFeet[side];
      if (previous?.stance && previous.supportId === leg.supportId && previous.anchor.distanceTo(leg.anchor) < 1e-7) metrics.maximumPlantedDisplacementPerFrameMetres =
        Math.max(metrics.maximumPlantedDisplacementPerFrameMetres, Math.hypot(support.x - previous.support.x, support.z - previous.support.z));
      const hip = leg.upper.getWorldPosition(new THREE.Vector3()), knee = leg.lower.getWorldPosition(new THREE.Vector3());
      const line = actual.clone().sub(hip).normalize(), kneeOffset = knee.clone().sub(hip);
      kneeOffset.addScaledVector(line, -kneeOffset.dot(line));
      const capturedPole = leg.poleTarget.clone().sub(hip); capturedPole.addScaledVector(line, -capturedPole.dot(line)).normalize();
      if (kneeOffset.dot(capturedPole) < -.002) metrics.reversedKneeSamples++;
    }
    previousFeet[side] = { actual, support: leg.supportNode?.getWorldPosition(new THREE.Vector3()) ?? actual,
      supportId: leg.supportId, anchor: leg.anchor.clone(), stance: leg.stance && leg.contactWeight > .99 && motion.walkWeight > .99 };
  }
}
function until(predicate) {
  let frames = 0; while (frames++ < 1800) { advance(); if (predicate()) return frames; }
  throw new Error('Journey did not finish: ' + JSON.stringify(motion.diagnostics()));
}
const journeys = [];
let error = null;
try {
  for (const target of ['left', 'center', 'right']) {
    motion.presentMonitor(target); const outwardFrames = until(() => motion.phase === 'presenting' && motion.targetId === target);
    for (let i = 0; i < 60; i++) advance();
    const side = motion.pointingSide, hand = rig.bodyBones.get('hand_' + side);
    const presentation = { position: avatar.position.toArray(), pointingSide: side, pointWeight: motion.pointWeight,
      minimumFlexMetres: motion.stanceFlex, resolvedPelvisDropMetres: motion.pelvisDrop,
      kneeFlexionDegrees: Object.fromEntries(Object.entries(motion.legs).map(([name, leg]) => {
        const hip = leg.upper.getWorldPosition(new THREE.Vector3()), knee = leg.lower.getWorldPosition(new THREE.Vector3()), ankle = leg.end.getWorldPosition(new THREE.Vector3());
        return [name, 180 - THREE.MathUtils.radToDeg(hip.sub(knee).angleTo(ankle.sub(knee)))];
      })),
      wristRotationFromInitialPoseDegrees: THREE.MathUtils.radToDeg(hand.quaternion.angleTo(baselineHands[side])) };
    motion.returnHome(); const returnFrames = until(() => motion.phase === 'home');
    for (let i = 0; i < 30; i++) advance();
    journeys.push({ target, outwardSimulatedSeconds: outwardFrames * delta, returnSimulatedSeconds: returnFrames * delta,
      arrived: true, returned: avatar.position.distanceTo(new THREE.Vector3().fromArray(STAGE_LAYOUT.home)) < .001,
      sourceGroundingRestored: rig.groundFeet, presentation });
  }
  motion.presentMonitor('right'); for (let i = 0; i < 130; i++) advance();
  motion.returnHome(); const cancellationFrames = until(() => motion.phase === 'home');
  journeys.push({ target: 'cancel-right-return-home', returned: true, returnSimulatedSeconds: cancellationFrames * delta });
} catch (caught) { error = caught.stack; }
const sources = {};
for (const name of ['public/assets/air3/models/AIR3-runtime.glb', 'public/air3-stage-motion.mjs', 'public/air3-locomotion.mjs',
  'public/assets/air3/motion/accad-female1.mjs', '../tools/retarget_accad_motion.py',
  'public/air3-avatar.mjs', 'public/air3-hair.mjs', 'public/studio-scene.mjs']) {
  const bytes = await fs.readFile(new URL('../' + name, import.meta.url));
  sources[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
const result = { schema: 'airewardrop.stage-motion-mocap-qa.v2', date: new Date().toISOString(),
  environment: { platform: process.platform, arch: process.arch, node: process.version, graphicalRenderer: 'none; numerical skeleton test' },
  sources, motionCapture: true, captureClips: MOCAP_CATALOG, captureClipsExercised: [...captureClipsExercised],
  provenance: JSON.parse(await fs.readFile(new URL('../../source-assets/motion/accad-female1/manifest.json', import.meta.url), 'utf8')),
  metricDefinitions: { maximumPlantedAnkleErrorMetres: 'Error from the IK target, separate from support-anchor drift',
    maximumSupportAnchorDriftMetres: 'Horizontal displacement of the grounded heel/forefoot marker from its original stance anchor',
    maximumPlantedPlanarFootYawOffsetDegrees: 'True horizontal foot-to-ball heading relative to avatar route heading; recorded turns can exceed 45 degrees',
    maximumCapturedFootRotationErrorDegrees: 'Rotation introduced by IK relative to the recorded foot pose; includes heel/toe roll',
    reversedKneeSamples: 'Knee bend opposite the pole obtained from the recorded pose, not relative to the camera or global forward' },
  avatarFit: { method: 'precise traverseVisible base-avatar bounds with the preserved legacy hairstyle; attachment selection is tested separately in browser QA',
    sourceVisibleBounds: { min: bounds.min.toArray(), max: bounds.max.toArray() }, sourceVisibleHeightMetres: size.y,
    uniformScale: holder.scale.y, requestedVisibleHeightMetres: 1.76, hairstyle: hair.diagnostics() }, deltaSeconds: delta, wallTimeMilliseconds: performance.now() - started, metrics, journeys, speechSwitches,
  passed: !error && journeys.length === 4 && metrics.nonfiniteTransforms === 0 && metrics.reversedKneeSamples === 0 &&
    journeys.filter(j => j.presentation).every(j => j.presentation.minimumFlexMetres < .006) &&
    metrics.maximumPlantedAnkleErrorMetres < .005 && metrics.maximumCapturedFootRotationErrorDegrees < 1.5 &&
    metrics.maximumSupportAnchorDriftMetres < .05 && metrics.maximumPelvisLoweringMetres <= .020001 &&
    ['start', 'walk', 'stop', 'turnLeft', 'turnRight'].every(id => captureClipsExercised.has(id)) && metrics.minimumDeskClearanceMetres > .22,
  limitations: ['Fixed simulation time; not a realtime performance measurement', 'Speech phase/cue events exercise body clip transitions; no audio is rendered in this numerical test', 'No cloth, hair collision or full sole contact physics',
    'Uses actual GLB bones, skin and base visible-bounds scale; raster textures replaced only for numerical Node execution',
    'Source turns are spatially shortened for the studio and the pelvis has at most 20mm of reach correction; this is not Unreal motion matching or perfect contact physics',
    'Source contact labels require a grounded heel/forefoot marker below 12cm/s; unlabelled rolling/transitional frames are not asserted as fixed contacts'], error };
motion.dispose(); rig.dispose(); hair.dispose(); texture.dispose();
const output = resolve(process.env.AIR3_QA_DIR || fileURLToPath(new URL('../../docs/validation/current/', import.meta.url)));
await fs.mkdir(output, { recursive: true }); await fs.writeFile(resolve(output, 'stage-motion-report.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ passed: result.passed, output, metrics, journeys: journeys.map(j => ({ target: j.target, arrived: j.arrived, returned: j.returned })) }));
if (!result.passed) process.exitCode = 1;
