import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createAir3Hair } from './air3-hair.mjs';

const PROFILE = 'air3-imported-hair-2026-10-25-v2-espresso';
export const HAIR_STYLES = Object.freeze([
  { id: 'wavy', label: 'Coda ondulata', license: 'CC BY 4.0 · zHairezt', commercial: true, source: 'https://sketchfab.com/3d-models/wavy-white-ponytail-with-bones-d3e0ba8904504d6fb5e247346a4e93de' },
  { id: 'artemis', label: 'Artemis · prova non commerciale', license: 'CC BY-NC 4.0 · CT Reed / antoinepavia', commercial: false, source: 'https://sketchfab.com/3d-models/ponytail-1-artemis-character-hair-free-b15554b4b9934cd6adbcf8669f83f634' },
  { id: 'legacy', label: 'Coda corta AIR3', license: 'Derivata dai sorgenti del progetto', commercial: null },
]);
export const HAIR_COLORS = Object.freeze([
  { id: 'blonde', label: 'Biondo', tint: '#c6a774', authorTexture: 3 },
  { id: 'copper', label: 'Rame', tint: '#a86437', authorTexture: 1 },
  { id: 'auburn', label: 'Castano ramato', tint: '#7b3c21', authorTexture: 2 },
  { id: 'chestnut', label: 'Castano', tint: '#6e4a31', authorTexture: 4 },
  { id: 'dark-brown', label: 'Castano scuro', tint: '#4b321e', authorTexture: 5 },
  // Halfway between dark-brown and black in linear-light RGB, then encoded
  // back to sRGB. It is a reversible colour, not a new hair geometry or UV set.
  { id: 'espresso', label: 'Castano quasi nero', tint: '#3b2b21', authorTexture: 5, atlas: 'dark-brown' },
  { id: 'black', label: 'Nero naturale', tint: '#252323', authorTexture: 6 },
]);
const STYLE = Object.fromEntries(HAIR_STYLES.map(v => [v.id, v]));
const COLOR = Object.fromEntries(HAIR_COLORS.map(v => [v.id, v]));
const clamp = THREE.MathUtils.clamp;

// Affine fitting affects the replaceable hairstyle only. Avatar mesh, head,
// eye placement and skeleton proportions are never edited. Coordinates are
// the AIR3 source metre bind space used by the unchanged runtime GLB.
export const HAIR_FITS = Object.freeze({
  artemis: { scale: [.81, .81, .85], translation: [0, -.0339, -.015], ponytailLength: 1, fringeAngles: [.12, -.10, 0], fringeOffset: .045 },
  wavy: { scale: [.057, .057, .075], translation: [0, .5575, -.010], ponytailLength: .70 },
});

function dyeMaterial(material, colorUniform, referenceLuminance, key) {
  const before = material.onBeforeCompile, cacheKey = material.customProgramCacheKey();
  material.onBeforeCompile = shader => {
    before?.call(material, shader);
    shader.uniforms.air3HairDye = colorUniform;
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 air3HairDye;')
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        float air3HairDetail = clamp(dot(diffuseColor.rgb, vec3(.2126,.7152,.0722)) / ${referenceLuminance.toFixed(5)}, .22, 1.8);
        diffuseColor.rgb = air3HairDye * air3HairDetail;`);
  };
  material.customProgramCacheKey = () => `${cacheKey}:${PROFILE}:dye:${key}`;
  material.needsUpdate = true;
}

function countGeometry(group) {
  let triangles = 0, meshes = 0, joints = new Set();
  group.traverse(node => {
    if (node.isMesh) { meshes++; triangles += (node.geometry.index?.count || node.geometry.attributes.position.count) / 3; }
    node.skeleton?.bones.forEach(bone => joints.add(bone.uuid));
  });
  return { triangles, meshes, joints: joints.size };
}

/**
 * Adds a lazy-loaded wardrobe around the established head binding. Install
 * after createAir3Hair; the immutable binding lets this run before or after
 * the first animation frame and after presentation scaling.
 * A failed load preserves the previously visible style. Only one RGBA color
 * atlas is retained, shared by every Artemis card, never six resident atlases.
 */
export async function createHairWardrobe(root, { renderer, quality = 'high', legacyHair,
  loader = new GLTFLoader(), textureLoader = new THREE.TextureLoader(loader.manager), assetBase = '/assets/air3', style = 'wavy', color = 'espresso' } = {}) {
  if (!root?.isObject3D) throw new TypeError('Hair wardrobe requires the avatar root');
  if (!STYLE[style] || !COLOR[color]) throw new RangeError('Unknown hairstyle or hair color');
  legacyHair ||= createAir3Hair(root, { quality });
  const head = legacyHair.root.parent;
  if (!head?.isBone) throw new Error('Existing hair must be bound to the avatar head');
  const anchor = new THREE.Group(); anchor.name = 'air3_hair_wardrobe';
  anchor.matrix.copy(legacyHair.root.matrix); anchor.matrixAutoUpdate = false; head.add(anchor);
  const url = name => `${assetBase.replace(/\/$/, '')}/hair/${name}`;
  let activeStyle = 'legacy', activeColor = color, disposed = false, pendingStyle = null;
  let styleRequest = 0, colorRequest = 0, currentColorMap = null, currentColorId = null;
  let time = 0, previousHead = head.getWorldQuaternion(new THREE.Quaternion());
  const headQ = new THREE.Quaternion(), headDelta = new THREE.Quaternion();
  const motion = new THREE.Vector2(), velocity = new THREE.Vector2(), target = new THREE.Vector2();
  const styles = new Map(), loads = new Map(), maps = new Map(), materialSet = new Set();
  const dye = { value: new THREE.Color(COLOR[color].tint) };
  const espressoFilter = new THREE.Color(COLOR.espresso.tint), brownReference = new THREE.Color(COLOR['dark-brown'].tint);
  espressoFilter.r /= brownReference.r; espressoFilter.g /= brownReference.g; espressoFilter.b /= brownReference.b;
  const applyBrows = () => root.userData.air3Materials?.setHairColor?.(COLOR[activeColor].tint);
  const legacyCallbacks = [];
  legacyHair.root.traverse(node => {
    if (!node.isMesh) return;
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      legacyCallbacks.push({ material, before: material.onBeforeCompile, key: material.customProgramCacheKey });
      dyeMaterial(material, dye, node.userData.air3GeometricFibres ? .035 : .035, 'legacy');
    }
  });
  async function texture(name, srgb = false) {
    if (!maps.has(name)) maps.set(name, textureLoader.loadAsync(url(name)).then(map => {
      if (disposed) { map.dispose(); throw new Error('Hair wardrobe disposed'); }
      map.flipY = name === 'artemis-alpha.png'; map.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      map.anisotropy = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() || 1); return map;
    }));
    return maps.get(name);
  }
  function disposeObject(group) {
    const geometries = new Set(), skeletons = new Set(), materials = new Set();
    group.traverse(n => { if (n.geometry) geometries.add(n.geometry); if (n.skeleton) skeletons.add(n.skeleton);
      for (const m of Array.isArray(n.material) ? n.material : n.material ? [n.material] : []) materials.add(m);
      if (n.customDepthMaterial) materials.add(n.customDepthMaterial); if (n.customDistanceMaterial) materials.add(n.customDistanceMaterial); });
    for (const g of geometries) g.dispose(); for (const s of skeletons) s.dispose(); for (const m of materials) m.dispose();
    group.removeFromParent();
  }
  async function loadStyle(id) {
    if (styles.has(id)) return styles.get(id);
    if (loads.has(id)) return loads.get(id);
    const pending = (async () => {
      const gltf = await loader.loadAsync(url(id + '.glb'));
      if (disposed) { disposeObject(gltf.scene); throw new Error('Hair wardrobe disposed'); }
      const fit = HAIR_FITS[id], holder = new THREE.Group(); holder.name = 'air3_hair_' + id;
      holder.scale.fromArray(fit.scale); holder.position.fromArray(fit.translation); holder.add(gltf.scene);
      holder.visible = false; anchor.add(holder);
      let baseMap, alphaMap, normalMap;
      try {
        if (id === 'artemis') [alphaMap, normalMap] = await Promise.all([texture('artemis-alpha.png'), texture('artemis-normal.png')]);
        else baseMap = await texture('wavy-source.png', true);
      } catch (error) { disposeObject(holder); throw error; }
      if (disposed) { disposeObject(holder); throw new Error('Hair wardrobe disposed'); }
      const material = new THREE.MeshPhysicalMaterial({ name: 'AIR3 / ' + id, color: 0xffffff,
        map: baseMap || null, alphaMap: alphaMap || null, normalMap: normalMap || null,
        normalScale: new THREE.Vector2(.40, .40), metalness: 0, roughness: id === 'wavy' ? .82 : .78,
        ior: 1.5, specularIntensity: id === 'wavy' ? .09 : .12, envMapIntensity: .42,
        sheen: id === 'wavy' ? .12 : .05, sheenRoughness: .84, sheenColor: new THREE.Color('#807269'),
        anisotropy: quality === 'software' ? 0 : .28, anisotropyRotation: Math.PI / 2,
        alphaTest: id === 'wavy' ? .23 : .28, transparent: false, depthWrite: true,
        alphaToCoverage: quality !== 'software', side: THREE.DoubleSide, shadowSide: THREE.DoubleSide });
      materialSet.add(material); material.userData.air3Surface = 'hair';
      if (id === 'wavy') dyeMaterial(material, dye, .38, id);
      const motionBones = [], rest = new Map(), gains = new Map();
      gltf.scene.traverse(node => {
        if (node.isMesh) {
          for (const m of Array.isArray(node.material) ? node.material : [node.material]) m.dispose();
          node.material = material; node.frustumCulled = false; node.castShadow = node.receiveShadow = true;
          node.userData.air3Surface = 'hair'; node.userData.air3AlphaCutout = true;
          node.userData.air3NoAO = true;
          node.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking,
            map: baseMap || null, alphaMap: alphaMap || null, alphaTest: material.alphaTest, side: THREE.DoubleSide });
          node.customDistanceMaterial = new THREE.MeshDistanceMaterial({ map: baseMap || null,
            alphaMap: alphaMap || null, alphaTest: material.alphaTest, side: THREE.DoubleSide });
        }
        const tail = /hair_ponytail_[2-6]_/.test(node.name) || /^Pony_0[2-5]_/.test(node.name);
        const wavyTip = id === 'wavy' && /^Bang_0[23][LR]_/.test(node.name);
        if (node.isBone && !/_end_/i.test(node.name) && (tail || wavyTip)) {
          motionBones.push(node); rest.set(node, node.quaternion.clone());
          // Forehead roots remain fixed. Only middle/tip joints of the long
          // front locks have a very small response; the ponytail is looser.
          gains.set(node, wavyTip ? (/^Bang_03/.test(node.name) ? .13 : .09) : .35 + Math.min(4, motionBones.length - 1) * .085);
        }
      });
      if (id === 'artemis') {
        // A small lateral root adjustment and two opposed bends free the
        // pupil while the ends still fall downwards, not out like a rigid fan.
        const names = ['hair_bangs_1a_012', 'hair_bangs_1b_013', 'hair_bangs_1c_014'];
        names.forEach((name, index) => {
          const fringe = gltf.scene.getObjectByName(name); if (!fringe) return;
          gltf.scene.updateWorldMatrix(true, true);
          const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(gltf.scene.getWorldQuaternion(new THREE.Quaternion()))
            .applyQuaternion(fringe.parent.getWorldQuaternion(new THREE.Quaternion()).invert());
          fringe.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis.normalize(), fit.fringeAngles[index]));
          if (index === 0) {
            const parentFromSource = gltf.scene.matrixWorld.clone().invert().multiply(fringe.parent.matrixWorld).invert();
            const offset = new THREE.Vector3(fit.fringeOffset, 0, 0).applyMatrix3(new THREE.Matrix3().setFromMatrix4(parentFromSource));
            fringe.position.add(offset);
          }
        });
      }
      if (id === 'wavy') {
        const tailBase = gltf.scene.getObjectByName('Pony_01_01');
        if (tailBase) tailBase.scale.y *= fit.ponytailLength;
      }
      const entry = { id, holder, material, motionBones, rest, gains, ...countGeometry(holder) };
      styles.set(id, entry); return entry;
    })();
    loads.set(id, pending);
    try { return await pending; } catch (error) { loads.delete(id); throw error; }
  }
  async function applyColorAtlas(id, request) {
    if (disposed || request !== colorRequest) return null;
    const atlasId = COLOR[id].atlas || id;
    const tint = () => { const entry = styles.get('artemis');
      if (entry) entry.material.color.copy(id === 'espresso' ? espressoFilter : new THREE.Color(0xffffff)); };
    if (atlasId === currentColorId && currentColorMap) { tint(); return currentColorMap; }
    const next = await textureLoader.loadAsync(url('artemis-' + atlasId + '.webp'));
    if (disposed || request !== colorRequest) { next.dispose(); return null; }
    next.flipY = true; next.colorSpace = THREE.SRGBColorSpace;
    next.anisotropy = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() || 1);
    const previous = currentColorMap; currentColorMap = next; currentColorId = atlasId;
    const entry = styles.get('artemis');
    if (entry) { entry.material.map = next; entry.material.needsUpdate = true;
      // RGB atlas has no alpha: shadow silhouette is shared alphaMap alone.
    }
    tint();
    previous?.dispose(); return next;
  }
  function state() { return { pendingStyle,
    styles: HAIR_STYLES, colors: HAIR_COLORS, commercial: STYLE[activeStyle].commercial,
    license: STYLE[activeStyle].license, sourceGeometryModified: false, avatarGeometryModified: false,
    boundTo: head.name, originalHighBunHidden: true, ...(activeStyle === 'legacy' ? legacyHair.diagnostics() : {
      profile: PROFILE, triangles: styles.get(activeStyle)?.triangles || 0, meshes: styles.get(activeStyle)?.meshes || 0,
      joints: styles.get(activeStyle)?.joints || 0, fit: HAIR_FITS[activeStyle], secondaryMotion: 'critically damped ponytail and small front-tip lag; no collision solver' }),
    profile: PROFILE, style: activeStyle, color: activeColor, colorSrgb: COLOR[activeColor].tint,
    browColorLinked: typeof root.userData.air3Materials?.setHairColor === 'function',
    softness: { angularLagRadians: motion.toArray(), maximumLagRadians: .055, springFrequency: 5.5, frontRootsFixed: true },
    cachedStyles: [...styles.keys()], residentColorAtlases: currentColorMap ? 1 : 0 };
  }
  const api = { root: anchor, list: () => HAIR_STYLES, colors: () => HAIR_COLORS, getState: state, diagnostics: state,
    async setStyle(id) {
      if (disposed) throw new Error('Hair wardrobe disposed'); if (!STYLE[id]) throw new RangeError('Unknown hairstyle: ' + id);
      const request = ++styleRequest; pendingStyle = id;
      try {
        if (id !== 'legacy') await loadStyle(id);
        if (request !== styleRequest || disposed) return state();
        if (id === 'artemis') { const cr = ++colorRequest; await applyColorAtlas(activeColor, cr); }
        if (request !== styleRequest || disposed) return state();
        legacyHair.root.visible = id === 'legacy';
        for (const [key, entry] of styles) entry.holder.visible = id === key;
        activeStyle = id; pendingStyle = null; root.updateMatrixWorld(true); return state();
      } catch (error) { if (request === styleRequest) pendingStyle = null; throw error; }
    },
    async setColor(id) {
      if (disposed) throw new Error('Hair wardrobe disposed'); if (!COLOR[id]) throw new RangeError('Unknown hair color: ' + id);
      const request = ++colorRequest;
      if (activeStyle === 'artemis' || pendingStyle === 'artemis') await applyColorAtlas(id, request);
      if (request !== colorRequest || disposed) return state();
      activeColor = id; dye.value.set(COLOR[id].tint); applyBrows(); return state();
    },
    update(dt = 0) {
      if (disposed) return;
      dt = clamp(Number.isFinite(dt) ? dt : 0, 0, .05); time += dt;
      if (activeStyle === 'legacy') legacyHair.update(dt);
      head.getWorldQuaternion(headQ); headDelta.copy(previousHead).invert().multiply(headQ); previousHead.copy(headQ);
      if (headDelta.w < 0) { headDelta.x *= -1; headDelta.y *= -1; headDelta.z *= -1; headDelta.w *= -1; }
      const inverseStep = dt > .00001 ? 1 / dt : 0;
      target.set(clamp(-headDelta.y * inverseStep * .04, -.049, .049) + Math.sin(time * 1.0) * .004,
        clamp(headDelta.x * inverseStep * .035, -.042, .042) + Math.sin(time * .85 + .5) * .003);
      // Exact critically damped step: stable at irregular rendering cadence,
      // with a softer settling time than the former explicit Euler spring.
      const frequency = 5.5, decay = Math.exp(-frequency * dt);
      for (const axis of ['x', 'y']) {
        const offset = motion[axis] - target[axis], correction = velocity[axis] + frequency * offset;
        motion[axis] = target[axis] + (offset + correction * dt) * decay;
        velocity[axis] = (velocity[axis] - frequency * correction * dt) * decay;
      }
      motion.clampScalar(-.055, .055);
      const entry = styles.get(activeStyle);
      entry?.motionBones.forEach(bone => {
        bone.quaternion.copy(entry.rest.get(bone));
        // Small bounded deformation of source bones, not deformation of the skull.
        const gain = entry.gains.get(bone);
        bone.rotateX(motion.y * gain); bone.rotateZ(motion.x * gain);
      });
    },
    dispose() {
      if (disposed) return; disposed = true; styleRequest++; colorRequest++;
      for (const entry of styles.values()) disposeObject(entry.holder); styles.clear();
      for (const promise of maps.values()) promise.then(map => map.dispose()).catch(() => {}); maps.clear();
      currentColorMap?.dispose(); currentColorMap = null; anchor.removeFromParent();
      for (const { material, before, key } of legacyCallbacks) { material.onBeforeCompile = before; material.customProgramCacheKey = key; }
      legacyHair.dispose();
    },
  };
  try { await api.setStyle(style); applyBrows(); return api; } catch (error) { api.dispose(); throw error; }
}
