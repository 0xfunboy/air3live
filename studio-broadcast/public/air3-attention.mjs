import * as THREE from 'three';

const RAD = Math.PI / 180;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finitePoint = point => point && [point.x, point.y, point.z].every(Number.isFinite);

/**
 * Additive attention for the exported MetaHuman rig. The forward/up axes are
 * calibrated from FACIAL_C_FacialRoot in bind pose, not guessed from Euler
 * channels. Body pose is evaluated first; head/neck follows; eyes then solve
 * their remaining error in the synchronized face frame.
 */
export class Air3AttentionController {
  constructor(root, bodyBones) {
    this.root = root; this.head = bodyBones.get('head');
    this.faceRoot = root.getObjectByName('face__FACIAL_C_FacialRoot');
    this.eyes = ['L', 'R'].map(side => root.getObjectByName(`face__FACIAL_${side}_Eye`));
    this.chain = [['neck_01', .14], ['neck_02', .19], ['head', .67]]
      .map(([name, share]) => ({ node: bodyBones.get(name), share, base: new THREE.Quaternion() })).filter(row => row.node);
    const total = this.chain.reduce((sum, row) => sum + row.share, 0);
    for (const row of this.chain) row.share /= total;
    this.ready = !!this.head && !!this.faceRoot && this.eyes.every(Boolean);
    this.enabled = true; this.camera = null; this.override = null; this.applied = false;
    this.time = 0; this.headYaw = 0; this.headPitch = 0; this.initialized = false;
    this.eyeState = { left: { yaw: 0, pitch: 0 }, right: { yaw: 0, pitch: 0 } };
    this.cameraPoint = new THREE.Vector3(); this.target = new THREE.Vector3(); this.filteredTarget = new THREE.Vector3();
    this.origin = new THREE.Vector3(); this.direction = new THREE.Vector3(); this.forward = new THREE.Vector3();
    this.up = new THREE.Vector3(); this.right = new THREE.Vector3(); this.eyePoint = new THREE.Vector3();
    this.rotation = new THREE.Quaternion(); this.parentRotation = new THREE.Quaternion();
    this.yawRotation = new THREE.Quaternion(); this.pitchRotation = new THREE.Quaternion();
    this.localDelta = new THREE.Quaternion(); this.inverseFace = new THREE.Matrix4();
    this.baseForward = new THREE.Vector3(0, 0, 1); this.baseUp = new THREE.Vector3(0, 1, 0);
    if (this.ready) {
      root.updateMatrixWorld(true);
      const inverseHead = this.head.getWorldQuaternion(new THREE.Quaternion()).invert();
      this.baseForward.set(0, 1, 0).transformDirection(this.faceRoot.matrixWorld).applyQuaternion(inverseHead).normalize();
      this.baseUp.set(0, 0, -1).transformDirection(this.faceRoot.matrixWorld).applyQuaternion(inverseHead).normalize();
    }
    this.mode = 'unconfigured'; this.contact = false; this.glance = 0;
  }

  setCameraTarget(value) {
    if (value?.isObject3D) this.camera = value;
    else if (finitePoint(value)) this.camera = new THREE.Vector3(value.x, value.y, value.z);
    else if (Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)) this.camera = new THREE.Vector3(...value);
    else return false;
    return true;
  }
  setAttentionTarget(value, { weight = 1, kind = 'monitor' } = {}) {
    const point = Array.isArray(value) ? new THREE.Vector3(...value) : value;
    if (!finitePoint(point) || !Number.isFinite(weight)) return false;
    this.override = { point: new THREE.Vector3(point.x, point.y, point.z), weight: clamp(weight, 0, 1),
      kind: typeof kind === 'string' ? kind.slice(0, 48) : 'monitor' };
    return true;
  }
  clearAttentionTarget() { this.override = null; }
  setEnabled(value) { this.enabled = !!value; }

  restore() {
    if (!this.applied) return;
    for (const row of this.chain) row.node.quaternion.copy(row.base);
    this.applied = false;
  }

  updateHead(dt, speaking = false) {
    if (!this.ready) return;
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, .25); this.time += dt;
    if (this.camera?.isObject3D) this.camera.getWorldPosition(this.cameraPoint);
    else if (this.camera) this.cameraPoint.copy(this.camera);
    else if (!this.override) { this.mode = 'unconfigured'; return; }
    this.target.copy(this.cameraPoint);
    if (this.override) this.target.lerp(this.override.point, this.camera ? this.override.weight : 1);
    this.head.getWorldPosition(this.origin);
    this.head.getWorldQuaternion(this.rotation);
    this.forward.copy(this.baseForward).applyQuaternion(this.rotation).normalize();
    this.up.copy(this.baseUp).applyQuaternion(this.rotation).normalize();
    this.right.crossVectors(this.up, this.forward).normalize();

    // Small, brief lens breaks. They are independent of financial content and
    // never fabricate an emotion from market data. Speaking favors eye contact.
    const period = speaking ? 14 : 10.8, phase = this.time % period;
    const begin = speaking ? 12.2 : 8.9, length = speaking ? .55 : .85;
    const u = (phase - begin) / length;
    this.glance = !this.override && this.enabled && u > 0 && u < 1 ? Math.sin(Math.PI * u) ** 2 : 0;
    if (this.glance) {
      const distance = this.target.distanceTo(this.origin);
      const sign = Math.floor(this.time / period) % 2 ? -1 : 1;
      this.target.addScaledVector(this.right, sign * Math.tan(2.8 * RAD) * distance * this.glance);
      this.target.addScaledVector(this.up, -Math.tan(.7 * RAD) * distance * this.glance);
    }
    if (!this.initialized) { this.filteredTarget.copy(this.target); this.initialized = true; }
    else this.filteredTarget.lerp(this.target, 1 - Math.exp(-dt / .11));
    this.direction.subVectors(this.filteredTarget, this.origin);
    if (this.direction.lengthSq() < 1e-8) { this.mode = 'target-too-close'; return; }
    this.direction.normalize();
    const x = this.direction.dot(this.right), y = this.direction.dot(this.up), z = this.direction.dot(this.forward);
    const targetYaw = Math.atan2(x, z), targetPitch = Math.atan2(y, Math.hypot(x, z));
    const wantedYaw = this.enabled ? clamp(targetYaw * .73, -48 * RAD, 48 * RAD) : 0;
    const wantedPitch = this.enabled ? clamp(targetPitch * .65, -18 * RAD, 20 * RAD) : 0;
    const blend = 1 - Math.exp(-dt / .30);
    this.headYaw += (wantedYaw - this.headYaw) * blend;
    this.headPitch += (wantedPitch - this.headPitch) * blend;
    for (const row of this.chain) {
      row.base.copy(row.node.quaternion);
      this.yawRotation.setFromAxisAngle(this.up, this.headYaw * row.share);
      this.pitchRotation.setFromAxisAngle(this.right, -this.headPitch * row.share);
      this.rotation.copy(this.yawRotation).multiply(this.pitchRotation);
      row.node.parent.getWorldQuaternion(this.parentRotation);
      this.localDelta.copy(this.parentRotation).invert().multiply(this.rotation).multiply(this.parentRotation);
      row.node.quaternion.premultiply(this.localDelta).normalize();
      row.node.updateMatrixWorld(true);
    }
    this.applied = true;
    this.mode = this.enabled ? (this.override?.kind ?? 'camera') : 'disabled';
    this.contact = this.enabled && !this.override && this.glance < .15 && Math.abs(targetYaw) < 68 * RAD;
  }

  /** Call after body/face subtree synchronization, before facial animation. */
  updateEyes(dt) {
    if (!this.ready || !this.initialized) return null;
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, .25);
    this.inverseFace.copy(this.faceRoot.matrixWorld).invert();
    // The world target is already smoothed. Fast ocular compensation prevents
    // the eyes from lagging behind a nod in the underlying talk animation.
    const blend = 1 - Math.exp(-dt / .025);
    for (let index = 0; index < this.eyes.length; index++) {
      const side = index ? 'right' : 'left', state = this.eyeState[side];
      this.eyes[index].getWorldPosition(this.eyePoint);
      this.direction.subVectors(this.filteredTarget, this.eyePoint).transformDirection(this.inverseFace);
      // Facial bind coordinates: +X anatomical left, +Y forward, -Z up.
      const yaw = this.enabled ? clamp(Math.atan2(this.direction.x, this.direction.y), -24 * RAD, 24 * RAD) : 0;
      const pitch = this.enabled ? clamp(Math.atan2(-this.direction.z, Math.hypot(this.direction.x, this.direction.y)), -17 * RAD, 17 * RAD) : 0;
      state.yaw += (yaw - state.yaw) * blend;
      state.pitch += (pitch - state.pitch) * blend;
    }
    return this.eyeState;
  }

  diagnostics() {
    return { ready: this.ready, enabled: this.enabled, target: this.mode, lensContact: this.contact,
      headYawDegrees: this.headYaw / RAD, headPitchDegrees: this.headPitch / RAD,
      eyeYawDegrees: { left: this.eyeState.left.yaw / RAD, right: this.eyeState.right.yaw / RAD },
      eyePitchDegrees: { left: this.eyeState.left.pitch / RAD, right: this.eyeState.right.pitch / RAD },
      limitsDegrees: { headYaw: 48, headPitch: [-18, 20], eyeYaw: 24, eyePitch: 17 },
      calibratedAxes: true, headTimeConstantSeconds: .30, eyeTimeConstantSeconds: .025,
      cameraAssigned: !!this.camera, proceduralGlance: this.glance };
  }
}
