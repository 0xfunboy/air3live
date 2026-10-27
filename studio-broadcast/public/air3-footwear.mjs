import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { setBodyDrawMask, releaseBodyDrawMask } from './air3-garment-mask.mjs';

export const FOOTWEAR_STYLES = Object.freeze([
  Object.freeze({ id: 'original', label: 'Sneakers originali', commercialUse: true, license: 'asset del progetto' }),
  Object.freeze({ id: 'boot', label: 'Stivaletti in pelle · Aquateknica', commercialUse: true, license: 'CC BY 4.0', author: 'Aquateknica' }),
  Object.freeze({ id: 'shoes-test', label: 'Tacchi aperti · demo non commerciale', commercialUse: false, license: 'CC BY-NC 4.0', author: 'Bente Aimee' }),
]);
export const BOOT_FITS = Object.freeze([
  Object.freeze({ id: 'relaxed', label: 'Gambale adattato' }),
  Object.freeze({ id: 'low-cut', label: 'Gambale basso' }),
]);
const smooth = (a, b, x) => THREE.MathUtils.smoothstep(x, a, b);
const sourceAssets = '/assets/air3/footwear/';

/** Clip the low collar at one exact plane and add a narrow inward leather rim.
 * This keeps a clean edge instead of dropping whole triangles in a jagged band.
 */
function lowerCollar(geometry, height, ankle) {
  const attrs = geometry.attributes, p = attrs.position, n = attrs.normal, uv = attrs.uv;
  const joints = attrs.skinIndex, weights = attrs.skinWeight, indices = geometry.index.array;
  const values = { position: [], normal: [], uv: [], skinIndex: [], skinWeight: [] };
  const read = i => ({ position: [p.getX(i), p.getY(i), p.getZ(i)], normal: [n.getX(i), n.getY(i), n.getZ(i)],
    uv: [uv.getX(i), uv.getY(i)], skinIndex: Array.from({ length: 4 }, (_, c) => joints.getComponent(i, c)),
    skinWeight: Array.from({ length: 4 }, (_, c) => weights.getComponent(i, c)) });
  const interpolate = (a, b) => {
    const t = (height - a.position[1]) / (b.position[1] - a.position[1]), result = {};
    for (const field of ['position', 'normal', 'uv', 'skinWeight']) result[field] = a[field].map((v, i) => v + (b[field][i] - v) * t);
    result.position[1] = height; result.skinIndex = a.skinIndex.slice(); return result;
  };
  const push = vertex => { for (const field of Object.keys(values)) values[field].push(...vertex[field]); };
  const triangle = (a, b, c) => { push(a); push(b); push(c); };
  for (let offset = 0; offset < indices.length; offset += 3) {
    const input = [read(indices[offset]), read(indices[offset + 1]), read(indices[offset + 2])], polygon = [], cuts = [];
    for (let j = 0; j < 3; j++) {
      const a = input[j], b = input[(j + 1) % 3], ain = a.position[1] <= height, bin = b.position[1] <= height;
      if (ain) polygon.push(a);
      if (ain !== bin) { const edge = interpolate(a, b); polygon.push(edge); cuts.push(edge); }
    }
    for (let j = 1; j + 1 < polygon.length; j++) triangle(polygon[0], polygon[j], polygon[j + 1]);
    if (cuts.length === 2) {
      const inward = edge => {
        const v = { ...edge, position: edge.position.slice(), normal: [0, 1, 0] };
        const x = ankle.x - v.position[0], z = ankle.z - v.position[2], length = Math.hypot(x, z) || 1;
        v.position[0] += x / length * .003; v.position[2] += z / length * .003; return v;
      };
      const a = { ...cuts[0], normal: [0, 1, 0] }, b = { ...cuts[1], normal: [0, 1, 0] }, ia = inward(a), ib = inward(b);
      triangle(a, b, ib); triangle(a, ib, ia);
    }
  }
  const clipped = new THREE.BufferGeometry();
  for (const [field, size] of Object.entries({ position: 3, normal: 3, uv: 2, skinIndex: 4, skinWeight: 4 })) {
    clipped.setAttribute(field, field === 'skinIndex' ? new THREE.Uint16BufferAttribute(values[field], size) : new THREE.Float32BufferAttribute(values[field], size));
  }
  clipped.setIndex(Array.from({ length: values.position.length / 3 }, (_, i) => i));
  clipped.normalizeNormals(); return clipped;
}

/** Fit alternative footwear to the existing bind skeleton. No bone scaling.
 * The source sneakers remain available and are hidden only after a successful
 * replacement load. New shoes use the avatar's foot/calf bones, not a parallel
 * animation rig. The optional Shoes test supplied fitting foot is clipped
 * inside its collar; it does not replace the avatar's body or skeleton.
 */
export async function createFootwearController({ avatarRoot, rig, assetBase = sourceAssets, loader = new GLTFLoader() } = {}) {
  if (!avatarRoot) throw new TypeError('avatarRoot is required');
  const sourceShoes = [], bodyMeshes = [];
  avatarRoot.traverse(node => {
    if (!node.isSkinnedMesh) return;
    const position = node.geometry.attributes.position;
    if (node.name.startsWith('outfit__')) {
      node.geometry.computeBoundingBox();
      const box = node.geometry.boundingBox;
      if (box.max.y < .20 && box.min.y < .05) sourceShoes.push({ node, visible: node.visible });
    }
    if (node.name.startsWith('body__') && position?.count > 1000) bodyMeshes.push({ node });
  });
  const body = bodyMeshes.find(row => row.node.skeleton.bones.some(bone => bone.name === 'body__foot_l'))?.node;
  if (!body || !sourceShoes.length) throw new Error('Avatar foot skeleton or original footwear was not found');
  const skeleton = body.skeleton;
  const boneIndex = name => skeleton.bones.findIndex(bone => bone.name === 'body__' + name);
  const bindPosition = name => {
    const i = boneIndex(name);
    if (i < 0) throw new Error('Missing footwear bone ' + name);
    // Bone inverses retain the original bind space even when the rig is already
    // animated and its holder has been normalized to presentation height.
    return new THREE.Vector3().setFromMatrixPosition(skeleton.boneInverses[i].clone().invert());
  };
  const feet = ['l', 'r'].map(side => {
    const foot = bindPosition('foot_' + side), ball = bindPosition('ball_' + side);
    const forward = ball.clone().sub(foot); forward.y = 0; forward.normalize();
    const right = new THREE.Vector3(forward.z, 0, -forward.x);
    return { side, foot, forward, right, footIndex: boneIndex('foot_' + side), calfIndex: boneIndex('calf_' + side), ballIndex: boneIndex('ball_' + side) };
  });
  const floor = Math.min(...sourceShoes.map(row => row.node.geometry.boundingBox.min.y));
  const root = new THREE.Group(); root.name = 'AIR3 interchangeable footwear'; avatarRoot.add(root);
  let style = 'original', desired = 'original', fit = 'relaxed', desiredFit = 'relaxed', loading = false, error = null, disposed = false, request = 0;
  const cache = new Map(), pending = new Map();
  const originalVisibility = new Map(sourceShoes.map(row => [row.node, row.visible]));

  function bodyMask(id) {
    const threshold = .090;
    for (const row of bodyMeshes) setBodyDrawMask(row.node, 'footwear', id === 'original' ? 'original' : 'covered', id === 'original' ? null : (positions, a, b, c) =>
      positions.getY(a) >= threshold && positions.getY(b) >= threshold && positions.getY(c) >= threshold);
  }

  function releaseGroup(group) {
    const textures = new Set();
    group.traverse(mesh => { if (mesh.isMesh) { mesh.geometry.dispose(); for (const value of Object.values(mesh.material)) if (value?.isTexture) textures.add(value); mesh.material.dispose(); } });
    for (const texture of textures) texture.dispose(); group.removeFromParent();
  }
  async function build(id, requestedFit) {
    const gltf = await loader.loadAsync(assetBase + id + '.glb');
    const group = new THREE.Group(); group.name = 'AIR3 footwear / ' + id; group.visible = false;
    const sourceMeshes = []; gltf.scene.traverse(mesh => { if (mesh.isMesh) sourceMeshes.push(mesh); });
    let triangleCount = 0;
    for (const foot of feet) for (const source of sourceMeshes) {
      let geometry = source.geometry.clone(); const p = geometry.attributes.position;
      const proxy = source.userData.air3FittingProxy === true || source.name.includes('proxy-foot');
      const indices = geometry.index?.array ?? Uint32Array.from({ length: p.count }, (_, i) => i);
      // Shoes test was authored on a broad fitting dummy. Fit the footwear to
      // the presenter's size in asset space; body bone lengths stay unchanged.
      const sx = id === 'shoes-test' ? .66 : 1.0, sy = id === 'shoes-test' ? .67 : 1.0;
      const ankleZ = id === 'boot' ? .067 : .061;
      const skinIndex = new Uint16Array(p.count * 4), skinWeight = new Float32Array(p.count * 4), proxyKeep = new Uint8Array(p.count);
      const q = new THREE.Vector3(), mapped = new THREE.Vector3();
      for (let i = 0; i < p.count; i++) {
        const sourceY = p.getY(i);
        proxyKeep[i] = sourceY < .09 && p.getZ(i) > .185 ? 1 : 0;
        let fittedX = p.getX(i), fittedZ = p.getZ(i);
        if (id === 'boot') {
          const collar = smooth(.13, .24, sourceY);
          fittedZ -= .040 * collar;
          fittedX = (fittedX - .009 * collar) * (1 + .18 * collar);
        }
        if (id === 'shoes-test') {
          // Its supplied fitting dummy leans forward above the ankle. Bring
          // only the collar and ties around the existing upright shin; leave
          // the sole/heel/toe silhouette unchanged.
          const collar = smooth(.17, .29, sourceY);
          fittedZ = THREE.MathUtils.lerp(fittedZ, ankleZ + (fittedZ - .13) * .65, collar);
          fittedX += .005 * collar;
          if (proxy) { fittedX *= .85; fittedZ = .125 + (fittedZ - .125) * .90; }
        }
        const x = fittedX * sx * (foot.side === 'l' ? -1 : 1), y = sourceY * sy + floor, z = fittedZ - ankleZ;
        mapped.copy(foot.foot).addScaledVector(foot.right, x).addScaledVector(foot.forward, z); mapped.y = y;
        p.setXYZ(i, mapped.x, mapped.y, mapped.z);
        const calf = smooth(.115, .205, y), toe = (1 - calf) * smooth(.13, .20, z) * .30;
        skinIndex.set([foot.footIndex, foot.calfIndex, foot.ballIndex, 0], i * 4);
        skinWeight.set([1 - calf - toe, calf, toe, 0], i * 4);
      }
      let draw = Array.from(indices);
      if (proxy) {
        // The foot provided with this open-toe asset fills the toe opening.
        // Only the toe-opening patch is retained; the fitting instep and calf
        // are removed so they cannot intersect the leather or the real shin. This is an explicitly marked noncommercial demo item.
        draw = [];
        for (let i = 0; i < indices.length; i += 3) if ([indices[i], indices[i + 1], indices[i + 2]].every(index => proxyKeep[index])) draw.push(indices[i], indices[i + 1], indices[i + 2]);
      }
      if (foot.side === 'l') for (let i = 0; i < draw.length; i += 3) [draw[i + 1], draw[i + 2]] = [draw[i + 2], draw[i + 1]];
      geometry.setIndex(draw); geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4)); geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
      geometry.computeVertexNormals();
      if (id === 'boot' && requestedFit === 'low-cut') {
        const clipped = lowerCollar(geometry, floor + .205, foot.foot); geometry.dispose(); geometry = clipped;
      }
      geometry.computeBoundingBox(); geometry.computeBoundingSphere();
      const material = source.material.clone();
      material.name = proxy ? 'AIR3 / supplied footwear fitting skin' : 'AIR3 / ' + id + ' leather';
      material.userData.air3Surface = proxy ? 'footwear-fitting-skin' : 'shoes';
      if (material.map) { material.map.colorSpace = THREE.SRGBColorSpace; material.map.anisotropy = 4; }
      if (proxy) { material.color.set('#cba07f'); material.roughness = .8; }
      material.side = THREE.DoubleSide;
      const mesh = new THREE.SkinnedMesh(geometry, material);
      mesh.name = `AIR3_${id}_${foot.side}_${proxy ? 'fitting-foot' : source.name}`;
      mesh.bind(skeleton, body.bindMatrix.clone()); mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.userData.air3Footwear = { style: id, fit: requestedFit, side: foot.side, sourceFittingFoot: proxy };
      group.add(mesh); triangleCount += geometry.index.count / 3;
    }
    // The copied materials retain shared source maps. Dispose only the temporary
    // source geometries/materials, never these retained texture objects.
    gltf.scene.traverse(mesh => { if (mesh.isMesh) { mesh.geometry.dispose(); mesh.material.dispose(); } });
    group.userData.triangles = triangleCount; if (!disposed) root.add(group); return group;
  }
  function apply(id, nextFit) {
    const selected = id + ':' + (id === 'boot' ? nextFit : 'default');
    for (const [key, group] of cache) group.visible = key === selected;
    for (const row of sourceShoes) row.node.visible = id === 'original' ? originalVisibility.get(row.node) : false;
    bodyMask(id); style = id; fit = nextFit; error = null;
  }
  const controller = {
    styles: FOOTWEAR_STYLES, fits: BOOT_FITS,
    async setStyle(id, { fit: nextFit = desiredFit } = {}) {
      if (disposed) return false;
      if (!FOOTWEAR_STYLES.some(row => row.id === id)) throw new RangeError('Unknown footwear style: ' + id);
      if (!BOOT_FITS.some(row => row.id === nextFit)) throw new RangeError('Unknown boot fit: ' + nextFit);
      desired = id; desiredFit = nextFit; const key = id + ':' + (id === 'boot' ? nextFit : 'default'); const ticket = ++request;
      if (id === 'original') { loading = false; apply(id, nextFit); return true; }
      loading = true; error = null;
      try {
        if (!cache.has(key)) {
          if (!pending.has(key)) pending.set(key, build(id, nextFit).then(group => {
            if (disposed) releaseGroup(group); else cache.set(key, group);
            return group;
          }).finally(() => pending.delete(key)));
          await pending.get(key);
        }
        if (disposed || ticket !== request) return false;
        apply(id, nextFit); loading = false; return true;
      } catch (e) {
        if (ticket === request) { error = e.message; loading = false; desired = style; desiredFit = fit; }
        throw e;
      }
    },
    async setFit(nextFit) { return controller.setStyle(desired, { fit: nextFit }); },
    update() { if (!disposed && style !== 'original') root.updateMatrixWorld(true); },
    getState() { return { style, desired, fit, desiredFit, loading, error }; },
    diagnostics() { return { profile: 'air3-fitted-footwear-2026-10-25-v2', style, desired, fit, desiredFit, loading, error,
      triangles: cache.get(style + ':' + (style === 'boot' ? fit : 'default'))?.userData.triangles ?? 0, originalShoeMeshes: sourceShoes.length,
      skeleton: 'existing MetaHuman body bones; foot/calf/ball weights', boneScalesChanged: false,
      commercialUse: FOOTWEAR_STYLES.find(row => row.id === style)?.commercialUse,
      originalSoleY: floor, fittingFoot: style === 'shoes-test', cachedStyles: [...cache.keys()] }; },
    dispose() {
      if (disposed) return; disposed = true; request++;
      for (const row of sourceShoes) row.node.visible = originalVisibility.get(row.node);
      for (const row of bodyMeshes) releaseBodyDrawMask(row.node, 'footwear');
      for (const group of cache.values()) releaseGroup(group); root.removeFromParent(); cache.clear();
      if (avatarRoot.userData.air3Footwear === controller) delete avatarRoot.userData.air3Footwear;
    },
  };
  avatarRoot.userData.air3Footwear = controller;
  return controller;
}
