import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import {
  BOOT_FITS, CLOTHING_STYLES, DEFAULT_LOOK_URL, LEGACY_LOOK_SCHEMA,
  LOOK_SCHEMA, LOOK_STORAGE_KEY, defaultLook, parseLookPreset, serializeLookPreset,
} from '../public/look-presets.mjs';
import { LookController, loadInitialLook } from '../public/look-controller.mjs';
import { StudioLighting } from '../public/studio-lighting.mjs';

const sourcePreference = new URL('../../source-assets/user-preferences/look-user-2026-10-25.json', import.meta.url);
const shippedPreference = new URL('../public/assets/air3/presets/default-look.json', import.meta.url);
const json = async url => JSON.parse(await readFile(url, 'utf8'));
const copy = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(t, { beforeHair, beforeFootwear, beforeClothing, withClothing = true, initialClothing } = {}) {
  const initial = defaultLook(), lighting = new StudioLighting(new THREE.Scene(), { toneMappingExposure: 1, shadowMap: { needsUpdate: false } });
  if (initialClothing) initial.clothing.style = initialClothing;
  lighting.setState(initial.lighting);
  const hair = copy(initial.hair), footwear = copy(initial.footwear), clothing = copy(initial.clothing), calls = [], writes = [];
  const controller = new LookController({ lighting, source: 'package', shipped: initial,
    storage: { setItem(key, text) { writes.push({ key, preset: parseLookPreset(text) }); } },
    hair: {
      getState: () => copy(hair),
      async setStyle(style) { calls.push(['hair', style]); await beforeHair?.(style); hair.style = style; },
      async setColor(color) { calls.push(['color', color]); hair.color = color; },
    },
    footwear: {
      getState: () => copy(footwear),
      async setStyle(style, { fit }) { calls.push(['footwear', style, fit]); await beforeFootwear?.(style, fit); footwear.style = style; footwear.fit = fit; },
    },
    clothing: withClothing ? {
      getState: () => copy(clothing),
      async setStyle(style) { calls.push(['clothing', style]); await beforeClothing?.(style); clothing.style = style; },
    } : undefined,
  });
  t.after(() => { controller.dispose(); lighting.dispose(); });
  return { controller, lighting, calls, writes };
}

test('v2 source and packaged defaults retain every user light value and the requested appearance', async () => {
  const [source, packaged] = await Promise.all([json(sourcePreference), json(shippedPreference)]);
  assert.equal(source.schema, LEGACY_LOOK_SCHEMA);
  assert.equal(packaged.schema, LOOK_SCHEMA);
  assert.deepEqual(packaged.lighting, source.lighting, 'The supplied light directions, colours, shadows and exact decimals must all survive');
  assert.deepEqual(defaultLook(), parseLookPreset(JSON.stringify(packaged)));
  assert.deepEqual(packaged.hair, { style: 'wavy', color: 'espresso' });
  assert.deepEqual(packaged.footwear, { style: 'boot', fit: 'relaxed' });
  assert.deepEqual(packaged.clothing, { style: 'crop' });
});

test('v1 import migrates new wardrobe fields without rewriting the saved hair or light choices', async () => {
  const source = await json(sourcePreference), untouched = copy(source);
  const migrated = parseLookPreset(JSON.stringify(source));
  assert.equal(migrated.schema, LOOK_SCHEMA);
  assert.deepEqual(migrated.hair, source.hair);
  assert.deepEqual(migrated.lighting, source.lighting);
  assert.deepEqual(migrated.footwear, { style: source.footwear.style, fit: 'relaxed' });
  assert.deepEqual(migrated.clothing, { style: 'original' });
  assert.deepEqual(parseLookPreset(serializeLookPreset(source)), migrated);
  assert.deepEqual(source, untouched);
  const unsupportedLegacy = copy(source); unsupportedLegacy.clothing = { style: 'crop' };
  assert.throws(() => parseLookPreset(JSON.stringify(unsupportedLegacy)), /campo sconosciuto/);
});

test('v2 storage starts the new appearance, honours v2 custom looks and reset, and imports v1 separately', async t => {
  const source = await json(sourcePreference), shipped = defaultLook(), custom = defaultLook();
  custom.name = 'La mia prova'; custom.clothing.style = 'crop'; custom.footwear.fit = 'low-cut'; custom.hair.color = 'black';
  const data = new Map([[LEGACY_LOOK_SCHEMA, JSON.stringify(source)]]), reads = [], requests = [];
  const storage = { getItem(key) { reads.push(key); return data.get(key); } };
  t.mock.method(globalThis, 'fetch', async (url, options) => { requests.push({ url, options }); return new Response(serializeLookPreset(shipped)); });
  const fresh = await loadInitialLook({ storage, query: '' });
  assert.deepEqual(fresh, { preset: shipped, shipped, source: 'package' });
  assert.deepEqual(reads, [LOOK_STORAGE_KEY], 'Old browser preferences deliberately do not override the new packaged default');
  data.set(LOOK_STORAGE_KEY, serializeLookPreset(custom));
  const saved = await loadInitialLook({ storage, query: '' });
  assert.deepEqual(saved, { preset: custom, shipped, source: 'browser' });
  const beforeResetReads = reads.length;
  const reset = await loadInitialLook({ storage, query: '?resetLook=1' });
  assert.deepEqual(reset, { preset: shipped, shipped, source: 'package' });
  assert.equal(reads.length, beforeResetReads);
  assert.deepEqual(parseLookPreset(data.get(LEGACY_LOOK_SCHEMA)).lighting, source.lighting);
  assert.ok(requests.every(({ url, options }) => url === DEFAULT_LOOK_URL && options.cache === 'no-store'));
});

test('all v2 clothing and boot-fit combinations round-trip and reach their asset controllers', async t => {
  const f = fixture(t);
  for (const style of CLOTHING_STYLES) for (const fit of BOOT_FITS) {
    const preset = defaultLook(); preset.clothing.style = style; preset.footwear.fit = fit;
    await f.controller.apply(preset);
    assert.deepEqual(f.controller.getPreset(), preset);
    assert.deepEqual(parseLookPreset(f.controller.export()), preset);
    assert.deepEqual(f.writes.at(-1), { key: LOOK_STORAGE_KEY, preset });
    assert.ok(f.calls.some(call => call[0] === 'footwear' && call[1] === 'boot' && call[2] === fit));
    assert.ok(f.calls.some(call => call[0] === 'clothing' && call[1] === style));
  }
  await f.controller.setFootwear('original', 'low-cut');
  await f.controller.setFootwear('boot');
  assert.deepEqual(f.controller.getPreset().footwear, { style: 'boot', fit: 'low-cut' }, 'Trying sneakers must retain the chosen boot fit');
});

test('invalid new fields reject atomically before changing any accessory or light', t => {
  const f = fixture(t), before = f.controller.getPreset();
  for (const mutate of [
    value => { value.clothing.style = 'external'; },
    value => { value.clothing.url = 'https://example.test/shirt.glb'; },
    value => { value.footwear.fit = 'tall'; },
    value => { delete value.footwear.fit; },
    value => { delete value.clothing; },
  ]) {
    const invalid = defaultLook(); invalid.hair.color = 'blonde'; invalid.lighting.exposure = 1.2; mutate(invalid);
    assert.throws(() => f.controller.apply(invalid));
    assert.deepEqual(f.controller.getPreset(), before);
    assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0); assert.equal(f.controller.busy, false);
  }
});

test('in-flight hair, clothing, fit, name and exact lighting edits merge into one final persisted look', async t => {
  const gate = deferred(), began = deferred(); let hairCalls = 0;
  const f = fixture(t, { beforeHair: async () => { if (++hairCalls === 1) { began.resolve(); await gate.promise; } } });
  const hair = f.controller.setHair('artemis', 'black'); await began.promise;
  const clothes = f.controller.setClothing('crop');
  const shoes = f.controller.setFootwear('boot', 'low-cut');
  const nextLight = f.lighting.getState(); nextLight.exposure = 1.173; nextLight.lights[2].intensity = 7.283;
  const lights = f.controller.setLighting(nextLight);
  const name = f.controller.setName('Luce personale');
  gate.resolve(); await Promise.all([hair, clothes, shoes, lights, name]);
  const expected = defaultLook(); expected.hair = { style: 'artemis', color: 'black' }; expected.clothing.style = 'crop';
  expected.footwear.fit = 'low-cut'; expected.lighting = nextLight; expected.name = 'Luce personale';
  assert.deepEqual(f.controller.getPreset(), expected);
  assert.deepEqual(f.writes, [{ key: LOOK_STORAGE_KEY, preset: expected }], 'Only the final complete selection may be saved');
  assert.equal(f.controller.busy, false); assert.equal(f.controller.error, null);
});

test('failed crop loading rolls back earlier successful hair and boot-fit changes without partial persistence', async t => {
  const f = fixture(t, { initialClothing: 'original', beforeClothing(style) { if (style === 'crop') throw new Error('Crop GLB unavailable'); } });
  const before = f.controller.getPreset(), next = defaultLook();
  next.hair = { style: 'artemis', color: 'blonde' }; next.footwear.fit = 'low-cut'; next.clothing.style = 'crop'; next.lighting.exposure = 1.25;
  await assert.rejects(f.controller.apply(next), /Crop GLB unavailable/);
  assert.ok(f.calls.some(call => call[0] === 'footwear' && call[2] === 'low-cut'), 'The test must reach a partial asset change before failure');
  assert.deepEqual(f.controller.getPreset(), before);
  assert.equal(f.writes.length, 0); assert.equal(f.controller.busy, false); assert.equal(f.controller.source, 'package');
  assert.match(f.controller.error, /Ripristinata la configurazione precedente/);
});

test('a superseded crop failure cannot erase the later boot-fit choice or leave a stale error', async t => {
  const gate = deferred(), began = deferred();
  const f = fixture(t, { initialClothing: 'original', beforeClothing: async style => { if (style === 'crop') { began.resolve(); await gate.promise; throw new Error('Old crop request failed'); } } });
  const first = f.controller.setClothing('crop').catch(error => error); await began.promise;
  const fit = f.controller.setFootwear('boot', 'low-cut');
  const restored = f.controller.setClothing('original');
  gate.resolve(); assert.match((await first).message, /Old crop request failed/);
  await Promise.all([fit, restored]);
  const expected = defaultLook(); expected.footwear.fit = 'low-cut'; expected.clothing.style = 'original';
  assert.deepEqual(f.controller.getPreset(), expected);
  assert.deepEqual(f.writes, [{ key: LOOK_STORAGE_KEY, preset: expected }]);
  assert.equal(f.controller.busy, false); assert.equal(f.controller.error, null);
});

test('missing clothing controller rejects crop and restores changed assets', async t => {
  const f = fixture(t, { withClothing: false }), before = f.controller.getPreset(), next = defaultLook();
  next.hair.color = 'blonde'; next.footwear.fit = 'low-cut'; next.clothing.style = 'crop';
  await assert.rejects(f.controller.apply(next), /Controller maglietta non disponibile/);
  assert.deepEqual(f.controller.getPreset(), before); assert.equal(f.writes.length, 0);
});

test('disposal during a boot change prevents later clothing work and persistence', async t => {
  const gate = deferred(), began = deferred();
  const f = fixture(t, { beforeFootwear: async () => { began.resolve(); await gate.promise; } });
  const next = defaultLook(); next.footwear.fit = 'low-cut'; next.clothing.style = 'crop';
  const pending = f.controller.apply(next); await began.promise; f.controller.dispose(); gate.resolve(); await pending;
  assert.ok(!f.calls.some(call => call[0] === 'clothing')); assert.equal(f.writes.length, 0);
});

test('studio and character HTML both select Leggermente felice at full intensity', async () => {
  for (const [path, selectId, intensityId] of [
    ['../public/index.html', 'studio-emotion', 'emotion-intensity'],
    ['../public/preview/index.html', 'emotion', 'intensity'],
  ]) {
    const html = await readFile(new URL(path, import.meta.url), 'utf8');
    const select = html.match(new RegExp(`<select\\b[^>]*\\bid="${selectId}"[^>]*>([\\s\\S]*?)<\\/select>`))?.[1];
    assert.ok(select, `${path}: expression selector exists`);
    const selected = [...select.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)].filter(row => /\bselected\b/.test(row[1]));
    assert.equal(selected.length, 1); assert.match(selected[0][1], /\bvalue="happy"/); assert.equal(selected[0][2], 'Leggermente felice');
    const input = [...html.matchAll(/<input\b[^>]*>/g)].map(match => match[0]).find(tag => tag.includes(`id="${intensityId}"`));
    assert.match(input, /\bvalue="1"/);
  }
});
