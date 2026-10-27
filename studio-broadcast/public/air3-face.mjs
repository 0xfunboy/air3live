import * as THREE from 'three';

// A bounded WebGL facial rig. Semantic names were checked against the supplied
// 815-entry metadata and source morph support. These are skeletal articulations
// plus 29 small corrective shapes, not an implementation of MetaHuman RigLogic.
export const MOUTH_POSES = Object.freeze({
  X: { jaw: 0, width: 0, purse: 0, press: 0, lowerUp: 0, tongue: 0 },
  A: { jaw: 0, width: 0, purse: 0, press: 1, lowerUp: 0, tongue: 0 },
  B: { jaw: .045, width: .18, purse: 0, press: 0, lowerUp: 0, tongue: 0 },
  C: { jaw: .13, width: .65, purse: 0, press: 0, lowerUp: 0, tongue: 0 },
  D: { jaw: .23, width: .10, purse: 0, press: 0, lowerUp: 0, tongue: 0 },
  E: { jaw: .12, width: -.22, purse: .65, press: 0, lowerUp: 0, tongue: 0 },
  F: { jaw: .055, width: -.50, purse: 1, press: 0, lowerUp: 0, tongue: 0 },
  G: { jaw: .035, width: .10, purse: 0, press: 0, lowerUp: 1, tongue: 0 },
  H: { jaw: .09, width: .35, purse: 0, press: 0, lowerUp: 0, tongue: 1 },
});
export const EMOTIONS = Object.freeze(['neutral', 'warm', 'happy', 'sad', 'focused', 'concerned', 'surprised']);

export function normalizeEmotionName(name) {
  if (!name || typeof name !== 'string') return 'neutral';
  const n = name.trim().toLowerCase();
  switch (n) {
    case 'happy':
    case 'felice':
    case 'leggermente felice':
    case 'joy':
    case 'sorridente':
      return 'happy';
    case 'sad':
    case 'triste':
    case 'leggermente triste':
    case 'sorrow':
      return 'sad';
    case 'surprised':
    case 'stupita':
    case 'sorpresa':
      return 'surprised';
    case 'warm':
    case 'cordiale':
      return 'warm';
    case 'focused':
    case 'concentrata':
    case 'attenta':
      return 'focused';
    case 'concerned':
    case 'preoccupata':
      return 'concerned';
    case 'neutral':
    case 'neutra':
    default:
      return EMOTIONS.includes(n) ? n : 'neutral';
  }
}

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(value) ? value : 0));
const tmp = new THREE.Vector3(), q = new THREE.Quaternion();
const axes = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

export function blendMouthPoses(weights) {
  if (!weights || typeof weights !== 'object') return null;
  const result = Object.fromEntries(Object.keys(MOUTH_POSES.X).map(key => [key, 0]));
  let total = 0;
  for (const [name, pose] of Object.entries(MOUTH_POSES)) {
    const weight = weights[name];
    if (!Number.isFinite(weight) || weight <= 0) continue;
    const bounded = Math.min(1, weight); total += bounded;
    for (const key of Object.keys(result)) result[key] += pose[key] * bounded;
  }
  if (total < 1e-9) return null;
  for (const key of Object.keys(result)) result[key] /= total;
  return result;
}

export class Air3FaceController {
  constructor(root) {
    this.root = root; root.updateMatrixWorld(true);
    this.faceRoot = root.getObjectByName('face__FACIAL_C_FacialRoot');
    this.bones = new Map(); this.morphs = []; this.brows = [];
    this.time = 0; this.nextBlink = 3.3; this.blinkNumber = 0; this.preview = null;
    this.speech = { phase: 'idle', mouthCue: 'X', amplitude: 0 };
    this.emotion = 'neutral'; this.emotionIntensity = .35; this.currentEmotion = Object.fromEntries(EMOTIONS.map(n => [n, 0]));
    this.currentPose = { ...MOUTH_POSES.X }; this.currentCue = 'X'; this.blink = 0;
    this.gazeAngles = null; this.microExpressions = true; this.microSmile = 0;
    const controlled = new Set(['FACIAL_C_Jaw', 'FACIAL_C_LowerLipRotation', 'FACIAL_C_LipUpper',
      'FACIAL_C_LipLower', 'FACIAL_C_MouthUpper', 'FACIAL_C_MouthLower', 'FACIAL_C_Tongue3']);
    for (const side of ['L', 'R']) for (const region of ['Eye', 'EyelidUpperA', 'EyelidUpperB',
      'EyelidLowerA', 'EyelidLowerB', 'LipUpper', 'LipUpperOuter', 'LipLower', 'LipLowerOuter',
      'LipCorner', 'ForeheadIn', 'ForeheadMid', 'ForeheadOut', 'CheekInner']) controlled.add(`FACIAL_${side}_${region}`);
    root.traverse((node) => {
      if (this.faceRoot && node.isBone && controlled.has(node.name.slice(6))) {
        const localFromFace = new THREE.Matrix4().copy(node.parent.matrixWorld).invert().multiply(this.faceRoot.matrixWorld);
        this.bones.set(node.name.slice(6), { node, position: node.position.clone(), quaternion: node.quaternion.clone(),
          scale: node.scale.clone(), vectorBasis: new THREE.Matrix3().setFromMatrix4(localFromFace) });
      }
      if (node.isMesh && node.morphTargetDictionary) this.morphs.push(node);
      if (node.isMesh && node.name.startsWith('brows__')) this.brows.push({ node,
        positions: node.geometry.attributes.position.array.slice(), offset: NaN });
    });
    this.ready = !!this.faceRoot && ['FACIAL_C_Jaw', 'FACIAL_C_LowerLipRotation', 'FACIAL_L_Eye', 'FACIAL_R_Eye']
      .every(name => this.bones.has(name));
  }

  setSpeech(state = {}) {
    this.speech = { ...state };
    if (typeof state.emotion === 'string') this.setEmotion(state.emotion, state.emotionIntensity);
    else if (state.emotion && typeof state.emotion === 'object') this.setEmotion(state.emotion.name, state.emotion.intensity);
  }
  setEmotion(name = 'neutral', intensity = .35) {
    const normalized = normalizeEmotionName(name);
    if (!EMOTIONS.includes(normalized)) return false;
    this.emotion = normalized; this.emotionIntensity = clamp(intensity ?? .35, 0, 1); return true;
  }
  setPreview(value = {}) {
    this.preview = { ...value };
    if (typeof value.emotion === 'string') this.setEmotion(value.emotion, value.intensity);
  }
  clearPreview() { this.preview = null; }
  setGazeAngles(value) { this.gazeAngles = value; }

  rotate(name, axis, angle) {
    const record = this.bones.get(name); if (!record || !angle) return;
    record.node.quaternion.multiply(q.setFromAxisAngle(axes[axis], angle));
  }
  translate(name, left, up, forward) {
    const record = this.bones.get(name); if (!record) return;
    // The supplied facial root's +X is left, +Y is forward, +Z is down.
    tmp.set(left, forward, -up).applyMatrix3(record.vectorBasis);
    record.node.position.add(tmp);
  }
  morph(suffix, weight, prefix = 'head_lod0_mesh') {
    const name = `${prefix}__${suffix}`, w = clamp(weight, 0, 1);
    for (const mesh of this.morphs) {
      const index = mesh.morphTargetDictionary[name];
      if (index !== undefined) mesh.morphTargetInfluences[index] = w;
    }
  }

  update(dt) {
    if (!this.ready) return;
    dt = clamp(dt, 0, .25); this.time += dt;
    for (const { node, position, quaternion, scale } of this.bones.values()) {
      node.position.copy(position); node.quaternion.copy(quaternion); node.scale.copy(scale);
    }
    for (const mesh of this.morphs) mesh.morphTargetInfluences.fill(0);
    const speaking = this.speech.phase === 'playing';
    const requested = this.preview?.mouthCue ?? (speaking ? this.speech.mouthCue : 'X');
    const cue = typeof requested === 'string' && Object.hasOwn(MOUTH_POSES, requested) ? requested : null;
    const weighted = speaking && !this.preview ? blendMouthPoses(this.speech.mouthWeights) : null;
    const pose = weighted ?? (cue ? { ...MOUTH_POSES[cue] } : { ...MOUTH_POSES.X, jaw: clamp(this.speech.amplitude, 0, 1) * .16 });
    // The recognizer supplies the shape and timing. The actual audio envelope
    // only softens its jaw amplitude so a quiet vowel does not look shouted.
    if (speaking && !this.preview && cue) pose.jaw *= .6 + .4 * Math.sqrt(clamp(this.speech.amplitude, 0, 1));
    this.currentCue = cue ?? 'amplitude';
    const blend = this.preview ? 1 : 1 - Math.exp(-(weighted ? 36 : 22) * dt);
    for (const key of Object.keys(this.currentPose)) this.currentPose[key] += (pose[key] - this.currentPose[key]) * blend;
    const ep = this.preview ? 1 : 1 - Math.exp(-5 * dt);
    for (const name of EMOTIONS) this.currentEmotion[name] += ((name === this.emotion ? this.emotionIntensity : 0) - this.currentEmotion[name]) * ep;
    const { warm, happy, sad, focused, concerned, surprised } = this.currentEmotion;
    // Small breath-like changes preserve the chosen expression. They do not
    // switch into surprise/sadness without an explicit semantic command.
    const microCycle = (this.time % 11.7) / 11.7;
    const microEnvelope = microCycle > .57 && microCycle < .87 ? Math.sin(Math.PI * (microCycle - .57) / .30) ** 2 : 0;
    this.microSmile = !this.preview && this.microExpressions && ['neutral', 'warm', 'happy'].includes(this.emotion)
      ? (.055 + .10 * microEnvelope) * (speaking ? .7 : 1) : 0;
    const smile = warm * .7 + happy * .88 + this.microSmile;
    const frown = concerned * .6 + sad * 1.0;
    const mouthEmotion = speaking ? .22 : 1;
    const p = this.currentPose, jaw = p.jaw + surprised * .065 * mouthEmotion;
    // Both chains rotate about the same calibrated hinge. Teeth and tongue are
    // children of LowerLipRotation, while the chin follows Jaw.
    this.rotate('FACIAL_C_Jaw', 'x', jaw);
    this.rotate('FACIAL_C_LowerLipRotation', 'x', jaw * .96);
    this.translate('FACIAL_C_Jaw', 0, -jaw * .002, jaw * .001);
    this.translate('FACIAL_C_LowerLipRotation', 0, -jaw * .002, jaw * .001);
    const squeeze = p.purse * .0038, forward = p.purse * .0045;
    // The two mouth groups narrow around their own centres. Teeth have separate
    // chains, so pursing changes the lips without shrinking the dental arches.
    for (const name of ['FACIAL_C_MouthUpper', 'FACIAL_C_MouthLower']) {
      const record = this.bones.get(name);
      if (record) record.node.scale.x *= 1 - .20 * p.purse;
    }
    const upperPress = p.press * -.0009, lowerPress = p.press * .0012 + p.lowerUp * .0025;
    for (const side of ['L', 'R']) {
      const sign = side === 'L' ? 1 : -1;
      this.translate(`FACIAL_${side}_LipCorner`, sign * (p.width * .0033 - squeeze + smile * .0020 * mouthEmotion),
        (smile * .0018 - frown * .0012) * mouthEmotion, forward * .65);
      for (const region of ['LipUpper', 'LipUpperOuter']) this.translate(`FACIAL_${side}_${region}`,
        -sign * squeeze * .55, upperPress + p.lowerUp * .0006, forward);
      for (const region of ['LipLower', 'LipLowerOuter']) this.translate(`FACIAL_${side}_${region}`,
        -sign * squeeze * .55, lowerPress, forward - p.lowerUp * .0018);
      this.translate(`FACIAL_${side}_ForeheadIn`, -sign * focused * .0005,
        frown * .0022 + surprised * .0028 - focused * .0007 + smile * .0004, 0);
      this.translate(`FACIAL_${side}_ForeheadMid`, 0, surprised * .0027 + smile * .0004 - focused * .0005 - frown * .0003, 0);
      this.translate(`FACIAL_${side}_ForeheadOut`, 0, surprised * .0021 + smile * .0003 - frown * .0003, 0);
      this.translate(`FACIAL_${side}_CheekInner`, 0, smile * .0010, 0);
    }
    this.translate('FACIAL_C_LipUpper', 0, upperPress + p.lowerUp * .0006, forward);
    this.translate('FACIAL_C_LipLower', 0, lowerPress, forward - p.lowerUp * .0018);
    this.rotate('FACIAL_C_Tongue3', 'x', -p.tongue * .16);
    this.translate('FACIAL_C_Tongue3', 0, p.tongue * .0015, p.tongue * .001);

    let blink = 0;
    if (this.time >= this.nextBlink) {
      const progress = (this.time - this.nextBlink) / .19;
      if (progress <= 1) blink = Math.sin(Math.PI * progress) ** 2;
      else { this.blinkNumber++; this.nextBlink = this.time + 3.1 + (this.blinkNumber * 1.618 % 2.0); }
    }
    if (this.preview?.blink !== undefined) blink = clamp(this.preview.blink, 0, 1);
    this.blink = blink;
    const gazeX = this.preview?.gazeX !== undefined ? clamp(this.preview.gazeX, -1, 1) : Math.sin(this.time * .37) * .035;
    const sadGaze = sad * .06;
    const gazeY = this.preview?.gazeY !== undefined ? clamp(this.preview.gazeY, -1, 1) : Math.sin(this.time * .23 + .7) * .025;
    for (const side of ['L', 'R']) {
      const attention = this.gazeAngles?.[side === 'L' ? 'left' : 'right'];
      const eyeYaw = this.preview?.gazeX !== undefined ? gazeX * .13 : (attention?.yaw ?? 0) + gazeX * .13;
      const eyePitch = this.preview?.gazeY !== undefined ? gazeY * .09 : (attention?.pitch ?? 0) + (gazeY - sadGaze) * .09;
      this.rotate(`FACIAL_${side}_Eye`, 'z', -eyeYaw);
      this.rotate(`FACIAL_${side}_Eye`, 'x', -eyePitch);
      const squint = smile * .03 + focused * .035;
      const relaxedLid = .035 * (1 - blink) * (1 - surprised * .7) + sad * .02;
      for (const part of ['A', 'B']) {
        this.rotate(`FACIAL_${side}_EyelidUpper${part}`, 'x', blink * .58 + relaxedLid + squint - surprised * .065 - eyePitch * .28);
        this.rotate(`FACIAL_${side}_EyelidLower${part}`, 'x', -blink * .25 - squint * .35);
      }
      this.morph(`eye_blink_${side}`, blink * .65);
      this.morph(`eye_blink_${side}`, blink * .65, 'cartilage_lod0_mesh');
      this.morph(`eye_widen_${side}`, surprised * .4);
      this.morph(`eye_cheekRaise_${side}`, smile * .35);
      this.morph(`brow_down_${side}`, focused * .35 + sad * .1);
      this.morph(`brow_raiseIn_${side}`, frown * .55 + surprised * .4);
      this.morph(`brow_raiseOuter_${side === 'L' ? 'left' : 'right'}`, surprised * .35);
      this.morph(`mouth_cornerPull_${side === 'L' ? 'left' : 'right'}`, Math.max(0, p.width * .20 + smile * .30 * mouthEmotion));
      this.morph(`mouth_cornerDepress_${side}`, frown * .28 * mouthEmotion);
      this.morph(`mouth_lipsPress_${side}`, p.press * .35);
      for (const level of ['U', 'D']) {
        this.morph(`mouth_lipsPurse_${level}${side}`, p.purse * .5);
        this.morph(`mouth_funnel_${level}${side}`, p.purse * .35);
      }
    }
    this.morph('jaw_open', Math.min(1, jaw / .44) * .6);
    const browOffset = surprised * .0024 + smile * .00035 + frown * .00085 - focused * .0006;
    for (const record of this.brows) {
      if (Math.abs(browOffset - record.offset) < 1e-7) continue;
      const attr = record.node.geometry.attributes.position;
      for (let i = 0; i < attr.count; i++) attr.setY(i, record.positions[i * 3 + 1] + browOffset);
      attr.needsUpdate = true; record.offset = browOffset;
    }
  }

  diagnostics() {
    return { ready: this.ready, articulation: 'bounded skeletal poses plus source corrective morphs',
      controls: this.bones.size, sourceCorrectiveCount: 29, mouthCue: this.currentCue,
      emotion: this.emotion, emotionIntensity: this.emotionIntensity, blink: this.blink,
      microExpressions: this.microExpressions, microSmile: this.microSmile,
      mouthInterpolation: this.speech.mouthWeights ? 'audio-clock coarticulation plus damping' : 'bounded exponential damping',
      phoneticTiming: this.speech.lipSync ?? 'external timeline or amplitude fallback', rigLogicParity: false };
  }
}
