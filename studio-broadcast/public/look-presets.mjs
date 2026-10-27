// Shared, data-only preset schema. Imported presets cannot load external assets,
// execute code, or alter the presenter's anatomical proportions.
export const LOOK_SCHEMA = 'airewardrop.look.v2';
export const LEGACY_LOOK_SCHEMA = 'airewardrop.look.v1';
export const LOOK_STORAGE_KEY = 'airewardrop.look.live.v3';
export const DEFAULT_LOOK_URL = '/assets/air3/presets/default-look.json';
export const LIGHT_NAMES = Object.freeze(['Frontale destra · key', 'Laterale destra', 'Frontale sinistra · fill', 'Controluce sinistra', 'Controluce destra']);
export const LIGHT_IDS = Object.freeze(['key', 'side', 'fill', 'rim-left', 'rim-right']);
export const HAIR_STYLES = Object.freeze(['legacy', 'artemis', 'wavy']);
export const HAIR_COLORS = Object.freeze(['blonde', 'copper', 'auburn', 'chestnut', 'dark-brown', 'espresso', 'black']);
export const CLOTHING_STYLES = Object.freeze(['original', 'crop']);
export const BOOT_FITS = Object.freeze(['relaxed', 'low-cut']);
export const FOOTWEAR_STYLES = Object.freeze(['original', 'boot', 'shoes-test']);
export const DEFAULT_LIGHTING = Object.freeze({
  "ambient": 0,
  "environment": 0.17,
  "exposure": 0.95,
  "followPresenter": true,
  "lights": [
    {
      "id": "key",
      "enabled": true,
      "intensity": 17.5,
      "azimuth": 38,
      "radius": 3,
      "height": 3.2,
      "targetHeight": 1.35,
      "cone": 31,
      "penumbra": 0.65,
      "color": "#fff1df",
      "shadows": true
    },
    {
      "id": "side",
      "enabled": true,
      "intensity": 51,
      "azimuth": 96,
      "radius": 3.1,
      "height": 2.6,
      "targetHeight": 1.35,
      "cone": 34,
      "penumbra": 0.65,
      "color": "#353e9c",
      "shadows": true
    },
    {
      "id": "fill",
      "enabled": true,
      "intensity": 6.5,
      "azimuth": -42,
      "radius": 3.2,
      "height": 2.8,
      "targetHeight": 1.35,
      "cone": 38,
      "penumbra": 0.65,
      "color": "#fffde5",
      "shadows": true
    },
    {
      "id": "rim-left",
      "enabled": true,
      "intensity": 21.5,
      "azimuth": -135,
      "radius": 2.8,
      "height": 3.35,
      "targetHeight": 1.35,
      "cone": 30,
      "penumbra": 0.65,
      "color": "#04b1fb",
      "shadows": true
    },
    {
      "id": "rim-right",
      "enabled": true,
      "intensity": 20,
      "azimuth": 155,
      "radius": 3.1,
      "height": 3,
      "targetHeight": 1.35,
      "cone": 28,
      "penumbra": 0.65,
      "color": "#ffe4c5",
      "shadows": false
    }
  ]
});
export function defaultLook() {
  return { schema: LOOK_SCHEMA, name: 'Cinque spot · luce morbida',
    hair: { style: 'wavy', color: 'espresso' }, footwear: { style: 'boot', fit: 'relaxed' }, clothing: { style: 'crop' },
    lighting: structuredClone(DEFAULT_LIGHTING) };
}
function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: oggetto richiesto`);
}
function keys(value, allowed, path) {
  object(value, path);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${path}: campo sconosciuto ${key}`);
}
function number(value, min, max, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${path}: valore da ${min} a ${max}`);
  return value;
}
function bool(value, path) { if (typeof value !== 'boolean') throw new Error(`${path}: valore booleano richiesto`); return value; }
function choice(value, allowed, path) { if (!allowed.includes(value)) throw new Error(`${path}: scelta non valida`); return value; }
export function validateLighting(input) {
  keys(input, ['ambient', 'environment', 'exposure', 'followPresenter', 'lights'], 'Luci');
  if (!Array.isArray(input.lights) || input.lights.length !== 5) throw new Error('Sono richiesti esattamente cinque faretti');
  return {
    ambient: number(input.ambient, 0, 1.5, 'Luce ambiente'),
    environment: number(input.environment, 0, 2, 'Ambiente riflesso'),
    exposure: number(input.exposure, .2, 2.5, 'Esposizione'),
    followPresenter: bool(input.followPresenter, 'Puntamento'),
    lights: input.lights.map((light, i) => {
      keys(light, ['id', 'enabled', 'intensity', 'azimuth', 'radius', 'height', 'targetHeight', 'cone', 'penumbra', 'color', 'shadows'], `Faretto ${i + 1}`);
      if (light.id !== LIGHT_IDS[i]) throw new Error('Ordine o identità dei cinque faretti non valido');
      if (typeof light.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(light.color)) throw new Error('Colore del faretto non valido');
      return { id: light.id, enabled: bool(light.enabled, 'Acceso'),
        intensity: number(light.intensity, 0, 150, 'Intensità'), azimuth: number(light.azimuth, -180, 180, 'Angolo sul cerchio'),
        radius: number(light.radius, .7, 6, 'Distanza'), height: number(light.height, 1.6, 5, 'Altezza'),
        targetHeight: number(light.targetHeight, .2, 2, 'Altezza bersaglio'), cone: number(light.cone, 10, 75, 'Apertura cono'),
        penumbra: number(light.penumbra, 0, 1, 'Morbidezza'), color: light.color.toLowerCase(), shadows: bool(light.shadows, 'Ombre') };
    }),
  };
}
export function validateLookPreset(input) {
  object(input, 'Preset');
  const legacy = input.schema === LEGACY_LOOK_SCHEMA;
  keys(input, legacy ? ['schema', 'name', 'hair', 'footwear', 'lighting'] : ['schema', 'name', 'hair', 'footwear', 'clothing', 'lighting'], 'Preset');
  if (!legacy && input.schema !== LOOK_SCHEMA) throw new Error('Formato preset non riconosciuto');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || /[\u0000-\u001f]/.test(input.name)) throw new Error('Nome preset non valido');
  keys(input.hair, ['style', 'color'], 'Capelli'); keys(input.footwear, legacy ? ['style'] : ['style', 'fit'], 'Scarpe');
  if (!legacy) keys(input.clothing, ['style'], 'Maglietta');
  return { schema: LOOK_SCHEMA, name: input.name.trim(),
    hair: { style: choice(input.hair.style, HAIR_STYLES, 'Acconciatura'), color: choice(input.hair.color, HAIR_COLORS, 'Colore capelli') },
    footwear: { style: choice(input.footwear.style, FOOTWEAR_STYLES, 'Scarpe'), fit: legacy ? 'relaxed' : choice(input.footwear.fit, BOOT_FITS, 'Gambale') },
    clothing: { style: legacy ? 'original' : choice(input.clothing.style, CLOTHING_STYLES, 'Maglietta') },
    lighting: validateLighting(input.lighting) };
}
export function parseLookPreset(text) {
  if (typeof text !== 'string' || text.length > 32768) throw new Error('Preset troppo grande (massimo 32 KB)');
  return validateLookPreset(JSON.parse(text));
}
export function serializeLookPreset(value) { return JSON.stringify(validateLookPreset(value), null, 2) + '\n'; }
