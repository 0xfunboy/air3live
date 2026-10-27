import * as THREE from 'three';

// Install before Air3AvatarRig: that adapter extends skinning for the actual
// material and its shadow passes. Source images remain available alongside the
// reproducible material-data bake in tools/bake_avatar_materials.py.
const PROFILE = 'air3-materials-2026-10-25-v5-eye-makeup';

function eyeMakeup(material, mask, strength) {
  material.onBeforeCompile = shader => {
    shader.uniforms.air3EyeMakeupMask = { value: mask };
    shader.uniforms.air3EyeMakeupStrength = strength;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D air3EyeMakeupMask;\nuniform float air3EyeMakeupStrength;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        #ifdef USE_MAP
          vec3 air3Makeup = texture2D(air3EyeMakeupMask, vMapUv).rgb;
          // Supplied mask: R upper-eye shadow, G liner, B lipstick. The blue
          // channel is only a protection gate; lip colour is never repainted.
          float air3KeepLips = 1.0 - smoothstep(.01, .08, air3Makeup.b);
          float air3Shadow = smoothstep(.015, .75, air3Makeup.r) * air3KeepLips * air3EyeMakeupStrength;
          float air3Liner = smoothstep(.02, .80, air3Makeup.g) * air3KeepLips * air3EyeMakeupStrength;
          vec3 air3ShadowTone = vec3(.0252, .0144, .0185);
          diffuseColor.rgb = mix(diffuseColor.rgb, air3ShadowTone, air3Shadow * .43);
          diffuseColor.rgb *= 1.0 - air3Liner * .36;
        #endif
      `);
  };
  material.customProgramCacheKey = () => `${PROFILE}:original-eye-mask`;
}

function eyebrowTint(material, tint) {
  material.onBeforeCompile = shader => {
    shader.uniforms.air3BrowTint = tint;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 air3BrowTint;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        float air3BrowDetail = clamp(dot(diffuseColor.rgb, vec3(.2126,.7152,.0722)) / .0065, .45, 1.4);
        diffuseColor.rgb = air3BrowTint * air3BrowDetail;
      `);
  };
  material.customProgramCacheKey = () => `${PROFILE}:linked-brow-tint`;
}

function eyeRefraction(material, parallax = true) {
  // The existing eye mesh includes a corneal bulge. Keep that geometry and its
  // clearcoat highlight while offsetting only the iris texture underneath it.
  // This is a bounded parallax approximation, not full UE Eye shading.
  material.onBeforeCompile = (shader) => {
    const chunk = '#include <map_fragment>';
    if (!shader.fragmentShader.includes(chunk)) throw new Error('AIR3 eyes: missing Three map fragment');
    shader.fragmentShader = shader.fragmentShader.replace(chunk, `
      #ifdef USE_MAP
        vec2 air3EyeUv = vMapUv;
        float air3IrisGate = 1.0 - smoothstep(0.150, 0.173, length(vMapUv - vec2(0.5)));
        #if defined(USE_TANGENT) && !defined(FLAT_SHADED)
          vec3 air3View = normalize(vViewPosition);
          vec2 air3ViewXY = vec2(dot(air3View, normalize(vTangent)), dot(air3View, normalize(vBitangent)));
          float air3ViewZ = max(0.35, abs(dot(air3View, normalize(vNormal))));
          air3EyeUv -= clamp(air3ViewXY / air3ViewZ, vec2(-1.5), vec2(1.5)) * ${parallax ? '0.008' : '0.0'} * air3IrisGate;
        #endif
        vec4 air3EyeSample = texture2D(map, air3EyeUv);
        // Recolour only the iris. Preserve the supplied radial detail, black
        // pupil, limbal ring and the original sclera without rebaking imagery.
        float air3EyeRadius = length(air3EyeUv - vec2(.5));
        float air3BlueGate = (1.0 - smoothstep(.155, .172, air3EyeRadius))
          * smoothstep(.036, .050, air3EyeRadius);
        float air3IrisLuma = dot(air3EyeSample.rgb, vec3(.2126, .7152, .0722));
        vec3 air3BlueIris = vec3(.34, 1.10, 1.72) * air3IrisLuma;
        air3EyeSample.rgb = mix(air3EyeSample.rgb, air3BlueIris, air3BlueGate);
        diffuseColor *= air3EyeSample;
      #endif
    `);
  };
  material.customProgramCacheKey = () => `${PROFILE}:eye-parallax:${parallax}`;
}

function physical(name, options) {
  const material = new THREE.MeshPhysicalMaterial({ metalness: 0, ...options });
  material.name = name;
  material.userData.air3MaterialProfile = PROFILE;
  return material;
}

/** Reconstruct avatar materials from the supplied export. No vertex editing. */
export async function applyAvatarMaterials(gltf, {
  renderer, assetBase = '/assets/air3', quality = 'high',
} = {}) {
  if (!gltf?.scene) throw new TypeError('applyAvatarMaterials needs a loaded GLTF scene');
  if (gltf.scene.userData.air3Materials) return gltf.scene.userData.air3Materials;
  const root = gltf.scene;
  const high = ['high', 'balanced', 'cinematic'].includes(quality);
  const maxAnisotropy = Math.min(high ? 8 : 4, renderer?.capabilities.getMaxAnisotropy() ?? 4);
  const loader = new THREE.TextureLoader(gltf.parser?.options?.manager);
  const loaded = new Set(), replaced = new Set(), added = new Set(), counts = {};
  const makeupStrength = { value: 1 };
  const browTint = { value: new THREE.Color('#3b2b21').multiplyScalar(.42) };
  let hairColor = '#3b2b21';
  const load = async (name, color = false, repeat = 0) => {
    const texture = await loader.loadAsync(`${assetBase.replace(/\/$/, '')}/textures/render/${name}`);
    texture.name = `AIR3/${name}`;
    texture.flipY = false;
    texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = maxAnisotropy;
    if (repeat) {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(repeat, repeat);
    }
    loaded.add(texture);
    return texture;
  };
  let maps;
  try {
    const values = await Promise.all([
      load('FaceBeautyColor.webp', true), load('FaceBeautyORM.png'),
      load('HairColorCoverage.webp', true), load('HairAnisotropy.png'),
      load('BrowsColorCoverage.webp', true), load('BrowsAnisotropy.png'),
      load('LashesCoverage.png'), load('EyeColor.webp', true), load('EyeNormal.png'),
      load('MouthColor.webp', true), load('MouthORM.png'), load('ClothWeave.png', false, 32),
      load('../Hair_S_UpdoBuns_CardsAtlas_Attribute.png'),
      load('../data/FaceEyeLipstickMask.png'),
    ]);
    maps = Object.fromEntries(['face', 'faceOrm', 'hair', 'hairAnisotropy', 'brows',
      'browsAnisotropy', 'lashes', 'eye', 'eyeNormal', 'mouth', 'mouthOrm', 'weave', 'hairRaw', 'eyeMakeup'].map((name, i) => [name, values[i]]));
  } catch (error) {
    for (const texture of loaded) texture.dispose();
    throw new Error(`AIR3 material maps could not be loaded: ${error.message}`, { cause: error });
  }

  const mark = (kind, mesh, material) => {
    replaced.add(mesh.material);
    material.userData.air3Surface = kind;
    if (kind === 'hair') material.userData.air3RawHairCoverage = maps.hairRaw;
    mesh.material = material;
    mesh.userData.air3Surface = kind;
    added.add(material);
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (['hair', 'brows', 'lashes'].includes(kind)) {
      // ShadowMap's material path copies map/alphaMap/alphaTest. Skinned cards
      // also get the twelve-weight variants from Air3AvatarRig.
      material.shadowSide = THREE.DoubleSide;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.air3AlphaCutout = true;
    }
  };

  root.traverse((mesh) => {
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    const old = mesh.material;
    const name = old.name || '';
    if (name === 'face__MI_HeadSynthesized_Baked') {
      const material = physical('AIR3 / scanned skin and makeup', {
        map: maps.face, color: 0xffffff,
        roughnessMap: maps.faceOrm, roughness: 1,
        aoMap: maps.faceOrm, aoMapIntensity: .65,
        normalMap: old.normalMap, normalScale: new THREE.Vector2(.45, .45),
        ior: 1.42, specularIntensity: .60, clearcoat: .035,
        clearcoatRoughness: .45, envMapIntensity: .85,
      });
      // The source normal is DirectX/Unreal convention. The rig owns the
      // explicit sign switch for all marked normal maps, including the viewer.
      material.userData.air3NormalConvention = 'Unreal source; raw green unchanged';
      eyeMakeup(material, maps.eyeMakeup, makeupStrength);
      mark('skin-face', mesh, material);
    } else if (name.startsWith('body__')) {
      mark('skin-body', mesh, physical('AIR3 / body skin', {
        map: old.map, color: old.color.clone(), roughness: .62,
        ior: 1.42, specularIntensity: .56, envMapIntensity: .85,
      }));
    } else if (name.includes('MI_EyeRefractive_Inst_')) {
      const material = physical('AIR3 / cornea and iris', {
        map: maps.eye, color: 0xffffff,
        normalMap: maps.eyeNormal, normalScale: new THREE.Vector2(.11, .11),
        roughness: .22, clearcoat: 1, clearcoatRoughness: .045,
        ior: 1.336, specularIntensity: .85, envMapIntensity: 1.2,
      });
      material.userData.air3NormalConvention = 'Unreal source; raw green unchanged';
      eyeRefraction(material, high);
      mark('eyes', mesh, material);
    } else if (name.startsWith('hair__') || name.startsWith('brows__')) {
      const isBrow = name.startsWith('brows__');
      const kind = isBrow ? 'brows' : 'hair';
      const material = physical(`AIR3 / ${kind} coverage and anisotropy`, {
        map: isBrow ? maps.brows : maps.hair, color: 0xffffff,
        alphaTest: isBrow ? .13 : .33, transparent: false,
        depthWrite: true, side: THREE.DoubleSide, alphaToCoverage: quality !== 'software',
        roughness: isBrow ? .74 : .68, ior: 1.55,
        anisotropy: high ? (isBrow ? .16 : .30) : 0,
        anisotropyMap: high ? (isBrow ? maps.browsAnisotropy : maps.hairAnisotropy) : null,
        specularIntensity: isBrow ? .10 : .18, envMapIntensity: .48,
      });
      if (isBrow) eyebrowTint(material, browTint);
      mark(kind, mesh, material);
    } else if (name.includes('M_Eyelash')) {
      const material = physical('AIR3 / eyelash coverage', {
        color: 0x241812, alphaMap: maps.lashes,
        alphaTest: .32, transparent: false, side: THREE.DoubleSide,
        depthWrite: true, alphaToCoverage: quality !== 'software', roughness: .68,
        specularIntensity: .12,
      });
      mark('lashes', mesh, material);
      mesh.visible = true;
    } else if (name.includes('M_Teeth')) {
      mark('mouth', mesh, physical('AIR3 / enamel gums and tongue', {
        map: maps.mouth, color: 0xffffff, roughnessMap: maps.mouthOrm, roughness: 1, ior: 1.5,
        clearcoat: .015, clearcoatRoughness: .40, specularIntensity: .35,
      }));
    } else if (name.includes('MI_EyeOcclusion')) {
      // The UE occlusion surface needs its procedural graph. Showing a flat
      // gray replacement obscures the irises. Eyelid geometry casts real shadows.
      mesh.visible = false;
      mesh.userData.air3Surface = 'eye-occlusion-disabled';
      mesh.userData.air3NoShadow = true;
      mesh.castShadow = false;
    } else if (name.includes('MI_lacrimal')) {
      mark('tear-film', mesh, physical('AIR3 / tear film', {
        color: 0xf4c4bd, roughness: .13, ior: 1.336,
        clearcoat: 1, clearcoatRoughness: .05,
        transparent: true, opacity: .13, depthWrite: false,
      }));
      mesh.castShadow = false;
      mesh.userData.air3NoShadow = true;
      mesh.visible = true;
    } else if (name.includes('M_Cartilage')) {
      mark('waterline', mesh, physical('AIR3 / waterline', {
        color: 0xa85f56, roughness: .26, clearcoat: .35,
        clearcoatRoughness: .1, specularIntensity: .7,
      }));
      mesh.castShadow = false;
      mesh.userData.air3NoShadow = true;
      mesh.visible = true;
    } else if (name.startsWith('outfit__')) {
      // Source primitive bounds: material_0 is the sneaker pair; lambert2SG
      // is the tartan skirt (the historical material names are misleading).
      const shoes = /material_0/.test(name);
      const skirt = /lambert2SG/.test(name);
      const material = physical(`AIR3 / ${shoes ? 'sneakers' : skirt ? 'tartan cloth' : 'cotton blouse'}`, {
        map: old.map, color: old.map ? 0xffffff : 0xe9e8e2,
        roughness: shoes ? .66 : .84, ior: 1.45,
        specularIntensity: shoes ? .48 : .32,
        sheen: shoes ? .12 : .30,
        sheenColor: new THREE.Color(shoes ? 0xb7bdc0 : skirt ? 0x794a42 : 0xd9dad5),
        sheenRoughness: .8,
        bumpMap: shoes ? null : maps.weave,
        bumpScale: shoes ? 0 : .00013,
        side: old.side,
      });
      mark(shoes ? 'shoes' : 'cloth', mesh, material);
    }
  });

  // Dispose unused imported programs/maps, retaining source skin normals,
  // body/garment albedos and every texture still referenced by a live material.
  const retained = new Set();
  root.traverse((mesh) => {
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const value of Object.values(material)) if (value?.isTexture) retained.add(value);
    }
  });
  for (const material of replaced) {
    for (const value of Object.values(material)) {
      if (value?.isTexture && !retained.has(value)) value.dispose();
    }
    material.dispose();
  }
  const diagnostics = {
    profile: PROFILE, surfaces: counts,
    source: 'Supplied Unreal 5.7.4 material parameters and textures',
    normalY: -1, hairCoverage: 'Compact attribute R; alpha-masked depth-writing cards',
    face: 'Scanned albedo with stronger upper-eye shadow and liner from the original RGB mask; lips protected',
    eyeMakeup: { mask: 'FaceEyeLipstickMask.png', shadowChannel: 'R', linerChannel: 'G', protectedLipChannel: 'B', strength: makeupStrength.value },
    brows: { linkedHairColor: hairColor, tintSrgb: '#' + browTint.value.getHexString(), alphaCutoff: .13, preservedStrandCoverage: true },
    eyes: high ? 'Blue iris preserving source radial detail; sclera, clearcoat and bounded iris parallax' : 'Blue iris preserving source detail and sclera with clearcoat',
    limitations: ['Eye and dental palette lookup textures were not supplied; natural palettes are explicit substitutes.',
      'UE eye-occlusion graph, strand-hair scattering and full skin SSS are not reproduced.'],
  };
  const result = { diagnostics,
    setHairColor(value) {
      if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new TypeError('Hair colour must be a six-digit sRGB hex value');
      hairColor = value.toLowerCase(); browTint.value.set(hairColor).multiplyScalar(.42);
      diagnostics.brows.linkedHairColor = hairColor; diagnostics.brows.tintSrgb = '#' + browTint.value.getHexString();
      return { ...diagnostics.brows };
    },
    // Inspection hook used for a same-pose before/after render. Runtime keeps
    // strength 1; this does not change the supplied texture or its UVs.
    setEyeMakeupStrength(value) {
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('Eye makeup strength must be between zero and one');
      makeupStrength.value = value; diagnostics.eyeMakeup.strength = value;
    },
    dispose() {
    for (const texture of loaded) texture.dispose();
    for (const material of added) material.dispose();
    delete root.userData.air3Materials;
  } };
  root.userData.air3Materials = result;
  return result;
}
