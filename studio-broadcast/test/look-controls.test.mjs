import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { defaultLook, parseLookPreset, serializeLookPreset } from '../public/look-presets.mjs';
import { StudioLighting } from '../public/studio-lighting.mjs';
import { LookController, loadInitialLook } from '../public/look-controller.mjs';

const renderer = () => ({ toneMappingExposure: 1, shadowMap: { needsUpdate: false } });
test('five conical lights remain independently adjustable, with world-space presenter targeting', () => {
  const scene = new THREE.Scene(), r = renderer(), lighting = new StudioLighting(scene, r, { origin: [-.75, .005, .65], quality: { name: 'high', shadowSize: 1024 } });
  assert.equal(lighting.spots.length, 5);
  assert.ok(lighting.spots.every(({ light }) => light.isSpotLight && light.decay === 2));
  const preset = lighting.getState(), unchangedKeyIntensity = preset.lights[0].intensity; preset.lights[1].intensity = 53; preset.lights[1].azimuth = 90;
  preset.environment = .1; preset.ambient = .02; preset.exposure = .9;
  lighting.setState(preset); lighting.update(new THREE.Vector3(2, 0, -1));
  assert.equal(lighting.spots[1].light.intensity, 53); assert.equal(lighting.spots[0].light.intensity, unchangedKeyIntensity);
  assert.equal(scene.environmentIntensity, .1); assert.equal(lighting.ambient.intensity, .02); assert.equal(r.toneMappingExposure, .9);
  for (const { light } of lighting.spots) assert.deepEqual(light.target.position.toArray(), [2, 1.35, -1]);
  assert.ok(Math.abs(lighting.spots[1].light.position.x - (-.75 + preset.lights[1].radius)) < 1e-8);
  lighting.dispose(); assert.equal(scene.children.length, 0);
});

test('clean output excludes cone guides and software shadow budget does not disable lights', () => {
  const lighting = new StudioLighting(new THREE.Scene(), renderer(), { cleanOutput: true, quality: { name: 'software', shadowSize: 512 } });
  const preset = lighting.getState(); for (const row of preset.lights) row.shadows = true;
  lighting.setState(preset); lighting.setGuides(true);
  assert.equal(lighting.diagnostics().actualShadowLights, 1);
  assert.ok(lighting.spots.every(row => row.light.intensity > 0 && !row.helper.visible));
  lighting.dispose();
});

test('shipped preset and exact decimal settings round-trip, malformed imports cannot change a light', async () => {
  const shipped = parseLookPreset(await readFile(new URL('../public/assets/air3/presets/default-look.json', import.meta.url), 'utf8'));
  shipped.lighting.lights[3].intensity = 19.37; shipped.lighting.lights[2].height = 3.127;
  assert.deepEqual(parseLookPreset(serializeLookPreset(shipped)), shipped);
  const lighting = new StudioLighting(new THREE.Scene(), renderer()); const before = lighting.getState();
  for (const mutate of [x => { x.lights[0].radius = -1; }, x => { x.environment = NaN; }, x => { x.lights.pop(); }, x => { x.lights[2].id = 'key'; }]) {
    const bad = lighting.getState(); mutate(bad); assert.throws(() => lighting.setState(bad)); assert.deepEqual(lighting.getState(), before);
  }
  const external = defaultLook(); external.hair.url = 'https://example.test/model.glb'; assert.throws(() => parseLookPreset(JSON.stringify(external)));
  assert.throws(() => parseLookPreset(' '.repeat(32769)));
  lighting.dispose();
});

test('preset imports, asset selections and local persistence agree on the actual applied state', async () => {
  const scene = new THREE.Scene(), lighting = new StudioLighting(scene, renderer());
  const hairState = { style: 'legacy', color: 'chestnut' }, footwearState = { style: 'original' };
  const hair = { getState: () => ({ ...hairState }), async setStyle(style) { hairState.style = style; }, async setColor(color) { hairState.color = color; } };
  const footwear = { getState: () => ({ ...footwearState }), async setStyle(style) { footwearState.style = style; } };
  const clothingState = { style: 'original' };
  const clothing = { getState: () => ({ ...clothingState }), async setStyle(style) { clothingState.style = style; } };
  const storage = new Map(), controller = new LookController({ lighting, hair, footwear, clothing, storage: { setItem: (k, v) => storage.set(k, v) } });
  const next = defaultLook(); next.hair = { style: 'wavy', color: 'blonde' }; next.footwear.style = 'boot'; next.lighting.ambient = .03;
  await controller.apply(next);
  assert.deepEqual(controller.getPreset(), next); assert.deepEqual(parseLookPreset([...storage.values()][0]), next);
  await controller.reset(); assert.deepEqual(controller.getPreset(), defaultLook());
  const bad = defaultLook(); bad.lighting.ambient = 400;
  assert.throws(() => controller.apply(bad)); assert.deepEqual(controller.getPreset(), defaultLook());
  controller.dispose(); lighting.dispose();
});

function controllerFixture({ beforeHair, failBoot = false, storage } = {}) {
  const lighting = new StudioLighting(new THREE.Scene(), renderer());
  const h = { style: 'legacy', color: 'chestnut' }, f = { style: 'original' }; let footwearCalls = 0;
  const controller = new LookController({ lighting,
    hair: { getState: () => ({ ...h }), async setStyle(style) { await beforeHair?.(); h.style = style; }, async setColor(color) { h.color = color; } },
    footwear: { getState: () => ({ ...f }), async setStyle(style) { footwearCalls++; if (failBoot && style === 'boot') throw new Error('Test asset unavailable'); f.style = style; } }, storage });
  return { controller, lighting, footwearCalls: () => footwearCalls, dispose() { controller.dispose(); lighting.dispose(); } };
}

test('independent queued hair and shoe edits merge, and in-flight light/name edits survive completion', async () => {
  const f = controllerFixture({ storage: { setItem() {} } });
  await Promise.all([f.controller.setHair('wavy', 'blonde'), f.controller.setFootwear('boot')]);
  assert.deepEqual(f.controller.getPreset().hair, { style: 'wavy', color: 'blonde' });
  assert.equal(f.controller.getPreset().footwear.style, 'boot'); f.dispose();
  let release, began; const gate = new Promise(r => { release = r; }), started = new Promise(r => { began = r; });
  const g = controllerFixture({ beforeHair: async () => { began(); await gate; }, storage: { setItem() {} } });
  const first = g.controller.setHair('artemis', 'black'); await started;
  const named = g.controller.setName('Il mio preset'); const lights = g.lighting.getState(); lights.ambient = .43;
  const lit = g.controller.setLighting(lights); release(); await Promise.all([first, named, lit]);
  const final = g.controller.getPreset(); assert.equal(final.name, 'Il mio preset'); assert.equal(final.lighting.ambient, .43);
  assert.deepEqual(final.hair, { style: 'artemis', color: 'black' }); assert.equal(g.controller.busy, false); g.dispose();
});

test('failed accessory import restores the previous complete look and does not persist a partial look', async () => {
  const saved = [], f = controllerFixture({ failBoot: true, storage: { setItem: (...args) => saved.push(args) } });
  const before = f.controller.getPreset(), next = defaultLook(); next.hair = { style: 'artemis', color: 'blonde' }; next.footwear.style = 'boot';
  await assert.rejects(f.controller.apply(next), /Test asset unavailable/);
  assert.deepEqual(f.controller.getPreset(), before); assert.equal(saved.length, 0); assert.equal(f.controller.busy, false);
  assert.match(f.controller.error, /Ripristinata/); f.dispose();
});

test('a browser denying localStorage can load the shipped preset without falsely reporting persistence', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage access denied'); } });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(defaultLook()), { status: 200 }));
  try {
    const loaded = await loadInitialLook(); assert.deepEqual(loaded.preset, defaultLook()); assert.equal(loaded.source, 'package');
    const f = controllerFixture(); await f.controller.setFootwear('original');
    assert.equal(f.controller.lastSaved, null); assert.match(f.controller.error, /Salvataggio locale non disponibile/); f.dispose();
  } finally { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else delete globalThis.localStorage; }
});

test('disposing a pending preset stops subsequent accessory work and never writes the preference', async () => {
  let release, began; const gate = new Promise(r => { release = r; }), started = new Promise(r => { began = r; });
  const saved = [], f = controllerFixture({ beforeHair: async () => { began(); await gate; }, storage: { setItem: (...args) => saved.push(args) } });
  const pending = f.controller.apply(defaultLook()); await started; f.controller.dispose(); release(); await pending;
  assert.equal(f.footwearCalls(), 0); assert.equal(saved.length, 0); f.lighting.dispose();
});

test('a superseded failed request cannot leave an error on the succeeding latest look', async () => {
  let release, began, calls = 0; const gate = new Promise(r => { release = r; }), started = new Promise(r => { began = r; });
  const f = controllerFixture({ beforeHair: async () => { if (++calls === 1) { began(); await gate; throw new Error('First request failed'); } }, storage: { setItem() {} } });
  const first = f.controller.setHair('artemis', 'black').catch(error => error); await started;
  const second = f.controller.setHair('wavy', 'blonde'); release();
  assert.match((await first).message, /First request failed/); await second;
  assert.deepEqual(f.controller.getPreset().hair, { style: 'wavy', color: 'blonde' }); assert.equal(f.controller.error, null);
  f.dispose();
});
