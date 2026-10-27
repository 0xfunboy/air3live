import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { loadAvatarFixture } from './fixtures/avatar-fixture.mjs';
import { createAir3Hair } from '../public/air3-hair.mjs';

test('replacement ponytail preserves source geometry and follows the calibrated head bind transform', async () => {
  const gltf = await loadAvatarFixture(), root = gltf.scene;
  let face, oldHair;
  root.traverse(node => {
    if (node.isMesh && node.material.name === 'face__MI_HeadSynthesized_Baked') { face = node; node.userData.air3Surface = 'skin-face'; }
    if (node.isMesh && node.name.startsWith('hair__')) oldHair = node;
  });
  const before = Buffer.from(face.geometry.attributes.position.array.buffer).toString('base64');
  root.position.set(1, 0, -2); root.scale.setScalar(1.2); root.updateMatrixWorld(true);
  const hair = createAir3Hair(root, { quality: 'software' });
  assert.equal(oldHair.visible, false);
  assert.equal(hair.root.parent.name, 'body__head');
  assert.equal(hair.diagnostics().sourceGeometryModified, false);
  assert.ok(hair.diagnostics().triangles > 12000 && hair.diagnostics().triangles < 60000);
  root.updateMatrixWorld(true);
  const sourceToHair = hair.root.matrixWorld.clone().invert().multiply(root.matrixWorld);
  const identity = new THREE.Matrix4();
  assert.ok(sourceToHair.elements.every((v, i) => Math.abs(v - identity.elements[i]) < 1e-6));
  const bind = hair.root.matrix.clone();
  const head = hair.root.parent; head.rotateX(.25); root.updateMatrixWorld(true); hair.update(1 / 60);
  assert.deepEqual(hair.root.matrix.elements, bind.elements, 'No reattachment drift while the head rotates');
  assert.equal(Buffer.from(face.geometry.attributes.position.array.buffer).toString('base64'), before);
  for (const mesh of hair.root.children) {
    assert.ok([...mesh.geometry.attributes.position.array].every(Number.isFinite));
    assert.ok(mesh.customDepthMaterial && mesh.customDistanceMaterial, 'Alpha-consistent shadows exist');
  }
  const fringe = hair.root.children.find(mesh => mesh.name.includes('face framing'));
  assert.ok(fringe, 'Temple locks are present');
  const positions = fringe.geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    if (positions.getY(i) > 1.53) assert.ok(Math.abs(positions.getX(i)) > .044,
      'The new framing locks stay outside the central forehead and pupil region in bind space');
  }
  for (let i = 0; i < 100; i++) hair.update(i % 2 ? .016 : 10000);
  hair.dispose(); hair.dispose();
  assert.equal(oldHair.visible, true);
  assert.equal(root.userData.air3Hair, undefined);
});
