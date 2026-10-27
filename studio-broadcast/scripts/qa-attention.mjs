/** Deterministic actual-skeleton gaze audit. No browser or GPU performance claim. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { Air3AvatarRig } from '../public/air3-avatar.mjs';
import { loadAvatarFixture } from '../test/fixtures/avatar-fixture.mjs';
import { serviceRoot } from '../src/config.mjs';

const output = resolve(process.env.AIR3_QA_DIR || resolve(serviceRoot, '../docs/validation/current'));
await mkdir(output, { recursive: true });
const gltf = await loadAvatarFixture(), rig = new Air3AvatarRig(gltf);
const holder = new THREE.Group(); holder.add(gltf.scene); holder.rotation.y = .46; holder.scale.setScalar(1.13); holder.position.set(1, .1, -2);
holder.updateMatrixWorld(true); rig.setMicroExpressionsEnabled(false);
const camera = new THREE.PerspectiveCamera(); rig.setCameraTarget(camera);
const target = new THREE.Vector3(), direction = new THREE.Vector3(), eyePoint = new THREE.Vector3();
const report = { schema: 'air3.attention-qa.v1', date: new Date().toISOString(),
  glbSha256: createHash('sha256').update(await readFile(resolve(serviceRoot, 'public/assets/air3/models/AIR3-runtime.glb'))).digest('hex'),
  runtime: process.version, platform: process.platform, tests: [], passed: false,
  scope: 'Actual delivered skeleton/animations; texture-free Node load; angular errors are bone optical axes, not a pixel-based likeness score',
  stageTransform: { position: holder.position.toArray(), scale: holder.scale.toArray(), rotationY: holder.rotation.y } };
report.sources = {};
for (const path of ['public/air3-avatar.mjs', 'public/air3-attention.mjs', 'public/air3-face.mjs']) {
  report.sources[path] = { sha256: createHash('sha256').update(await readFile(resolve(serviceRoot, path))).digest('hex') };
}
try {
  for (const clip of gltf.animations) for (const [cameraName, local] of Object.entries({ front: [0, 1.58, 3], left: [-1.2, 1.65, 3], right: [1.2, 1.75, 3] })) {
    rig.setClip(clip.name, { immediate: true }); rig.setTime(0);
    rig.attention.time = 0; rig.clearAttentionTarget();
    camera.position.copy(holder.localToWorld(new THREE.Vector3(...local)));
    let maxError = 0, sumError = 0, samples = 0, maxHeadYaw = 0, maxHeadPitch = 0;
    for (let frame = 0; frame < 240; frame++) {
      rig.update(1 / 60);
      if (frame < 120) continue;
      for (const eye of rig.attention.eyes) {
        direction.set(0, 1, 0).transformDirection(eye.matrixWorld);
        eye.getWorldPosition(eyePoint); target.subVectors(camera.position, eyePoint).normalize();
        const error = direction.angleTo(target) * 180 / Math.PI;
        maxError = Math.max(maxError, error); sumError += error; samples++;
      }
      const d = rig.attention.diagnostics();
      maxHeadYaw = Math.max(maxHeadYaw, Math.abs(d.headYawDegrees)); maxHeadPitch = Math.max(maxHeadPitch, Math.abs(d.headPitchDegrees));
    }
    const row = { clip: clip.name, camera: cameraName, samples, maxEyeErrorDegrees: maxError, meanEyeErrorDegrees: sumError / samples,
      maxHeadYawDegrees: maxHeadYaw, maxHeadPitchDegrees: maxHeadPitch };
    report.tests.push(row);
    assert.ok(maxError < 4, `Tracking error under 4 degrees for ${clip.name}/${cameraName}: ${maxError}`);
  }
  report.passed = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  rig.dispose(); await writeFile(resolve(output, 'camera-attention-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, combinations: report.tests.length,
    maxEyeErrorDegrees: Math.max(...report.tests.map(row => row.maxEyeErrorDegrees)), output, error: report.error }));
}
