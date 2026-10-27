import * as THREE from 'three';

const SOFT_VARIATION = .008;

/** Height envelope for talk poses, calibrated from MH_Idle01_UE frame zero.
 * Adjusts only clavicle rotation and counter-rotates the attached upper arm.
 * Bone lengths, translations, scales and all captured leg tracks are retained.
 * Measurements use avatar-local space, so stage rotation/scale do not change
 * the result. The source shoulder bearing and arm direction are preserved.
 */
export class Air3TalkShoulders {
  constructor(root, bones, { enabled = true, reference = 'MH_Idle01_UE' } = {}) {
    this.root = root; this.neck = bones.get('neck_01'); this.enabled = enabled;
    this.inverse = new THREE.Matrix4(); this.parentInverse = new THREE.Matrix4();
    this.neckPoint = new THREE.Vector3(); this.claviclePoint = new THREE.Vector3();
    this.armPoint = new THREE.Vector3(); this.target = new THREE.Vector3();
    this.from = new THREE.Vector3(); this.to = new THREE.Vector3();
    this.rotation = new THREE.Quaternion(); this.counter = new THREE.Quaternion();
    this.reference = reference; this.applied = false; this.weight = 0;
    this.rows = ['l', 'r'].map(side => ({ side, clavicle: bones.get(`clavicle_${side}`), arm: bones.get(`upperarm_${side}`),
      clavicleQuaternion: new THREE.Quaternion(), armQuaternion: new THREE.Quaternion(), correctionRadians: 0 }))
      .filter(row => row.clavicle && row.arm && row.arm.parent === row.clavicle);
    if (!this.neck || this.rows.length !== 2) this.enabled = false;
    root.updateWorldMatrix(true, true); this.inverse.copy(root.matrixWorld).invert();
    if (this.neck) this.neck.getWorldPosition(this.neckPoint).applyMatrix4(this.inverse);
    for (const row of this.rows) {
      row.arm.getWorldPosition(this.armPoint).applyMatrix4(this.inverse);
      row.referenceGap = this.neckPoint.y - this.armPoint.y;
    }
  }

  restore() {
    if (!this.applied) return;
    for (const row of this.rows) {
      row.clavicle.quaternion.copy(row.clavicleQuaternion);
      row.arm.quaternion.copy(row.armQuaternion);
    }
    this.applied = false;
  }

  apply(weight) {
    this.weight = this.enabled ? THREE.MathUtils.clamp(weight, 0, 1) : 0;
    if (!this.weight) return;
    this.root.updateWorldMatrix(true, true); this.inverse.copy(this.root.matrixWorld).invert();
    this.neck.getWorldPosition(this.neckPoint).applyMatrix4(this.inverse);
    for (const row of this.rows) {
      const { clavicle, arm } = row;
      row.clavicleQuaternion.copy(clavicle.quaternion); row.armQuaternion.copy(arm.quaternion);
      clavicle.getWorldPosition(this.claviclePoint).applyMatrix4(this.inverse);
      arm.getWorldPosition(this.armPoint).applyMatrix4(this.inverse);
      const gap = this.neckPoint.y - this.armPoint.y;
      // tanh has a continuous derivative: no hard clamp/pop at the envelope.
      const softGap = row.referenceGap + SOFT_VARIATION * Math.tanh((gap - row.referenceGap) / SOFT_VARIATION);
      const targetGap = THREE.MathUtils.lerp(gap, softGap, this.weight);
      this.from.copy(this.armPoint).sub(this.claviclePoint);
      const length = this.from.length(), horizontal = Math.hypot(this.from.x, this.from.z);
      if (length < 1e-8 || horizontal < 1e-8) { row.correctionRadians = 0; continue; }
      const y = THREE.MathUtils.clamp(this.neckPoint.y - targetGap - this.claviclePoint.y, -.98 * length, .98 * length);
      const horizontalScale = Math.sqrt(Math.max(0, length * length - y * y)) / horizontal;
      this.target.set(this.from.x * horizontalScale, y, this.from.z * horizontalScale).add(this.claviclePoint)
        .applyMatrix4(this.root.matrixWorld);
      this.parentInverse.copy(clavicle.parent.matrixWorld).invert();
      this.to.copy(this.target).applyMatrix4(this.parentInverse).sub(clavicle.position).normalize();
      this.from.copy(arm.position).multiply(clavicle.scale).applyQuaternion(clavicle.quaternion).normalize();
      this.rotation.setFromUnitVectors(this.from, this.to);
      clavicle.quaternion.premultiply(this.rotation).normalize();
      // Keep the captured arm orientation in the chest frame, rather than
      // turning an open-hand gesture into an artificial shoulder shrug.
      this.counter.copy(clavicle.quaternion).invert().multiply(row.clavicleQuaternion);
      arm.quaternion.premultiply(this.counter).normalize();
      row.correctionRadians = row.clavicleQuaternion.angleTo(clavicle.quaternion);
    }
    this.applied = true;
  }

  diagnostics() {
    return { enabled: this.enabled, reference: `${this.reference} frame 0`,
      maximumSoftVariationMetres: SOFT_VARIATION, talkWeight: this.weight,
      method: 'avatar-local shoulder height envelope with arm counter-rotation',
      shoulders: this.rows.map(row => ({ side: row.side, referenceNeckGapMetres: row.referenceGap,
        correctionDegrees: THREE.MathUtils.radToDeg(row.correctionRadians) })) };
  }
}
