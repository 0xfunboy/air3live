import * as THREE from 'three';
import { ACCAD_MOTION } from './assets/air3/motion/accad-female1.mjs';

const clamp = THREE.MathUtils.clamp;
const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const captureFor = id => Object.hasOwn(ACCAD_MOTION.clips, id) ? ACCAD_MOTION.clips[id] :
  ACCAD_MOTION.variants && Object.hasOwn(ACCAD_MOTION.variants, id) ? ACCAD_MOTION.variants[id] : null;
export const MOCAP_CATALOG = Object.freeze(Object.keys(ACCAD_MOTION.clips).map(id => Object.freeze({
  id, name: `ACCAD_${id[0].toUpperCase() + id.slice(1)}_Female`,
  label: ({stand:'Fermo — cattura umana', start:'Partenza — cattura umana', walk:'Camminata — cattura umana', stop:'Arresto — cattura umana', turnLeft:'Svolta sinistra — cattura umana', turnRight:'Svolta destra — cattura umana', turnAround:'Inversione — cattura umana'})[id],
  source: ACCAD_MOTION.clips[id].source, duration: ACCAD_MOTION.clips[id].duration,
  motionCapture: true, license: ACCAD_MOTION.license
})));

function indices(clip, time, loop = clip.loop) {
  const t = loop ? ((time % clip.duration) + clip.duration) % clip.duration : clamp(time, 0, clip.duration);
  const frame = t / clip.duration * (clip.pelvis.length - 1), a = Math.min(Math.floor(frame), clip.pelvis.length - 1);
  return { a, b: Math.min(a + 1, clip.pelvis.length - 1), f: frame - a, t };
}

function sampleQuaternion(clip, bone, time, out, temporary) {
  const { a, b, f } = indices(clip, time);
  return out.fromArray(clip.quaternions[bone][a]).slerp(temporary.fromArray(clip.quaternions[bone][b]), f).normalize();
}

export function captureDistanceAt(id, time) {
  const clip = captureFor(id), { a, b, f } = indices(clip, time);
  const loops = clip.loop ? Math.floor(Math.max(0, time) / clip.duration) : 0;
  return loops * clip.rootDistance + THREE.MathUtils.lerp(clip.distance[a], clip.distance[b], f);
}

/** Match lower-body support/pose before changing a recorded action. */
export function matchingCapturePhase(targetId, sourceId, sourceTime) {
  const target = captureFor(targetId), source = captureFor(sourceId);
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  const sourcePose = ACCAD_MOTION.bones.map((_, i) => sampleQuaternion(source, i, sourceTime, new THREE.Quaternion(), qb));
  let best = Infinity, bestFrame = 0;
  for (let f = 0; f < target.pelvis.length - 1; f++) {
    let error = 0;
    ACCAD_MOTION.bones.forEach((name, i) => {
      const weight = /thigh|calf|foot|ball/.test(name) ? 4 : name === 'pelvis' ? 1 : .1;
      const angle = sourcePose[i].angleTo(qa.fromArray(target.quaternions[i][f]));
      error += weight * angle * angle;
    });
    if (error < best) { best = error; bestFrame = f; }
  }
  return bestFrame / (target.pelvis.length - 1);
}

/** Whole steps determine the stop boundary. Scale their root distance uniformly
 * to fit the clear route, rather than interrupting an arbitrary swing phase. */
export function planCaptureJourney(distance) {
  const { start, walk, stop } = ACCAD_MOTION.clips;
  const entry = matchingCapturePhase('walk', 'start', start.duration);
  const exit = matchingCapturePhase('walk', 'stop', 0);
  let span = (exit - entry + 1) % 1;
  if (span < .15) span += 1;
  let best = null;
  for (let cycles = 0; cycles <= Math.ceil(distance / walk.rootDistance) + 1; cycles++) {
    const walkEnd = (entry + span + cycles) * walk.duration;
    const captureDistance = start.rootDistance + captureDistanceAt('walk', walkEnd) - captureDistanceAt('walk', entry * walk.duration) + stop.rootDistance;
    const strideScale = distance / captureDistance, error = Math.abs(Math.log(Math.max(.001, strideScale)));
    if (!best || error < best.error) best = { entry, exit, walkEnd, cycles, strideScale, captureDistance, distance, error };
  }
  return best;
}

/** Original capture clips in place, for the viewer's existing animation menu.
 * All bone lengths stay at their target bind values. Corrective/twist rests are
 * explicit, preventing an earlier MH_Talk scale from leaking into these clips.
 */
export function createMocapClips() {
  return MOCAP_CATALOG.map(row => {
    const clip = ACCAD_MOTION.clips[row.id], times = clip.pelvis.map((_, i) => i * clip.duration / (clip.pelvis.length - 1));
    const tracks = [], mapped = new Set(ACCAD_MOTION.bones);
    for (const [bone, rest] of Object.entries(ACCAD_MOTION.rest)) {
      tracks.push(new THREE.VectorKeyframeTrack(`body__${bone}.position`, bone === 'pelvis' ? times : [0], bone === 'pelvis' ? clip.pelvis.flat() : rest.position));
      tracks.push(new THREE.VectorKeyframeTrack(`body__${bone}.scale`, [0], rest.scale));
      if (!mapped.has(bone)) tracks.push(new THREE.QuaternionKeyframeTrack(`body__${bone}.quaternion`, [0], rest.quaternion));
    }
    ACCAD_MOTION.bones.forEach((name, index) => tracks.push(new THREE.QuaternionKeyframeTrack(`body__${name}.quaternion`, times, clip.quaternions[index].flat())));
    const result = new THREE.AnimationClip(row.name, clip.duration, tracks);
    result.userData = { motionCapture: true, source: row.source, attribution: ACCAD_MOTION.source, license: ACCAD_MOTION.license, inPlace: true, oneShot: !clip.loop };
    return result;
  });
}

/** Deterministic sampler of recorded motion, not an oscillator or IK gait. */
export class Air3MocapLocomotion {
  constructor(rig) {
    this.rig = rig; this.id = 'stand'; this.time = 0; this.rate = 1; this.blendTime = .25; this.blendElapsed = 1;
    this.bones = ACCAD_MOTION.bones.map(name => rig.bodyBones.get(name));
    this.boneSet = new Set(this.bones); this.pelvisNode = rig.bodyBones.get('pelvis');
    this.ready = this.bones.every(Boolean); this.error = this.ready ? null : 'Missing target skeleton bones';
    this.pose = this.bones.map(() => new THREE.Quaternion());
    this.previousPose = this.bones.map(() => new THREE.Quaternion());
    this.pelvis = new THREE.Vector3(); this.previousPelvis = new THREE.Vector3(); this.contacts = [1,1]; this.supports=[0,0];
    this.rest = Object.entries(ACCAD_MOTION.rest).map(([name, rest]) => ({node:rig.bodyBones.get(name), position:new THREE.Vector3().fromArray(rest.position), quaternion:new THREE.Quaternion().fromArray(rest.quaternion), scale:new THREE.Vector3().fromArray(rest.scale)})).filter(x=>x.node);
    this.qb = new THREE.Quaternion(); this.pb = new THREE.Vector3(); this.distanceTravelled = 0; this.cycles = 0;
    this.blendSource = null; this.previousRaw = this.bones.map(() => new THREE.Quaternion()); this.identity = new THREE.Quaternion();
    this.sample();
  }
  get clip() { return captureFor(this.id); }
  get referenceWalkSpeed() { return ACCAD_MOTION.clips.walk.meanSpeed; }
  get recordedStopDistance() { return ACCAD_MOTION.clips.stop.rootDistance; }
  closestPhase(id, maximum = 1) {
    const clip=captureFor(id); if(!clip)return 0;
    let best=Infinity, bestFrame=0;
    const maxFrame=Math.min(clip.pelvis.length-1,Math.floor(maximum*(clip.pelvis.length-1)));
    for(let f=0;f<=maxFrame;f++){
      let error=0;
      for(let i=0;i<this.pose.length;i++){
        const name=ACCAD_MOTION.bones[i],weight=/thigh|calf|foot/.test(name)?3:/pelvis/.test(name)?2:.35;
        const angle=this.pose[i].angleTo(this.qb.fromArray(clip.quaternions[i][f]));error+=weight*angle*angle;
      }
      if(error<best){best=error;bestFrame=f;}
    }
    return bestFrame/(clip.pelvis.length-1);
  }
  get finished() { return !this.clip.loop && this.time >= this.clip.duration; }
  get normalizedTime() { return indices(this.clip, this.time).t / this.clip.duration; }
  setClip(id, { restart = false, blend = .24, phase = 0 } = {}) {
    if (!captureFor(id)) return false;
    if (id === this.id && !restart) return true;
    this.previousPose.forEach((q,i)=>q.copy(this.pose[i])); this.previousPelvis.copy(this.pelvis);
    const { a, b, f } = indices(this.clip, this.time);
    this.blendSource = { id: this.id, time: this.time, rate: this.rate,
      offsets: this.pose.map((q,i) => sampleQuaternion(this.clip, i, this.time, new THREE.Quaternion(), this.qb).invert().multiply(q)),
      pelvisOffset: this.pelvis.clone().sub(new THREE.Vector3().fromArray(this.clip.pelvis[a]).lerp(this.pb.fromArray(this.clip.pelvis[b]), f)) };
    this.id = id; this.time = Math.max(0, phase) * this.clip.duration; this.blendElapsed = 0; this.blendTime = Math.max(.01, blend);
    this.sample(); return true;
  }
  distanceAt(time) {
    return captureDistanceAt(this.id, time);
  }
  speedAt(time = this.time) {
    const { a, b, f } = indices(this.clip, time);
    return THREE.MathUtils.lerp(this.clip.speed[a], this.clip.speed[b], f);
  }
  yawAt(time) {
    const clip=this.clip,{a,b,f}=indices(clip,time),loops=clip.loop?Math.floor(Math.max(0,time)/clip.duration):0;
    return loops*clip.yawChange+THREE.MathUtils.lerp(clip.yaw[a],clip.yaw[b],f);
  }
  advance(dt, rate = 1) {
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, .1); this.rate = clamp(rate, .25, 1.6);
    const before = this.distanceAt(this.time), beforeYaw=this.yawAt(this.time); this.time += dt * this.rate; this.blendElapsed += dt;
    if (this.blendSource) this.blendSource.time += dt * this.blendSource.rate;
    if (!this.clip.loop) this.time = Math.min(this.time,this.clip.duration);
    this.yawDelta=this.yawAt(this.time)-beforeYaw;
    const delta = Math.max(0,this.distanceAt(this.time)-before); this.distanceTravelled += delta;
    this.cycles = this.clip.loop ? Math.floor(this.time / this.clip.duration) : 0; this.sample(); return delta;
  }
  sample() {
    const clip = this.clip, {a,b,f} = indices(clip,this.time), blend = smooth(this.blendElapsed / this.blendTime);
    const from = blend < 1 && this.blendSource ? captureFor(this.blendSource.id) : null;
    const previous = from ? indices(from, this.blendSource.time) : null;
    this.pose.forEach((q,i)=> {
      q.fromArray(clip.quaternions[i][a]).slerp(this.qb.fromArray(clip.quaternions[i][b]),f).normalize();
      if (from) {
        const old = sampleQuaternion(from, i, this.blendSource.time, this.previousRaw[i], this.qb);
        old.multiply(this.qb.copy(this.identity).slerp(this.blendSource.offsets[i], 1 - blend));
        // slerpQuaternions(old, q, blend) aliases its destination with its
        // second input: THREE copies old into q before reading the target.
        // Keep the incoming sample in q and blend toward the moving source.
        q.slerp(old, 1 - blend);
      }
    });
    this.pelvis.fromArray(clip.pelvis[a]).lerp(this.pb.fromArray(clip.pelvis[b]),f);
    if (from) {
      const old = this.pb.fromArray(from.pelvis[previous.a]).lerp(new THREE.Vector3().fromArray(from.pelvis[previous.b]), previous.f);
      old.addScaledVector(this.blendSource.pelvisOffset, 1 - blend);
      this.pelvis.lerpVectors(old, this.pelvis, blend);
    }
    this.contacts[0]=THREE.MathUtils.lerp(clip.contacts[a][0],clip.contacts[b][0],f);
    this.contacts[1]=THREE.MathUtils.lerp(clip.contacts[a][1],clip.contacts[b][1],f);
    this.supports=clip.supports[f<.5?a:b].slice();
    if (from) {
      for (let i = 0; i < 2; i++) this.contacts[i] = THREE.MathUtils.lerp(
        THREE.MathUtils.lerp(from.contacts[previous.a][i], from.contacts[previous.b][i], previous.f), this.contacts[i], blend);
      if (blend < .5) this.supports = from.supports[previous.f < .5 ? previous.a : previous.b].slice();
    } else this.blendSource = null;
  }
  apply(weight = 1) {
    if (!this.ready || weight <= 0) return;
    for (const r of this.rest) {
      if (r.node !== this.pelvisNode) r.node.position.lerp(r.position,weight);
      if (!this.boneSet.has(r.node)) r.node.quaternion.slerp(r.quaternion,weight);
      r.node.scale.lerp(r.scale,weight);
    }
    this.bones.forEach((node,i)=>node.quaternion.slerp(this.pose[i],weight));
    this.pelvisNode.position.lerp(this.pelvis,weight);
    this.rig.root.updateWorldMatrix(true,true);
  }
  diagnostics() { return {ready:this.ready,error:this.error,source:ACCAD_MOTION.source,license:ACCAD_MOTION.license,clip:this.id,time:this.time,duration:this.clip.duration,rate:this.rate,sourceFile:this.clip.source,sourceFrames:[this.clip.startFrame,this.clip.endFrame],contacts:this.contacts.slice(),cycles:this.cycles,motionCapture:true,syntheticGait:false}; }
}
