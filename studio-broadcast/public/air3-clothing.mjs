import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { setBodyDrawMask, releaseBodyDrawMask } from './air3-garment-mask.mjs';

/** A white cotton finish; retain the supplied fabric's UV/detail, not its grey bake. */
export function applyWhiteCottonFinish(material) {
  material.color.set('#ffffff'); material.roughness = .92; material.metalness = 0;
  material.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      #ifdef USE_MAP
        vec4 cottonSample = texture2D(map, vMapUv);
        float cottonLuma = dot(cottonSample.rgb, vec3(0.2126, 0.7152, 0.0722));
        // The source texture contains a dark diffuse bake. Compress its tonal
        // range so illumination and real folds supply the shading on white.
        float cottonDetail = clamp(0.88 + 0.12 * sqrt(max(cottonLuma, 0.0)), 0.88, 1.0);
        vec3 cottonTint = mix(vec3(0.965, 0.952, 0.985), vec3(1.0, 0.989, 0.969), smoothstep(0.08, 0.65, cottonLuma));
        // Fine diagonal yarn modulation uses the existing cloth UV and fades
        // before subpixel frequency, avoiding moire during a moving shot.
        float yarnFootprint = max(fwidth(vMapUv.x), fwidth(vMapUv.y)) * 900.0;
        float yarn = 1.0 - 0.008 * sin(vMapUv.x * 5654.867) * sin(vMapUv.y * 5654.867) * (1.0 - smoothstep(0.3, 1.0, yarnFootprint));
        diffuseColor.rgb *= cottonTint * cottonDetail * yarn;
        diffuseColor.a *= cottonSample.a;
      #endif
    `);
  };
  material.customProgramCacheKey = () => 'air3-white-cotton-cream-lilac-v1';
  material.userData.air3Cotton = { base: 'white', creamHighlight: true, lilacShadow: true, originalUV: true, proceduralWeave: true };
  material.needsUpdate = true;
  return material;
}

export const CLOTHING_STYLES = Object.freeze([
  Object.freeze({ id: 'original', label: 'Maglietta originale', commercialUse: true, license: 'asset del progetto' }),
  Object.freeze({ id: 'crop', label: 'Top corto bianco · DaaGHrii', commercialUse: true, license: 'CC BY 4.0', author: 'DaaGHrii' }),
]);
export async function createClothingController({ avatarRoot, rig, assetBase = '/assets/air3/clothing/', loader = new GLTFLoader() } = {}) {
  if (!avatarRoot) throw new TypeError('avatarRoot is required');
  const originals = [], bodies = [];
  avatarRoot.traverse(mesh => {
    if (!mesh.isSkinnedMesh) return;
    if (mesh.name.startsWith('outfit__')) {
      mesh.geometry.computeBoundingBox();
      if (mesh.geometry.boundingBox.min.y > .90) originals.push({ mesh, visible: mesh.visible });
    }
    if (mesh.name === 'body__root_mesh') bodies.push(mesh);
  });
  const body = bodies[0];
  if (!body || !originals.length) throw new Error('Body skeleton or original shirt was not found');
  const root = new THREE.Group(); root.name = 'AIR3 interchangeable top'; avatarRoot.add(root);
  let style = 'original', desired = 'original', loading = false, error = null, disposed = false, serial = 0, loaded = null, pending = null;
  function release(group) {
    if (!group) return;
    const textures = new Set();
    group.traverse(mesh => { if (!mesh.isMesh) return; mesh.geometry.dispose(); for (const v of Object.values(mesh.material)) if (v?.isTexture) textures.add(v); mesh.material.dispose(); });
    for (const texture of textures) texture.dispose(); group.removeFromParent();
  }
  async function build() {
    const gltf = await loader.loadAsync(assetBase + 'crop-top.glb');
    const binding = gltf.parser.json.asset.extras.air3Binding;
    const indices = binding.joints.map(name => body.skeleton.bones.findIndex(bone => bone.name === name));
    if (indices.some(index => index < 0)) { release(gltf.scene); throw new Error('Crop top skeleton is incompatible with this avatar'); }
    const group = new THREE.Group(); group.name = 'AIR3 supplied short white top'; group.visible = false;
    gltf.scene.traverse(source => {
      if (!source.isMesh) return;
      const geometry = source.geometry.clone(), sourceIndex = geometry.getAttribute('_air3_joints'), sourceWeight = geometry.getAttribute('_air3_weights');
      const joints = new Uint16Array(sourceIndex.count * 4);
      for (let i = 0; i < sourceIndex.count; i++) for (let c = 0; c < 4; c++) joints[i * 4 + c] = indices[sourceIndex.getComponent(i, c)];
      geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(joints, 4));
      geometry.setAttribute('skinWeight', sourceWeight.clone());
      geometry.deleteAttribute('_air3_joints'); geometry.deleteAttribute('_air3_weights');
      const material = source.material.clone(); material.name = 'AIR3 / supplied white crop top';
      applyWhiteCottonFinish(material); material.side = THREE.DoubleSide;
      material.userData.air3Surface = 'shirt';
      if (material.map) { material.map.colorSpace = THREE.SRGBColorSpace; material.map.anisotropy = 4; }
      const mesh = new THREE.SkinnedMesh(geometry, material); mesh.name = 'AIR3_crop_top';
      mesh.bind(body.skeleton, body.bindMatrix.clone()); mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
      mesh.userData.air3Clothing = { style: 'crop', source: 'supplied Off Shoulder Top', binding: 'existing body bind-surface weights' }; group.add(mesh);
      source.geometry.dispose(); source.material.dispose();
    });
    if (!disposed) root.add(group); return group;
  }
  function apply(id) {
    for (const row of originals) row.mesh.visible = id === 'original' ? row.visible : false;
    if (loaded) loaded.visible = id === 'crop';
    for (const mesh of bodies) setBodyDrawMask(mesh, 'top', id, id === 'crop' ? (p, a, b, c) => {
      // Omit only the safely covered central torso. Bare shoulder, neckline,
      // sleeves and exposed midriff remain the actual avatar surface.
      const covered = i => p.getY(i) > 1.128 && p.getY(i) < 1.285 && Math.abs(p.getX(i)) < .14;
      return !(covered(a) && covered(b) && covered(c));
    } : null);
    style = id; error = null;
  }
  const controller = {
    styles: CLOTHING_STYLES,
    async setStyle(id) {
      if (disposed) return false;
      if (!CLOTHING_STYLES.some(row => row.id === id)) throw new RangeError('Unknown top style: ' + id);
      desired = id; const ticket = ++serial;
      if (id === 'original') { loading = false; apply(id); return true; }
      loading = true; error = null;
      try {
        if (!loaded) {
          if (!pending) pending = build().then(group => { if (disposed) release(group); else loaded = group; return group; }).finally(() => { pending = null; });
          await pending;
        }
        if (disposed || ticket !== serial) return false;
        apply(id); loading = false; return true;
      } catch (e) { if (ticket === serial) { error = e.message; loading = false; desired = style; } throw e; }
    },
    update() { if (!disposed && style === 'crop') root.updateMatrixWorld(true); },
    getState() { return { style, desired, loading, error }; },
    diagnostics() { return { profile: 'air3-supplied-crop-top-2026-10-27-v2', style, desired, loading, error,
      triangles: style === 'crop' ? 12052 : null, sourceShirtMeshes: originals.length,
      source: 'DaaGHrii / Off Shoulder Top', license: 'CC BY 4.0', bodyBoneScalesChanged: false,
      skinning: 'surface-transferred normalized four body influences', clothPhysics: false,
      fit: { heightReductionPercent: 15, pinnedUpperEdge: true, neckline: 'soft straight boat neck', bodyGeometryChanged: false },
      fabric: { color: 'white', undertone: 'subtle cream highlights and lilac shadows', authoredTexture: 'preserved UV detail with shader tonal remap', weave: 'filtered procedural cotton' } }; },
    dispose() {
      if (disposed) return; disposed = true; serial++;
      for (const row of originals) row.mesh.visible = row.visible;
      for (const mesh of bodies) releaseBodyDrawMask(mesh, 'top');
      release(loaded); root.removeFromParent();
      if (avatarRoot.userData.air3Clothing === controller) delete avatarRoot.userData.air3Clothing;
    },
  };
  avatarRoot.userData.air3Clothing = controller; return controller;
}
