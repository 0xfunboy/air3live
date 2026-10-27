import * as THREE from 'three';

// Deterministic hybrid hairstyle: copied fine scalp cards, with the old bun
// removed, plus authored ponytail and loose wisps. Only the copied cards are
// settled toward the scanned skull. The source GLB and face geometry remain
// byte-for-byte unmodified. Lengths use the source GLB's metre bind space.
const PROFILE = 'air3-short-ponytail-2026-10-24-v7';
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const clamp = THREE.MathUtils.clamp;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
function random(seed = 3717) { return () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; }; }

function hairline(x, z) {
  const a = Math.atan2(x, z - .006), front = Math.max(0, Math.cos(a));
  // A shallow centre part, feathered temples, and an uncovered ear rim.
  let y = 1.537 + .081 * front ** 1.45;
  y += .0035 * Math.exp(-(x * x) / .00020);
  if (Math.abs(x) > .064 && z > -.01) y = Math.max(y, 1.580 - (Math.abs(x) - .064) * .25);
  return y;
}

class HairGeometryBuilder {
  constructor() { this.p = []; this.n = []; this.uv = []; this.data = []; this.color = []; this.index = []; }
  vertex(p, n, u, v, alpha = 1, seed = 0, motion = 0, shade = 1) {
    const i = this.p.length / 3; this.p.push(p.x, p.y, p.z); this.n.push(n.x, n.y, n.z);
    this.uv.push(u, v); this.data.push(alpha, seed, motion);
    this.color.push(shade, shade * .94, shade * .87); return i;
  }
  triangle(a, b, c) { this.index.push(a, b, c); }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('air3HairData', new THREE.Float32BufferAttribute(this.data, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.color, 3));
    g.setIndex(this.index); g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}

function scalpGeometry(source, legacy, root) {
  // Preserve the exported fine strands on the scalp, while removing the bun
  // and long loose rear cards from a copied geometry. A spatial hash of the
  // scanned cranial vertices constrains selection to its real surface.
  const geometry = legacy.geometry.clone();
  geometry.applyMatrix4(root.matrixWorld.clone().invert().multiply(legacy.matrixWorld));
  const p = source.geometry.attributes.position, cells = new Map(), step = .012;
  const transform = root.matrixWorld.clone().invert().multiply(source.matrixWorld);
  const point = new THREE.Vector3(), normal = new THREE.Vector3();
  const normalTransform = new THREE.Matrix3().getNormalMatrix(transform);
  const key = (x, y, z) => `${x},${y},${z}`;
  for (let i = 0; i < p.count; i++) {
    point.fromBufferAttribute(p, i).applyMatrix4(transform);
    if (point.y < 1.53 || Math.abs(point.x) > .084) continue;
    const hash = key(Math.floor(point.x / step), Math.floor(point.y / step), Math.floor(point.z / step));
    let row = cells.get(hash); if (!row) { row = []; cells.set(hash, row); }
    normal.fromBufferAttribute(source.geometry.attributes.normal, i).applyMatrix3(normalTransform).normalize();
    row.push(point.x, point.y, point.z, normal.x, normal.y, normal.z);
  }
  const positions = geometry.attributes.position, alpha = [], included = [];
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
    const gx = Math.floor(x / step), gy = Math.floor(y / step), gz = Math.floor(z / step);
    let distance = Infinity, nearest = null;
    if (y < 1.689 && y > 1.53) for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
      const row = cells.get(key(gx + dx, gy + dy, gz + dz)); if (!row) continue;
      for (let j = 0; j < row.length; j += 6) {
        const d = (x - row[j]) ** 2 + (y - row[j + 1]) ** 2 + (z - row[j + 2]) ** 2;
        if (d < distance) { distance = d; nearest = row.slice(j, j + 6); }
      }
    }
    if (nearest) {
      const [px, py, pz, nx, ny, nz] = nearest;
      const excess = Math.max(0, (x - px) * nx + (y - py) * ny + (z - pz) * nz - .003);
      const settle = excess * .42;
      positions.setXYZ(i, x - nx * settle, y - ny * settle, z - nz * settle);
    }
    const close = 1 - smooth(.020 ** 2, .029 ** 2, distance);
    const edge = smooth(-.006, .003, y - hairline(x, z));
    const cap = 1 - smooth(1.676, 1.689, y);
    const back = 1 - smooth(.086, .110, -z);
    alpha.push(edge * close * cap * back, .31, 0);
    included.push(edge * close * cap * back > .005);
  }
  const index = geometry.index, kept = [];
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
    if ((included[a] || included[b] || included[c]) &&
        Math.max(positions.getY(a), positions.getY(b), positions.getY(c)) < 1.680) kept.push(a, b, c);
  }
  geometry.setIndex(kept); geometry.setAttribute('air3HairData', new THREE.Float32BufferAttribute(alpha, 3));
  // Remove now-unused vertices: bounds must reflect the visible scalp, not bun.
  const compact = new HairGeometryBuilder(), map = new Map();
  const normals = geometry.attributes.normal, uv = geometry.attributes.uv;
  for (const index of kept) {
    if (!map.has(index)) {
      const p = new THREE.Vector3().fromBufferAttribute(positions, index);
      const n = new THREE.Vector3().fromBufferAttribute(normals, index);
      map.set(index, compact.vertex(p, n, uv.getX(index), uv.getY(index), alpha[index * 3], .31, 0, 1));
    }
    compact.index.push(map.get(index));
  }
  geometry.dispose(); return compact.build();
}

/** A gently dished ribbon, with individual tapered tips and no cylindrical locks. */
function ribbon(builder, controls, width, { seed = 0, shade = 1, segments = 24, motion = 0, facing = V(0, 0, 1), tip = .86, rootFeather = .035 } = {}) {
  const curve = new THREE.CatmullRomCurve3(controls.map(p => p.clone()), false, 'centripetal');
  const cols = 4, start = builder.p.length / 3, side = new THREE.Vector3(), normal = new THREE.Vector3();
  for (let j = 0; j <= segments; j++) {
    const t = j / segments, p = curve.getPoint(t), tangent = curve.getTangent(t).normalize();
    side.crossVectors(tangent, facing).normalize();
    if (side.lengthSq() < .1) side.set(1, 0, 0);
    normal.crossVectors(side, tangent).normalize();
    const taper = Math.max(.015, 1 - smooth(tip, 1, t));
    const w = width * taper * (.76 + .24 * Math.sin(Math.PI * t));
    const alpha = smooth(0, rootFeather, t) * (1 - smooth(.975, 1, t));
    for (let c = 0; c <= cols; c++) {
      const u = c / cols, across = u * 2 - 1;
      const q = p.clone().addScaledVector(side, across * w * .5)
        .addScaledVector(normal, (1 - across * across) * w * .065);
      const curvedNormal = normal.clone().addScaledVector(side, across * .32).normalize();
      builder.vertex(q, curvedNormal, u, t, alpha, seed, motion * t * t, shade);
      if (j && c) {
        const a = start + (j - 1) * (cols + 1) + c - 1, d = start + j * (cols + 1) + c - 1;
        builder.triangle(a, a + 1, d + 1); builder.triangle(a, d + 1, d);
      }
    }
  }
}

// A small bundle of true tapered fibres, not an opaque ribbon. The triangle
// cross-section keeps the strand budget bounded and receives standard MSAA.
function fiberBundle(builder, controls, width, { seed = 0, shade = 1, motion = .34, facing = V(0, 0, 1) } = {}) {
  const rng = random(Math.round(seed * 100000) + 8301), count = 28, segments = 22, sides = 3;
  const buriedRoot = controls[0].clone(); buriedRoot.x *= .94; buriedRoot.y += .010; buriedRoot.z -= .008;
  const curve = new THREE.CatmullRomCurve3([buriedRoot, ...controls.map(p => p.clone())], false, 'centripetal');
  for (let fibre = 0; fibre < count; fibre++) {
    const start = builder.p.length / 3, lateral = (fibre / (count - 1) - .5) * width;
    const depth = (rng() - .5) * .0014, phase = rng() * Math.PI * 2;
    const radius = .000050 + rng() * .000035, length = .86 + rng() * .14;
    const tint = shade * (.78 + rng() * .44), twist = rng() * Math.PI * 2;
    for (let j = 0; j <= segments; j++) {
      const t = j / segments, along = t * length, centre = curve.getPoint(along);
      const tangent = curve.getTangent(along).normalize();
      const side = new THREE.Vector3().crossVectors(tangent, facing).normalize();
      const out = new THREE.Vector3().crossVectors(tangent, side).normalize();
      const spread = lateral * (.22 + .78 * smooth(0, .22, t)) + Math.sin(t * 6 + phase) * .00018 * t;
      centre.addScaledVector(side, spread).addScaledVector(out,
        depth * (.25 + .75 * Math.sin(Math.PI * t)) + Math.sin(t * 7 + phase) * .00016 * t);
      const r = Math.max(.000002, radius * (1 - smooth(.62, 1, t)));
      for (let k = 0; k < sides; k++) {
        const angle = k * Math.PI * 2 / sides + twist;
        const normal = side.clone().multiplyScalar(Math.cos(angle)).addScaledVector(out, Math.sin(angle)).normalize();
        builder.vertex(centre.clone().addScaledVector(normal, r), normal, k / sides, t,
          1, seed, motion * t * t, tint);
      }
      if (j) for (let k = 0; k < sides; k++) {
        const next = (k + 1) % sides, a = start + (j - 1) * sides + k;
        const b = start + (j - 1) * sides + next, c = start + j * sides + next, d = start + j * sides + k;
        builder.triangle(a, b, c); builder.triangle(a, c, d);
      }
    }
  }
}

function fiberMotionShader(material, sway) {
  material.onBeforeCompile = shader => {
    shader.uniforms.air3HairSway = sway;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
      attribute vec3 air3HairData; uniform vec3 air3HairSway;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed += air3HairSway * air3HairData.z;`);
  };
  material.customProgramCacheKey = () => `${PROFILE}:geometric-fibres`;
}

function makeStyleGeometry() {
  const randomValue = random(), tail = new HairGeometryBuilder(), fringe = new HairGeometryBuilder();
  const surface = new HairGeometryBuilder();
  // The rear tie sits below the cranial crown; there is no top bun or top knot.
  // Layers around the centreline create an airy taper rather than a solid tube.
  for (let i = 0; i < 58; i++) {
    const a = i * Math.PI * 2 / 58 + randomValue() * .12;
    const radial = .55 + randomValue() * .45, dx = Math.cos(a), dz = Math.sin(a);
    const endY = 1.365 + randomValue() * .052;
    const controls = [
      V(dx * .011, 1.617 + dz * .006, -.078),
      V(dx * .022, 1.601 + dz * .012, -.120 + dz * .012),
      V(.003 + dx * .034 * radial, 1.531, -.146 + dz * .028 * radial),
      V(.018 + dx * .031 * radial, 1.447, -.132 + dz * .024 * radial),
      V(.022 + dx * .022, endY, -.093 + dz * .016),
    ];
    ribbon(tail, controls, .009 + randomValue() * .012, {
      seed: randomValue(), shade: .78 + randomValue() * .35, motion: 1,
      facing: V(dx, .12, dz), segments: 28, tip: .62 + randomValue() * .16,
    });
  }
  // Four softly curved temple locks, rather than parallel threads across the
  // forehead. Wider source-atlas coverage stays readable in a presenter shot.
  // Their roots remain lateral to the eyes and the paired lengths are unequal.
  const templeLocks = [
    { points: [[-.050, 1.614, .065], [-.063, 1.585, .076], [-.071, 1.535, .074],
      [-.066, 1.482, .073], [-.081, 1.416, .054], [-.101, 1.356, .028]],
      width: .0080, seed: .14, shade: 1.06, facing: V(-.42, 0, 1) },
    { points: [[-.065, 1.599, .034], [-.077, 1.566, .037], [-.082, 1.523, .052],
      [-.078, 1.475, .048], [-.095, 1.434, .030]],
      width: .0047, seed: .53, shade: .98, facing: V(-.68, 0, .78) },
    { points: [[.055, 1.611, .064], [.067, 1.580, .073], [.072, 1.530, .076],
      [.065, 1.483, .069], [.073, 1.438, .052], [.086, 1.401, .034]],
      width: .0072, seed: .35, shade: 1.02, facing: V(.43, 0, 1) },
    { points: [[.064, 1.604, .040], [.077, 1.568, .044], [.083, 1.521, .051],
      [.078, 1.473, .039], [.090, 1.422, .023], [.106, 1.377, .015]],
      width: .0049, seed: .58, shade: .97, facing: V(.68, 0, .78) },
  ];
  for (const lock of templeLocks) fiberBundle(fringe, lock.points.map(p => V(...p)), lock.width,
    { seed: lock.seed, shade: lock.shade, motion: .34, facing: lock.facing });
  for (const sign of [-1, 1]) {
    // Tucked, tapered temporal hairs soften the edge above each ear.
    for (let i = 0; i < 8; i++) {
      const x = sign * (.064 + randomValue() * .008);
      ribbon(surface, [V(x, 1.598 + randomValue() * .012, .036), V(x * 1.04, 1.582, .035),
        V(x * .99, 1.562 + randomValue() * .012, .025)], .0010 + randomValue() * .0011,
      { seed: randomValue(), shade: .82 + randomValue() * .2, segments: 12,
        facing: V(sign, 0, .5), tip: .45, rootFeather: .08 });
    }
  }
  return { tail: tail.build(), fringe: fringe.build(), surface: surface.build() };
}

function strandShader(material, { scalp, fine = false, rawCoverage = null, sway, colorPass = true }) {
  material.onBeforeCompile = shader => {
    shader.uniforms.air3HairSway = sway;
    shader.uniforms.air3RawCoverage = { value: rawCoverage };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
      attribute vec3 air3HairData;
      varying vec2 vAir3HairUv;
      varying vec3 vAir3HairData;
      varying vec3 vAir3HairBind;
      uniform vec3 air3HairSway;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vAir3HairUv = uv; vAir3HairData = air3HairData; vAir3HairBind = position;
        transformed += air3HairSway * air3HairData.z;`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
      varying vec2 vAir3HairUv;
      varying vec3 vAir3HairData;
      varying vec3 vAir3HairBind;
      uniform sampler2D air3RawCoverage;`);
    if (!scalp) {
      // Reuse an actual straight strand tile from the supplied coverage atlas.
      // Shader-side UV remapping preserves the original raster asset exactly.
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
        #ifdef USE_MAP
          float air3Tile = ${fine ? '2.0 + floor(vAir3HairData.y * 5.0)' : 'floor(vAir3HairData.y * 4.0)'};
          vec2 air3AtlasUv = vec2(air3Tile * .125 + .008 + vAir3HairUv.x * .109,
            .005 + vAir3HairUv.y * .473);
          vec4 air3HairSample = texture2D(map, air3AtlasUv);
          ${rawCoverage ? `air3HairSample.a = pow(texture2D(air3RawCoverage, air3AtlasUv).r, ${fine ? '.52' : '.72'}) * ${fine ? '1.30' : '1.20'};` : ''}
          diffuseColor *= air3HairSample;
        #endif`);
    }
    const alpha = `
      float air3HairU = vAir3HairUv.x;
      float air3HairV = vAir3HairUv.y;
      float air3Lane = ${scalp ? 'air3HairU * 1320.0' : 'air3HairU * 11.0 + sin(air3HairV * 13.0 + vAir3HairData.y * 15.0) * .13'};
      float air3Wave = sin(air3Lane * 6.2831853) * .5 + .5;
      float air3Lod = smoothstep(.30, 1.1, fwidth(air3Lane));
      float air3Strand = mix(smoothstep(.08, .30, air3Wave), .92, air3Lod);
      float air3Edge = ${scalp ? '1.0' : 'smoothstep(0.0, .12, air3HairU) * (1.0 - smoothstep(.88, 1.0, air3HairU))'};
      diffuseColor.a *= vAir3HairData.x * air3Edge;
      ${scalp ? 'diffuseColor.a *= 1.0 - smoothstep(1.670, 1.680, vAir3HairBind.y);' : ''}
    `;
    shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', `${alpha}\n#include <alphatest_fragment>`);
    if (colorPass) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        float air3LightStrand = 1.0;
        diffuseColor.rgb *= air3LightStrand;
        roughnessFactor = clamp(roughnessFactor + (1.0 - air3LightStrand) * .14, .4, .9);`);
    }
  };
  material.customProgramCacheKey = () => `${PROFILE}:${scalp ? 'scalp' : 'strand'}:${fine}:${!!rawCoverage}:${colorPass}`;
}

/** Install in bind pose, after materials and BEFORE Air3AvatarRig starts clips. */
export function createAir3Hair(root, { quality = 'high' } = {}) {
  if (!root?.isObject3D) throw new TypeError('createAir3Hair requires the avatar root');
  if (root.userData.air3Hair) return root.userData.air3Hair;
  root.updateMatrixWorld(true);
  const head = root.getObjectByName('body__head');
  let source, legacy;
  const hidden = [];
  root.traverse(node => {
    if (node.isMesh && node.userData.air3Surface === 'skin-face') source = node;
    if (node.isMesh && node.name.startsWith('hair__')) { legacy ||= node; hidden.push({ node, visible: node.visible }); node.visible = false; }
  });
  if (!head || !source || !legacy) throw new Error('AIR3 hairstyle needs the source head and reconstructed face material');
  const group = new THREE.Group(); group.name = 'air3_ponytail';
  // Preserve the complete affine bind-space relation. No dependence on rig
  // orientation guesses, later stage scaling or camera-facing head rotations.
  group.matrix.copy(head.matrixWorld).invert().multiply(root.matrixWorld);
  group.matrixAutoUpdate = false; head.add(group);
  const sway = { value: new THREE.Vector3() }, geometries = [], materials = [];
  function mesh(geometry, name, scalp = false, fibres = false) {
    const m = new THREE.MeshPhysicalMaterial({ name: `AIR3 / ${name}`,
      color: fibres ? 0x4b3427 : 0xffffff, map: fibres ? null : legacy.material.map, vertexColors: true, roughness: scalp ? .73 : fibres ? .82 : .67,
      metalness: 0, ior: 1.55, specularIntensity: fibres ? .022 : scalp ? .16 : .20, envMapIntensity: fibres ? .30 : .48,
      anisotropy: fibres || quality === 'software' ? 0 : .26, anisotropyRotation: scalp ? 0 : Math.PI / 2,
      anisotropyMap: scalp ? (legacy.material.anisotropyMap || null) : null,
      alphaTest: fibres ? 0 : .16, transparent: false, depthWrite: true, side: fibres ? THREE.FrontSide : THREE.DoubleSide,
      alphaToCoverage: !fibres && quality !== 'software', shadowSide: fibres ? THREE.FrontSide : THREE.DoubleSide });
    const fine = name.includes('wisps') || name.includes('baby');
    const rawCoverage = legacy.material.userData.air3RawHairCoverage || null;
    if (fibres) fiberMotionShader(m, sway); else strandShader(m, { scalp, fine, rawCoverage, sway });
    m.userData.air3Surface = 'hair'; m.userData.air3MaterialProfile = PROFILE;
    const object = new THREE.Mesh(geometry, m); object.name = `air3_hair_${name}`;
    object.castShadow = object.receiveShadow = true; object.frustumCulled = false;
    object.userData.air3Surface = 'hair'; object.userData.air3AlphaCutout = !fibres; object.userData.air3GeometricFibres = fibres;
    // Subpixel fibres do not belong in the reduced-resolution normal buffer.
    // Like the cutout cards, omit them from GTAO; their direct shadows remain.
    object.userData.air3NoAO = fibres;
    object.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking,
      alphaTest: fibres ? 0 : .16, side: fibres ? THREE.FrontSide : THREE.DoubleSide, map: fibres ? null : legacy.material.map });
    object.customDistanceMaterial = new THREE.MeshDistanceMaterial({ alphaTest: fibres ? 0 : .16, side: fibres ? THREE.FrontSide : THREE.DoubleSide, map: fibres ? null : legacy.material.map });
    if (fibres) {
      fiberMotionShader(object.customDepthMaterial, sway); fiberMotionShader(object.customDistanceMaterial, sway);
    } else {
      strandShader(object.customDepthMaterial, { scalp, fine, rawCoverage, sway, colorPass: false });
      strandShader(object.customDistanceMaterial, { scalp, fine, rawCoverage, sway, colorPass: false });
    }
    group.add(object); geometries.push(geometry); materials.push(m, object.customDepthMaterial, object.customDistanceMaterial);
  }
  mesh(scalpGeometry(source, legacy, root), 'feathered scalp cards', true);
  const style = makeStyleGeometry();
  mesh(style.surface, 'temporal baby hairs'); mesh(style.tail, 'short rear ponytail'); mesh(style.fringe, 'face framing wisps', false, true);
  const headQ = new THREE.Quaternion(), previousQ = head.getWorldQuaternion(new THREE.Quaternion());
  const delta = new THREE.Quaternion(), current = new THREE.Vector3(), velocity = new THREE.Vector3();
  const target = new THREE.Vector3(); let time = 0, disposed = false;
  const triangles = geometries.reduce((n, g) => n + g.index.count / 3, 0);
  const result = { root: group, update(dt = 0) {
    if (disposed) return;
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, .05); time += dt;
    head.getWorldQuaternion(headQ); delta.copy(previousQ).invert().multiply(headQ);
    previousQ.copy(headQ);
    // Critically damped, millimetre-scale lag. Deliberately bounded; this is not
    // collision simulation or a cloth solver. No per-frame geometry allocations.
    target.set(clamp(-delta.y * .28, -.009, .009), 0, clamp(delta.x * .20, -.006, .006));
    target.x += Math.sin(time * 1.13) * .0015; target.z += Math.sin(time * .83 + .6) * .001;
    const k = 85, damping = 2 * Math.sqrt(k);
    for (const axis of ['x', 'y', 'z']) {
      velocity[axis] += ((target[axis] - current[axis]) * k - velocity[axis] * damping) * dt;
      current[axis] += velocity[axis] * dt;
      current[axis] = clamp(current[axis], -.012, .012);
    }
    sway.value.copy(current);
  }, diagnostics() { return { profile: PROFILE, legacyBunHidden: hidden.every(r => !r.node.visible),
    scalpFit: 'copied source scalp cards settled toward scanned cranial geometry; bun removed', style: 'short rear ponytail with feathered hairline and shoulder wisps',
    meshes: group.children.length, triangles, boundTo: head.name, secondaryMotion: 'bounded critically damped strand lag',
    sourceGeometryModified: false, hybridSourceCards: true, geometricFramingFibres: 112, fibreTriangles: 14784, collisions: false }; }, dispose() {
    if (disposed) return; disposed = true; group.removeFromParent();
    for (const g of geometries) g.dispose(); for (const m of materials) m.dispose();
    for (const record of hidden) record.node.visible = record.visible;
    delete root.userData.air3Hair;
  } };
  root.userData.air3Hair = result; result.update(0); return result;
}
