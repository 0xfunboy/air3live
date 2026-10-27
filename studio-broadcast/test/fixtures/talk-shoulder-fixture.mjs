import * as THREE from 'three';
import { loadAvatarFixture } from './avatar-fixture.mjs';
import { Air3AvatarRig } from '../../public/air3-avatar.mjs';

const SIDES = ['l', 'r'];
const ARMS = SIDES.flatMap(side => [`upperarm_${side}`, `lowerarm_${side}`, `hand_${side}`]);
const LOWER_BODY = ['pelvis', 'thigh_l', 'thigh_r', 'calf_l', 'calf_r', 'foot_l', 'foot_r', 'ball_l', 'ball_r'];
const world = (rig, name) => rig.bodyBones.get(name).getWorldPosition(new THREE.Vector3());
const quaternion = (rig, name) => rig.bodyBones.get(name).getWorldQuaternion(new THREE.Quaternion()).normalize();

export async function measureTalkShoulders({ fps = 60 } = {}) {
  const [rawGltf, fixedGltf] = await Promise.all([loadAvatarFixture(), loadAvatarFixture()]);
  const raw = new Air3AvatarRig(rawGltf, { stabilizeTalkShoulders: false });
  const fixed = new Air3AvatarRig(fixedGltf);
  for (const rig of [raw, fixed]) { rig.setEyeContactEnabled(false); rig.setMicroExpressionsEnabled(false); rig.setClip('MH_Idle01_UE'); rig.setTime(0); }
  const reference = Object.fromEntries(SIDES.map(side => [side, world(fixed, 'neck_01').y - world(fixed, `upperarm_${side}`).y]));
  const clips = []; let frames = 0;
  const metrics = { maximumUncorrectedShoulderDropMetres: 0, maximumCorrectedShoulderDropMetres: 0,
    maximumCorrectedShoulderRiseMetres: 0, maximumArmOrientationErrorRadians: 0,
    maximumBonePositionDifferenceMetres: 0, maximumBoneScaleDifference: 0, maximumLowerBodyPositionDifferenceMetres: 0 };
  for (const clip of raw.talks) {
    raw.setClip(clip.name); fixed.setClip(clip.name);
    const row = { name: clip.name, duration: clip.duration, samples: Math.ceil(clip.duration * fps),
      uncorrectedMaximumDropMetres: 0, correctedMaximumDropMetres: 0, correctedMaximumRiseMetres: 0, worstOriginalTimeSeconds: 0 };
    for (let sample = 0; sample < row.samples; sample++) {
      const time = sample / fps; raw.setTime(time); fixed.setTime(time); frames++;
      for (const side of SIDES) {
        const before = world(raw, 'neck_01').y - world(raw, `upperarm_${side}`).y - reference[side];
        const after = world(fixed, 'neck_01').y - world(fixed, `upperarm_${side}`).y - reference[side];
        if (before > row.uncorrectedMaximumDropMetres) { row.uncorrectedMaximumDropMetres = before; row.worstOriginalTimeSeconds = time; }
        row.correctedMaximumDropMetres = Math.max(row.correctedMaximumDropMetres, after);
        row.correctedMaximumRiseMetres = Math.max(row.correctedMaximumRiseMetres, -after);
      }
      for (const name of ARMS) metrics.maximumArmOrientationErrorRadians = Math.max(metrics.maximumArmOrientationErrorRadians,
        quaternion(raw, name).angleTo(quaternion(fixed, name)));
      for (const [name, bone] of raw.bodyBones) {
        const other = fixed.bodyBones.get(name);
        metrics.maximumBonePositionDifferenceMetres = Math.max(metrics.maximumBonePositionDifferenceMetres, bone.position.distanceTo(other.position));
        metrics.maximumBoneScaleDifference = Math.max(metrics.maximumBoneScaleDifference, bone.scale.distanceTo(other.scale));
      }
      for (const name of LOWER_BODY) metrics.maximumLowerBodyPositionDifferenceMetres = Math.max(metrics.maximumLowerBodyPositionDifferenceMetres,
        world(raw, name).distanceTo(world(fixed, name)));
    }
    metrics.maximumUncorrectedShoulderDropMetres = Math.max(metrics.maximumUncorrectedShoulderDropMetres, row.uncorrectedMaximumDropMetres);
    metrics.maximumCorrectedShoulderDropMetres = Math.max(metrics.maximumCorrectedShoulderDropMetres, row.correctedMaximumDropMetres);
    metrics.maximumCorrectedShoulderRiseMetres = Math.max(metrics.maximumCorrectedShoulderRiseMetres, row.correctedMaximumRiseMetres);
    clips.push(row);
  }
  raw.dispose(); fixed.dispose();
  return { referenceClip: 'MH_Idle01_UE frame 0', referenceNeckShoulderGapMetres: reference,
    deltaSeconds: 1 / fps, sampledFrames: frames, clips, metrics };
}
