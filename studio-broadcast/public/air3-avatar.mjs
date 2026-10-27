import * as THREE from 'three';
import { Air3FaceController } from './air3-face.mjs';
import { Air3AttentionController } from './air3-attention.mjs';
import { Air3TalkShoulders } from './air3-talk-shoulders.mjs';

// The UE export contains up to twelve influences. Three r186's standard skin
// shader and GLTFLoader.normalizeSkinWeights use four. This local adapter keeps
// the remaining weights, and also updates CPU bounds and shadow materials.
const _base = new THREE.Vector4(), _sum = new THREE.Vector4(), _part = new THREE.Vector4();
const _bone = new THREE.Matrix4();

export function extendedBoneTransform(index, target) {
  const attrs = this.geometry.attributes;
  _base.set(target.x, target.y, target.z, target.isVector4 ? target.w : 1).applyMatrix4(this.bindMatrix);
  _sum.set(0, 0, 0, 0);
  for (const [jointName, weightName] of [['skinIndex', 'skinWeight'], ['joints_1', 'weights_1'], ['joints_2', 'weights_2']]) {
    const joints = attrs[jointName], weights = attrs[weightName];
    if (!joints || !weights) continue;
    for (let c = 0; c < 4; c++) {
      const weight = weights.getComponent(index, c);
      if (weight === 0) continue;
      const joint = joints.getComponent(index, c);
      _bone.multiplyMatrices(this.skeleton.bones[joint].matrixWorld, this.skeleton.boneInverses[joint]);
      _sum.addScaledVector(_part.copy(_base).applyMatrix4(_bone), weight);
    }
  }
  _sum.applyMatrix4(this.bindMatrixInverse);
  target.set(_sum.x, _sum.y, _sum.z, target.isVector4 ? _sum.w : undefined);
  return target;
}

export function patchSkinMaterial(material, sets) {
  if (material.onBeforeCompile?.air3SkinPatchedSets === sets) return material;
  const previousCompile = material.onBeforeCompile;
  // Evaluate before replacing the callback: Three's default cache key calls
  // this.onBeforeCompile.toString(), which would otherwise become recursive.
  const previousCacheKey = material.customProgramCacheKey?.() ?? material.type;
  const declarations = Array.from({ length: sets - 1 }, (_, i) =>
    `attribute vec4 joints_${i + 1};\nattribute vec4 weights_${i + 1};`).join('\n');
  const terms = [];
  for (let set = 0; set < sets; set++) {
    for (const c of ['x', 'y', 'z', 'w']) {
      terms.push(`air3SkinMatrix += getBoneMatrix(${set ? `joints_${set}` : 'skinIndex'}.${c}) * ${set ? `weights_${set}` : 'skinWeight'}.${c};`);
    }
  }
  material.onBeforeCompile = function (shader, renderer) {
    previousCompile?.call(this, shader, renderer);
    for (const chunk of ['skinning_pars_vertex', 'skinbase_vertex', 'skinning_vertex']) {
      if (!shader.vertexShader.includes(`#include <${chunk}>`)) throw new Error(`AIR3 skinning: missing Three shader chunk ${chunk}`);
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <skinning_pars_vertex>', `#include <skinning_pars_vertex>\n#ifdef USE_SKINNING\n${declarations}\n#endif`)
      .replace('#include <skinbase_vertex>', `#ifdef USE_SKINNING\nmat4 air3SkinMatrix = mat4(0.0);\n${terms.join('\n')}\n#endif`)
      .replace('#include <skinnormal_vertex>', `#ifdef USE_SKINNING
        mat4 skinMatrix = bindMatrixInverse * air3SkinMatrix * bindMatrix;
        objectNormal = (skinMatrix * vec4(objectNormal, 0.0)).xyz;
        #ifdef USE_TANGENT
          objectTangent = (skinMatrix * vec4(objectTangent, 0.0)).xyz;
        #endif
      #endif`)
      .replace('#include <skinning_vertex>', `#ifdef USE_SKINNING
        transformed = (bindMatrixInverse * air3SkinMatrix * bindMatrix * vec4(transformed, 1.0)).xyz;
      #endif`);
  };
  material.onBeforeCompile.air3SkinPatchedSets = sets;
  material.customProgramCacheKey = () => `${previousCacheKey}|air3-skin-${sets * 4}-r186-v2`;
  material.needsUpdate = true;
  return material;
}

export function prepareExtendedSkinning(root) {
  let extendedMeshes = 0;
  root.traverse((mesh) => {
    if (!mesh.isSkinnedMesh) return;
    const geometry = mesh.geometry, attrs = geometry.attributes;
    const share = attrs._air3_weight_sum_0;
    if (!share || !attrs.weights_1) return;
    if (!geometry.userData.air3WeightsRestored) {
      const weights = attrs.skinWeight;
      // The builder emits float32 weights, so undoing the loader's set0-only
      // normalization does not quantize them back to an eight-bit approximation.
      for (let i = 0; i < weights.count; i++) {
        const s = share.getX(i);
        weights.setXYZW(i, weights.getX(i) * s, weights.getY(i) * s, weights.getZ(i) * s, weights.getW(i) * s);
      }
      weights.needsUpdate = true;
      geometry.userData.air3WeightsRestored = true;
    }
    const sets = attrs.weights_2 ? 3 : 2;
    if (mesh.userData.air3ExtendedSkinMaterial !== mesh.material.uuid) {
      const sourceMaterial = mesh.material, material = sourceMaterial.clone();
      // Material.clone() does not preserve shader callbacks. Eye/hair shaders
      // must compose with skinning instead of being silently discarded.
      material.onBeforeCompile = sourceMaterial.onBeforeCompile;
      material.customProgramCacheKey = sourceMaterial.customProgramCacheKey;
      mesh.material = patchSkinMaterial(material, sets);
      mesh.customDepthMaterial?.dispose(); mesh.customDistanceMaterial?.dispose();
      const shadowOptions = { map: mesh.material.map, alphaMap: mesh.material.alphaMap,
        alphaTest: mesh.material.alphaTest, side: mesh.material.side };
      mesh.customDepthMaterial = patchSkinMaterial(new THREE.MeshDepthMaterial({
        ...shadowOptions, depthPacking: THREE.RGBADepthPacking }), sets);
      mesh.customDistanceMaterial = patchSkinMaterial(new THREE.MeshDistanceMaterial(shadowOptions), sets);
      mesh.applyBoneTransform = extendedBoneTransform;
      mesh.userData.air3ExtendedSkinning = true;
      mesh.userData.air3ExtendedSkinMaterial = mesh.material.uuid;
      mesh.boundingBox = null; mesh.boundingSphere = null;
    }
    // Poses can extend beyond the neutral bounds. No per-frame CPU mesh scan.
    mesh.frustumCulled = false;
    extendedMeshes++;
  });
  return extendedMeshes;
}

export class Air3AvatarRig {
  constructor(gltf, { lockRootOrientation = true, groundFeet = true, stabilizeTalkShoulders = true } = {}) {
    this.root = gltf.scene;
    this.extendedMeshes = prepareExtendedSkinning(this.root);
    this.root.updateMatrixWorld(true);
    this.bodyBones = new Map(); this.targets = new Map(); this.targetRoots = [];
    this.tmpWorld = new THREE.Matrix4(); this.tmpLocal = new THREE.Matrix4();
    this.speaking = false; this.idleIndex = 0; this.talkIndex = 0;
    this.normalY = -1;
    const bodyPrefix = 'body__';
    this.root.traverse((node) => {
      if (node.isBone && node.name.startsWith(bodyPrefix)) this.bodyBones.set(node.name.slice(bodyPrefix.length), node);
      if (node.isMesh) {
        node.frustumCulled = false;
        if (node.material.normalMap && node.material.userData.air3NormalConvention) {
          node.material.normalScale.y *= this.normalY;
        }
      }
    });
    this.lockRootOrientation = lockRootOrientation;
    this.bodyRoot = this.bodyBones.get('root');
    this.bodyRootRestQuaternion = this.bodyRoot?.quaternion.clone();
    this.root.traverse((node) => {
      if (!node.isBone) return;
      const prefix = node.name.startsWith('face__') ? 'face__' : node.name.startsWith('outfit__') ? 'outfit__' : null;
      if (!prefix) return;
      const source = this.bodyBones.get(node.name.slice(prefix.length));
      if (!source) return;
      const offset = source.matrixWorld.clone().invert().multiply(node.matrixWorld);
      this.targets.set(node, { source, offset });
    });
    this.targetRoots = this.root.children.filter((node) => node.name.startsWith('face__') || node.name.startsWith('outfit__'));
    this.attachments = [];
    const head = this.bodyBones.get('head');
    if (head) for (const node of this.root.children) {
      if (node.name.startsWith('hair__') || node.name.startsWith('brows__')) {
        this.attachments.push({ node, source: head, offset: head.matrixWorld.clone().invert().multiply(node.matrixWorld) });
      }
    }
    this.face = new Air3FaceController(this.root);
    this.attention = new Air3AttentionController(this.root, this.bodyBones);
    this.bodyPoseLayer = null; this.bodyPoseLayerApplied = false;
    this.bodyPoseBase = [...this.bodyBones.values()].map(node => ({ node,
      position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3() }));
    this.groundFeet = groundFeet;
    this.groundAnchors = []; this.groundY = Infinity;
    this.groundPoint = new THREE.Vector3(); this.rootInverse = new THREE.Matrix4();
    this.rootInverse.copy(this.root.matrixWorld).invert();
    // Cover both soles with a small spatial grid, rather than scanning the full
    // skinned mesh each frame. This keeps standing clips in contact with stage.
    this.root.traverse((node) => {
      if (!node.isSkinnedMesh || !node.name.startsWith('outfit__')) return;
      const a = node.geometry.attributes.position;
      let minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < a.count; i++) { minY = Math.min(minY, a.getY(i)); maxY = Math.max(maxY, a.getY(i)); }
      if (maxY > .25 || minY > .05) return;
      const cells = new Map();
      for (let i = 0; i < a.count; i++) {
        if (a.getY(i) > minY + .022) continue;
        const key = `${Math.floor(a.getX(i) / .025)}:${Math.floor(a.getZ(i) / .025)}`;
        const old = cells.get(key);
        if (old === undefined || a.getY(i) < a.getY(old)) cells.set(key, i);
      }
      for (const index of cells.values()) {
        node.getVertexPosition(index, this.groundPoint).applyMatrix4(node.matrixWorld).applyMatrix4(this.rootInverse);
        this.groundY = Math.min(this.groundY, this.groundPoint.y);
        this.groundAnchors.push({ node, index });
      }
    });
    this.mixer = new THREE.AnimationMixer(this.root);
    this.motionActions = new Map();
    this.customClips = new Map(); this.manualClip = null;
    this.idles = gltf.animations.filter((clip) => /idle/i.test(clip.name));
    this.talks = gltf.animations.filter((clip) => /talk/i.test(clip.name));
    this.active = null;
    this.setMotion('idle', 0, true);
    this.elapsed = 0;
    this.update(0);
    this.talkShoulders = new Air3TalkShoulders(this.root, this.bodyBones,
      { enabled: stabilizeTalkShoulders && this.active?.getClip().name === 'MH_Idle01_UE' });
  }

  setNormalY(value) {
    const sign = value < 0 ? -1 : 1;
    if (sign === this.normalY) return;
    this.root.traverse((node) => {
      if (node.isMesh && node.material.normalMap && node.material.userData.air3NormalConvention) node.material.normalScale.y *= -1;
    });
    this.normalY = sign;
  }

  setMotion(kind, index = 0, immediate = false) {
    const clips = kind === 'talk' ? this.talks : this.idles;
    const clip = clips[index % Math.max(1, clips.length)];
    if (!clip) return false;
    this.manualClip = null;
    return this.playMotionClip(clip, kind, immediate);
  }

  playMotionClip(clip, kind, immediate = false) {
    const next = this.mixer.clipAction(clip);
    if (next === this.active && next.isRunning()) return true;
    const oneShot = clip.userData?.oneShot === true;
    next.setLoop(oneShot ? THREE.LoopOnce : THREE.LoopRepeat, oneShot ? 1 : Infinity);
    next.clampWhenFinished = oneShot;
    if (!this.motionActions.has(next)) this.motionActions.set(next, { action: next, weight: 0 });
    if (!next.isRunning()) next.reset().setEffectiveTimeScale(1).setEffectiveWeight(0).play();
    // One normalized weight set survives rapid speech/idle changes. Replacing
    // per-action fade schedules used to restart clips while earlier fades were
    // still active, allowing the total contributing weight to fluctuate.
    if (!this.active || immediate) for (const row of this.motionActions.values()) {
      row.weight = row.action === next ? 1 : 0; row.action.setEffectiveWeight(row.weight);
      if (!row.weight) row.action.stop();
    }
    this.active = next; this.motion = kind; this.elapsed = 0;
    return true;
  }

  setSpeech(state) {
    this.face.setSpeech(state);
    const speaking = state.phase === 'playing';
    if (speaking === this.speaking) return;
    this.speaking = speaking;
    if (this.manualClip) return; // An explicitly selected capture remains selected while voice drives the face.
    if (speaking) this.setMotion('talk', this.talkIndex++);
    else this.setMotion('idle', this.idleIndex++);
  }

  registerClips(clips) {
    if (!Array.isArray(clips) || clips.some(clip => !clip?.isAnimationClip && !(clip instanceof THREE.AnimationClip))) return false;
    for (const clip of clips) this.customClips.set(clip.name, clip);
    return true;
  }

  setClip(name, { immediate = true } = {}) {
    if (this.customClips.has(name)) {
      this.manualClip = name;
      return this.playMotionClip(this.customClips.get(name), 'capture', immediate);
    }
    const idle = this.idles.findIndex((clip) => clip.name === name);
    if (idle >= 0) return this.setMotion('idle', idle, immediate);
    const talk = this.talks.findIndex((clip) => clip.name === name);
    return talk >= 0 ? this.setMotion('talk', talk, immediate) : false;
  }

  setTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return false;
    this.attention.restore(); this.restoreBodyPoseLayer(); this.talkShoulders?.restore();
    this.mixer.setTime(seconds); this.face.time = seconds; this.update(0); return true;
  }
  setEmotion(name, intensity) { return this.face.setEmotion(name, intensity); }
  setFacialPreview(value) { this.face.setPreview(value); this.update(0); }
  clearFacialPreview() { this.face.clearPreview(); }
  setCameraTarget(value) { return this.attention.setCameraTarget(value); }
  setAttentionTarget(value, options) { return this.attention.setAttentionTarget(value, options); }
  clearAttentionTarget() { this.attention.clearAttentionTarget(); }
  setEyeContactEnabled(value) { this.attention.setEnabled(value); }
  setMicroExpressionsEnabled(value) { this.face.microExpressions = !!value; }
  setBodyPoseLayer(callback) {
    if (callback !== null && typeof callback !== 'function') return false;
    this.attention.restore(); this.restoreBodyPoseLayer(); this.bodyPoseLayer = callback; return true;
  }
  restoreBodyPoseLayer() {
    if (!this.bodyPoseLayerApplied) return;
    for (const row of this.bodyPoseBase) {
      row.node.position.copy(row.position); row.node.quaternion.copy(row.quaternion); row.node.scale.copy(row.scale);
    }
    this.bodyPoseLayerApplied = false;
  }
  updateMotionWeights(dt) {
    const blend = 1 - Math.exp(-Math.min(.25, dt) / .18);
    let total = 0;
    for (const row of this.motionActions.values()) {
      row.weight += ((row.action === this.active ? 1 : 0) - row.weight) * blend;
      if (row.weight < .0001 && row.action !== this.active) row.weight = 0;
      total += row.weight;
    }
    for (const row of this.motionActions.values()) {
      row.weight = total > 0 ? row.weight / total : 0;
      row.action.setEffectiveWeight(row.weight);
      if (!row.weight && row.action !== this.active) row.action.stop();
    }
  }

  syncSubtree(node) {
    const pair = this.targets.get(node);
    if (pair) {
      this.tmpWorld.copy(pair.source.matrixWorld).multiply(pair.offset);
      this.tmpLocal.copy(node.parent.matrixWorld).invert().multiply(this.tmpWorld);
      this.tmpLocal.decompose(node.position, node.quaternion, node.scale);
      // Corrective bones in MH_Talk use non-uniform scales. Keep the complete
      // affine matrix rather than losing shear through TRS decomposition.
      node.matrix.copy(this.tmpLocal); node.matrixAutoUpdate = false;
    }
    if (node.matrixAutoUpdate) node.updateMatrix();
    node.matrixWorld.multiplyMatrices(node.parent.matrixWorld, node.matrix);
    node.matrixWorldNeedsUpdate = false;
    for (const child of node.children) this.syncSubtree(child);
  }

  update(dt) {
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    this.elapsed += dt;
    this.attention.restore();
    this.restoreBodyPoseLayer();
    this.talkShoulders?.restore();
    this.updateMotionWeights(dt);
    this.mixer.update(dt);
    if (this.lockRootOrientation && this.bodyRoot) this.bodyRoot.quaternion.copy(this.bodyRootRestQuaternion);
    const talkWeight = [...this.motionActions.values()].reduce((sum, row) =>
      sum + (this.talks.includes(row.action.getClip()) ? row.weight : 0), 0);
    this.talkShoulders?.apply(talkWeight);
    if (this.bodyPoseLayer) {
      for (const row of this.bodyPoseBase) {
        row.position.copy(row.node.position); row.quaternion.copy(row.node.quaternion); row.scale.copy(row.node.scale);
      }
      this.bodyPoseLayerApplied = true; this.bodyPoseLayer(dt, this);
    }
    this.root.updateMatrixWorld(true);
    this.attention.updateHead(dt, this.speaking);
    for (const target of this.targetRoots) this.syncSubtree(target);
    this.face.setGazeAngles(this.attention.updateEyes(dt));
    this.face.update(dt);
    this.root.updateMatrixWorld(true);
    if (this.groundFeet && this.groundAnchors.length && this.bodyRoot) {
      this.rootInverse.copy(this.root.matrixWorld).invert();
      let lowest = Infinity;
      for (const { node, index } of this.groundAnchors) {
        node.getVertexPosition(index, this.groundPoint).applyMatrix4(node.matrixWorld).applyMatrix4(this.rootInverse);
        lowest = Math.min(lowest, this.groundPoint.y);
      }
      const offset = this.groundY - lowest;
      if (Number.isFinite(offset) && Math.abs(offset) < .2) {
        this.bodyRoot.position.y += offset;
        this.root.updateMatrixWorld(true);
        for (const target of this.targetRoots) this.syncSubtree(target);
      }
    }
    for (const { node, source, offset } of this.attachments) {
      this.tmpWorld.copy(source.matrixWorld).multiply(offset);
      this.tmpLocal.copy(node.parent.matrixWorld).invert().multiply(this.tmpWorld);
      this.tmpLocal.decompose(node.position, node.quaternion, node.scale);
      node.updateMatrixWorld(true);
    }
  }

  diagnostics() {
    return { profile: 'AIR3 source geometry with translation-retargeted animations', extendedSkinMeshes: this.extendedMeshes,
      preservedSkinInfluences: 12, idleClips: this.idles.length, talkClips: this.talks.length,
      motion: this.motion ?? 'neutral', facialLipSync: this.face.diagnostics(),
      talkShoulders: this.talkShoulders?.diagnostics(),
      attention: this.attention.diagnostics(),
      motionBlend: { mode: 'normalized continuous weights', timeConstantSeconds: .18,
        contributingActions: [...this.motionActions.values()].filter(row => row.weight > .001).length,
        weightSum: [...this.motionActions.values()].reduce((sum, row) => sum + row.weight, 0) },
      rootOrientationLocked: this.lockRootOrientation,
      footContactAnchors: this.groundAnchors.length,
      materials: this.root.userData.air3Materials?.diagnostics ?? 'configured material profile', normalY: this.normalY };
  }

  dispose() {
    this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.root);
    this.root.traverse((node) => { node.customDepthMaterial?.dispose(); node.customDistanceMaterial?.dispose(); });
  }
}
