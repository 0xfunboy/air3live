import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { loadAvatarFixture } from './fixtures/avatar-fixture.mjs';
import { Air3AvatarRig } from '../public/air3-avatar.mjs';
import { createAir3Hair } from '../public/air3-hair.mjs';
import { createHairWardrobe, HAIR_COLORS } from '../public/air3-hair-wardrobe.mjs';

async function setup() {
  const gltf = await loadAvatarFixture(), root = gltf.scene;
  root.traverse(n => { if (n.isMesh && n.material.name === 'face__MI_HeadSynthesized_Baked') n.userData.air3Surface = 'skin-face'; });
  const geometryBefore = [];
  const legacyHair = createAir3Hair(root, { quality: 'software' });
  const rig = new Air3AvatarRig(gltf); rig.setTime(.6); rig.update(0);
  const holder = new THREE.Group(); holder.scale.setScalar(1.08); holder.rotation.y = .7; holder.position.set(2, .1, -3); holder.add(root); holder.updateMatrixWorld(true);
  const loader = { manager: undefined, async loadAsync(url) {
    const filename = url.split('/').pop(), bytes = await readFile(new URL('../public/assets/air3/hair/' + filename, import.meta.url));
    return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  } };
  const textures = [], textureLoader = { async loadAsync(url) { const texture = new THREE.Texture(); texture.name = url; texture.userData.disposed = false;
    texture.addEventListener('dispose', () => { texture.userData.disposed = true; }); textures.push(texture); return texture; } };
  root.traverse(n => { if (n.isMesh && !n.name.startsWith('air3_hair_')) geometryBefore.push([n.geometry, Buffer.from(n.geometry.attributes.position.array.buffer).toString('base64')]); });
  return { root, holder, rig, legacyHair, geometryBefore, loader, textureLoader, textures };
}

test('imported hair follows immutable head binding after animation and presentation scaling; switching preserves avatar', async () => {
  const fixture = await setup();
  const hair = await createHairWardrobe(fixture.root, { ...fixture, style: 'wavy', color: 'chestnut', quality: 'software' });
  assert.deepEqual(hair.root.matrix.elements, fixture.legacyHair.root.matrix.elements);
  assert.equal(hair.root.parent.name, 'body__head');
  assert.equal(fixture.legacyHair.root.visible, false);
  assert.equal(hair.getState().triangles, 4922);
  for (const [geometry, bytes] of fixture.geometryBefore) assert.ok(Buffer.from(geometry.attributes.position.array.buffer).toString('base64') === bytes, 'Loading hair leaves avatar positions unchanged');
  const bind = hair.root.matrix.clone(), meshes = [];
  hair.root.traverse(n => { if (n.isSkinnedMesh) meshes.push(n); });
  assert.equal(meshes.length, 7);
  for (let step = 0; step < 120; step++) {
    fixture.rig.update(1 / 60); hair.update(1 / 60); fixture.holder.updateMatrixWorld(true);
    for (const mesh of meshes) {
      mesh.skeleton.update(); const vertex = mesh.getVertexPosition(0, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
      assert.ok(vertex.toArray().every(Number.isFinite));
      const head = hair.root.parent.getWorldPosition(new THREE.Vector3());
      assert.ok(vertex.distanceTo(head) < 1, 'Hair stays attached to head through the animated pose');
    }
  }
  assert.deepEqual(hair.root.matrix.elements, bind.elements, 'No iterative reattachment drift');
  // The facial rig intentionally updates eyelash positions during blinks;
  // compare wardrobe changes against the completed animated frame.
  for (const row of fixture.geometryBefore) row[1] = Buffer.from(row[0].attributes.position.array.buffer).toString('base64');
  await hair.setStyle('artemis'); assert.equal(hair.getState().triangles, 5455); assert.equal(hair.getState().commercial, false);
  await hair.setColor('blonde');
  const artemis = fixture.root.getObjectByName('air3_hair_artemis');
  let material; artemis.traverse(n => { if (n.isMesh) material = n.material; });
  assert.equal(material.map.flipY, true, 'Raw FBX color atlas is vertically opposite the GLB-exported atlas');
  assert.equal(material.alphaMap.flipY, true, 'Raw FBX alpha is aligned with the color atlas');
  assert.equal(material.normalMap.flipY, false, 'Extracted GLB normal keeps GLB orientation');
  assert.equal(hair.getState().residentColorAtlases, 1);
  await hair.setColor('black'); assert.equal(hair.getState().color, 'black');
  assert.equal(fixture.textures.filter(t => /artemis-.*\.webp/.test(t.name) && !t.userData.disposed).length, 1);
  await hair.setStyle('legacy'); assert.equal(hair.getState().style, 'legacy'); assert.equal(fixture.legacyHair.root.visible, true);
  assert.equal(hair.getState().triangles, 59282);
  for (const [geometry, bytes] of fixture.geometryBefore) assert.ok(Buffer.from(geometry.attributes.position.array.buffer).toString('base64') === bytes, 'Existing avatar positions unchanged');
  await assert.rejects(hair.setStyle('unknown'), /Unknown/); await assert.rejects(hair.setColor('unknown'), /Unknown/);
  hair.dispose(); hair.dispose(); fixture.rig.dispose();
  await Promise.resolve();
  assert.ok(fixture.textures.every(t => t.userData.disposed), 'All wardrobe-owned maps released');
});

test('failed and racing hairstyle loads preserve a valid visible style and latest user choice', async () => {
  const fixture = await setup(), loader = fixture.loader;
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  fixture.loader = { async loadAsync(url) { if (url.endsWith('artemis.glb')) await waiting; return loader.loadAsync(url); } };
  const hair = await createHairWardrobe(fixture.root, { ...fixture, style: 'legacy', color: 'chestnut' });
  const first = hair.setStyle('artemis'); await hair.setStyle('wavy'); release(); await first;
  assert.equal(hair.getState().style, 'wavy');
  const visible = hair.root.children.filter(child => child.visible); assert.equal(visible.length, 1); assert.equal(visible[0].name, 'air3_hair_wavy');
  hair.dispose(); fixture.rig.dispose();
  const failed = await setup(); failed.loader = { async loadAsync() { throw new Error('asset offline'); } };
  const fallback = await createHairWardrobe(failed.root, { ...failed, style: 'legacy', color: 'chestnut' });
  await assert.rejects(fallback.setStyle('wavy'), /offline/);
  assert.equal(fallback.getState().style, 'legacy'); assert.equal(failed.legacyHair.root.visible, true);
  fallback.dispose(); failed.rig.dispose();
});

test('espresso is an intermediate colour, reuses the authored atlas and keeps brows in sync with successful choices', async () => {
  const fixture = await setup(), colors = Object.fromEntries(HAIR_COLORS.map(c => [c.id, c.tint]));
  const midpoint = new THREE.Color(colors.black).lerp(new THREE.Color(colors['dark-brown']), .5);
  const espresso = new THREE.Color(colors.espresso);
  for (const component of ['r', 'g', 'b']) assert.ok(Math.abs(midpoint[component] - espresso[component]) < .0015, 'sRGB encoded intermediate stays within 8-bit rounding');
  const browColors = []; fixture.root.userData.air3Materials = { setHairColor: hex => browColors.push(hex) };
  const hair = await createHairWardrobe(fixture.root, { ...fixture, style: 'artemis', color: 'espresso' });
  assert.equal(browColors.at(-1), colors.espresso);
  let material; fixture.root.getObjectByName('air3_hair_artemis').traverse(n => { if (n.isMesh) material = n.material; });
  const atlas = material.map;
  assert.ok(atlas.name.endsWith('artemis-dark-brown.webp'));
  assert.ok(material.color.r < 1 && material.color.g < 1, 'Intermediate tone is applied to the shared brown atlas');
  await hair.setColor('dark-brown'); assert.equal(material.map, atlas, 'Changing the tint reuses the same pixels');
  assert.deepEqual(material.color.toArray(), [1, 1, 1]);
  assert.equal(browColors.at(-1), colors['dark-brown']);
  await assert.rejects(hair.setColor('invalid'), /Unknown/);
  assert.equal(browColors.at(-1), colors['dark-brown'], 'Rejected selection leaves eyebrows unchanged');
  await hair.setColor('espresso'); await hair.setStyle('wavy');
  assert.equal(hair.diagnostics().browColorLinked, true);
  assert.equal(hair.diagnostics().colorSrgb, colors.espresso);
  assert.ok(!fixture.textures.some(t => t.name.includes('artemis-espresso')), 'No invented or missing seventh authored map');
  hair.dispose(); fixture.rig.dispose();
});

test('soft hair lag stays bounded and gives similar motion at 30 and 60 updates per second', async () => {
  async function sample(dt) {
    const fixture = await setup();
    const hair = await createHairWardrobe(fixture.root, { ...fixture, style: 'wavy', color: 'espresso' });
    const head = hair.root.parent, base = head.quaternion.clone(), axis = new THREE.Vector3(0, 1, 0);
    let maxLag = 0;
    for (let frame = 1; frame <= Math.round(3 / dt); frame++) {
      head.quaternion.copy(base).multiply(new THREE.Quaternion().setFromAxisAngle(axis, .45 * Math.sin(frame * dt * 1.7)));
      hair.update(dt);
      const lag = hair.diagnostics().softness.angularLagRadians;
      assert.ok(lag.every(Number.isFinite)); maxLag = Math.max(maxLag, ...lag.map(Math.abs));
    }
    const state = hair.diagnostics();
    assert.ok(maxLag <= state.softness.maximumLagRadians);
    assert.ok(maxLag > .001, 'Head movement creates a visible but bounded secondary response');
    assert.equal(state.softness.frontRootsFixed, true);
    hair.dispose(); fixture.rig.dispose(); return state.softness.angularLagRadians;
  }
  const slow = await sample(1 / 30), fast = await sample(1 / 60);
  assert.ok(Math.hypot(slow[0] - fast[0], slow[1] - fast[1]) < .003, 'Lag is driven by rotation rate instead of frame count');
});
