#!/usr/bin/env node
/**
 * #AIR3 animation-only FBX -> glTF conversion, Three.js r186.
 * Usage:
 * node tools/convert_animations.mjs --source /path/exported_air3_assets \
 *   --output /path/AIR3_Web_Assets --three /path/node_modules/three
 *
 * Requires the original exported FBX files and GLB reference meshes. No mesh is
 * copied into the resulting animation GLBs. The original inputs are read-only.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createFBXImporter } from './fbx-import.mjs';

const argv = process.argv.slice(2);
function option(name, fallback) {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing ${name}`);
  return path.resolve(argv[i + 1]);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const output = option('--output', path.resolve(here, '..'));
const source = option('--source', path.resolve(here, '../../../review/asset-import-2026-10-24/exported'));
const threePath = option('--three', path.resolve(here, '../../AIR3_Studio_Flow/studio-broadcast/node_modules/three'));
const { THREE, FBXLoader, getParsedTree, threeVersion } = await createFBXImporter(threePath);
const { Quaternion, Vector3 } = THREE;

const basis = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
const inverseBasis = basis.clone().invert();
const tolerance = { translation: 0.00002, rotation: 0.0002, scale: 0.00002, scalar: 0.0001 };
const round = n => Number(n.toPrecision(9));
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
function readGLBJSON(file) {
  const handle = fs.openSync(file, 'r');
  try {
    const h = Buffer.alloc(20); fs.readSync(handle, h, 0, 20, 0);
    if (h.readUInt32LE(0) !== 0x46546c67 || h.readUInt32LE(4) !== 2 || h.readUInt32LE(16) !== 0x4e4f534a) throw new Error('Not glTF 2 GLB');
    const data = Buffer.alloc(h.readUInt32LE(12)); fs.readSync(handle, data, 0, data.length, 20);
    return JSON.parse(data.toString());
  } finally { fs.closeSync(handle); }
}
function position(v) { return [v[0] * .01, v[2] * .01, -v[1] * .01]; }
function rotation(v) { return basis.clone().multiply(new Quaternion().fromArray(v)).multiply(inverseBasis).normalize().toArray(); }
function scale(v) { return [v[0], v[2], v[1]]; }
function distance(a, b, kind) {
  if (kind === 'rotation') {
    let dot = 0, aa = 0, bb = 0;
    for (let k = 0; k < 4; k++) { dot += a[k] * b[k]; aa += a[k] ** 2; bb += b[k] ** 2; }
    return 2 * Math.acos(Math.min(1, Math.abs(dot / Math.sqrt(aa * bb))));
  }
  return Math.hypot(...a.map((v, i) => v - b[i]));
}
function interpolate(a, b, f, kind) {
  if (kind === 'rotation') return new Quaternion().fromArray(a).normalize().slerp(new Quaternion().fromArray(b).normalize(), f).toArray();
  return a.map((v, i) => v + (b[i] - v) * f);
}
function get(values, index, width) { return Array.from(values.slice(index * width, (index + 1) * width)); }
function compact(times, values, width, kind, reference = null) {
  const limit = tolerance[kind];
  if (!times.length || values.length !== times.length * width) throw new Error('Malformed track');
  if ([...times, ...values].some(v => !Number.isFinite(v))) throw new Error('Non-finite track');
  for (let i = 1; i < times.length; i++) if (times[i] <= times[i - 1]) throw new Error('Non-monotonic track time');
  let maxRestError = 0;
  if (reference) {
    for (let i = 0; i < times.length; i++) maxRestError = Math.max(maxRestError, distance(get(values, i, width), reference, kind));
    if (maxRestError <= limit) return { omitted: true, error: maxRestError };
  }
  const keep = new Set([0, times.length - 1]), stack = [[0, times.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); if (b - a < 2) continue;
    const av = get(values, a, width), bv = get(values, b, width);
    let worst = -1, error = limit;
    for (let i = a + 1; i < b; i++) {
      const f = (times[i] - times[a]) / (times[b] - times[a]);
      const e = distance(get(values, i, width), interpolate(av, bv, f, kind), kind);
      if (e > error) { worst = i; error = e; }
    }
    if (worst >= 0) { keep.add(worst); stack.push([a, worst], [worst, b]); }
  }
  let indices = [...keep].sort((a, b) => a - b);
  const first = get(values, 0, width);
  let constError = 0;
  for (let i = 1; i < times.length; i++) constError = Math.max(constError, distance(first, get(values, i, width), kind));
  if (constError <= limit) indices = [0];
  const outTimes = Float32Array.from(indices.map(i => times[i]));
  const outValues = Float32Array.from(indices.flatMap(i => get(values, i, width)));
  let maxError = 0, cursor = 0;
  for (let i = 0; i < times.length; i++) {
    while (cursor + 1 < outTimes.length && outTimes[cursor + 1] < times[i]) cursor++;
    const next = Math.min(cursor + 1, outTimes.length - 1);
    const f = next === cursor ? 0 : Math.min(1, Math.max(0, (times[i] - outTimes[cursor]) / (outTimes[next] - outTimes[cursor])));
    maxError = Math.max(maxError, distance(get(values, i, width), interpolate(get(outValues, cursor, width), get(outValues, next, width), f, kind), kind));
  }
  if (maxError > limit * 1.01 + 1e-7) throw new Error(`Reduction error ${maxError} > ${limit} for ${kind}`);
  return { times: outTimes, values: outValues, error: maxError, omitted: false };
}
function restNodes(object) {
  const bones = []; object.traverse(o => { if (o.isBone) bones.push(o); });
  const index = new Map(bones.map((o, i) => [o, i]));
  return bones.map(o => ({ name: o.name, translation: position(o.position.toArray()), rotation: rotation(o.quaternion.toArray()), scale: scale(o.scale.toArray()), ...(o.children.some(c => index.has(c)) ? { children: o.children.filter(c => index.has(c)).map(c => index.get(c)) } : {}) }));
}
function compareRest(sourceNodes, targetNodes) {
  const map = new Map(targetNodes.filter(n => n.name).map(n => [n.name, n]));
  const errors = sourceNodes.flatMap(s => {
    const t = map.get(s.name); if (!t) return [];
    return [{ bone: s.name, translation: distance(s.translation, t.translation || [0, 0, 0], 'translation'), rotation: distance(s.rotation, t.rotation || [0, 0, 0, 1], 'rotation'), scale: distance(s.scale, t.scale || [1, 1, 1], 'scale') }];
  });
  return { matched: errors.length, sourceBones: sourceNodes.length, maxPositionErrorMeters: Math.max(...errors.map(e => e.translation)), maxAngleErrorRadians: Math.max(...errors.map(e => e.rotation)), maxScaleError: Math.max(...errors.map(e => e.scale)), worst: errors.sort((a, b) => b.translation - a.translation).slice(0, 12) };
}
class GLBBuilder {
  constructor(nodes, label) {
    this.doc = { asset: { version: '2.0', generator: '#AIR3 animation converter / Three.js r186' }, scene: 0, scenes: [{ name: label, nodes: [0] }], nodes, animations: [], accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }] };
    this.parts = []; this.bytes = 0; this.cache = new Map();
    this.names = new Map(nodes.map((n, i) => [n.name, i]));
  }
  accessor(data, width, time = false) {
    const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const key = `${width}:${time}:${sha256(b)}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const view = this.doc.bufferViews.length;
    this.doc.bufferViews.push({ buffer: 0, byteOffset: this.bytes, byteLength: b.length });
    this.parts.push(b); this.bytes += b.length;
    const accessor = this.doc.accessors.length;
    this.doc.accessors.push({ bufferView: view, componentType: 5126, count: data.length / width, type: width === 1 ? 'SCALAR' : `VEC${width}`, ...(time ? { min: [data[0]], max: [data[data.length - 1]] } : {}) });
    this.cache.set(key, accessor); return accessor;
  }
  animation(name, tracks, duration, extras = {}) {
    const clip = { name, channels: [], samplers: [], extras: { durationSeconds: duration, ...extras } };
    for (const track of tracks) {
      const node = this.names.get(track.bone);
      if (node === undefined) throw new Error(`No target bone ${track.bone}`);
      const sampler = clip.samplers.length;
      clip.samplers.push({ input: this.accessor(track.times, 1, true), output: this.accessor(track.values, track.width), interpolation: 'LINEAR' });
      clip.channels.push({ sampler, target: { node, path: track.kind } });
    }
    if (!clip.channels.length) throw new Error(`Empty animation ${name}`);
    this.doc.animations.push(clip);
  }
  save(file, extras) {
    this.doc.buffers[0].byteLength = this.bytes; this.doc.extras = extras;
    const json = Buffer.from(JSON.stringify(this.doc));
    const jsonPad = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
    const bin = Buffer.concat(this.parts);
    const h = Buffer.alloc(20); h.writeUInt32LE(0x46546c67); h.writeUInt32LE(2, 4); h.writeUInt32LE(28 + jsonPad.length + bin.length, 8); h.writeUInt32LE(jsonPad.length, 12); h.writeUInt32LE(0x4e4f534a, 16);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length); bh.writeUInt32LE(0x004e4942, 4);
    const bytes = Buffer.concat([h, jsonPad, bh, bin]); fs.writeFileSync(file, bytes);
    return { file: path.basename(file), bytes: bytes.length, sha256: sha256(bytes), animationCount: this.doc.animations.length, nodeCount: this.doc.nodes.length, containsGeometry: false };
  }
}
function convertClip(clip, reference, name) {
  const nodes = new Map(reference.map(n => [n.name, n]));
  const tracks = []; const stats = { name, durationSeconds: clip.duration, inputTracks: clip.tracks.length, inputKeys: 0, outputTracks: 0, outputKeys: 0, maxSampleError: { translationMeters: 0, rotationRadians: 0, scale: 0 }, omittedRestTracks: 0 };
  for (const t of clip.tracks) {
    const dot = t.name.lastIndexOf('.'), bone = t.name.slice(0, dot), prop = t.name.slice(dot + 1);
    const kind = { position: 'translation', quaternion: 'rotation', scale: 'scale' }[prop];
    if (!kind) throw new Error(`Unsupported transform track ${t.name}`);
    const ref = nodes.get(bone); if (!ref) throw new Error(`Missing reference ${bone}`);
    const width = kind === 'rotation' ? 4 : 3;
    const convert = kind === 'rotation' ? rotation : kind === 'translation' ? position : scale;
    const values = new Float64Array(t.values.length);
    for (let i = 0; i < t.times.length; i++) values.set(convert(get(t.values, i, width)), i * width);
    stats.inputKeys += t.times.length;
    const rest = ref[kind] || (kind === 'rotation' ? [0, 0, 0, 1] : kind === 'scale' ? [1, 1, 1] : [0, 0, 0]);
    const reduced = compact(t.times, values, width, kind, rest);
    const errorKey = kind === 'translation' ? 'translationMeters' : kind === 'rotation' ? 'rotationRadians' : 'scale';
    stats.maxSampleError[errorKey] = Math.max(stats.maxSampleError[errorKey], reduced.error);
    if (reduced.omitted) { stats.omittedRestTracks++; continue; }
    tracks.push({ bone, kind, width, times: reduced.times, values: reduced.values });
    stats.outputKeys += reduced.times.length;
  }
  stats.outputTracks = tracks.length;
  return { tracks, stats };
}
function customCurves(tree, file) {
  const curveNodes = tree.Objects.AnimationCurveNode || {}, curves = tree.Objects.AnimationCurve || {};
  const links = new Map();
  for (const c of tree.Connections.connections) { if (!links.has(c[0])) links.set(c[0], []); links.get(c[0]).push(c); }
  const channels = [], zeroChannels = [], originalFlags = new Set();
  let inputKeys = 0, outputKeys = 0, maxError = 0;
  for (const [id, curve] of Object.entries(curves)) {
    const link = links.get(Number(id))?.[0], node = curveNodes[link?.[1]];
    if (!node || /^(S|R|T|DeformPercent)$/.test(node.attrName)) continue;
    const values = curve.KeyValueFloat.a, times = curve.KeyTime.a.map(v => v / 46186158000);
    if (!values.length) continue;
    for (const v of curve.KeyAttrFlags?.a || []) originalFlags.add(v);
    inputKeys += values.length;
    const reduced = compact(times, values, 1, 'scalar', [0]); maxError = Math.max(maxError, reduced.error);
    if (reduced.omitted) { zeroChannels.push(node.attrName); continue; }
    channels.push({ name: node.attrName, times: Array.from(reduced.times, round), values: Array.from(reduced.values, round), range: [Math.min(...values), Math.max(...values)].map(round) });
    outputKeys += reduced.times.length;
  }
  if (new Set(channels.map(c => c.name)).size !== channels.length) throw new Error('Duplicate custom-property names');
  return { format: 'AIR3NamedAnimationCurves', schemaVersion: 1, source: file, interpolation: 'linear-between-exported-samples', originalFBXKeyAttributeFlags: [...originalFlags], note: 'Values preserve sampled source data, including negative values. Custom names are not a verified mapping to the anonymous morph indices in the exported face GLB. Original cubic FBX tangents are not reproduced between samples.', channels, zeroChannels, stats: { inputKeys, outputKeys, activeChannels: channels.length, zeroChannels: zeroChannels.length, maxSampleError: maxError } };
}

fs.mkdirSync(path.join(output, 'animations'), { recursive: true });
fs.mkdirSync(path.join(output, 'reports'), { recursive: true });
const bodyGLB = readGLBJSON(path.join(source, 'meshes/f_tal_unw_body.glb'));
const faceGLB = readGLBJSON(path.join(source, 'meshes/AI_MetaHumanIdentity_FaceMesh.glb'));
const outfitGLB = readGLBJSON(path.join(source, 'meshes/ScothSkirtWhitheShirtNewBalance.glb'));
const bodyNodes = bodyGLB.nodes.map(({ mesh, skin, ...node }) => node);
const bodyBuilder = new GLBBuilder(bodyNodes, '#AIR3 body animation reference');
let faceBuilder;
const report = { schemaVersion: 1, tool: 'convert_animations.mjs', threeVersion, coordinateConversion: '(x,y,z) centimeters -> (x,z,-y) meters; quaternions conjugated by Rx(-90deg)', reductionTolerances: tolerance, validationScope: 'All exported source key values, after float32 serialization. FBX cubic interpolation between sampled keys is not reproduced. Visual validation and retargeting are separate.', body: [], face: [], outputs: [], warnings: [] };
const sources = fs.readdirSync(path.join(source, 'animations')).filter(f => f.endsWith('.fbx')).sort();
for (const file of sources) {
  const bytes = fs.readFileSync(path.join(source, 'animations', file));
  const object = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const raw = getParsedTree();
  if (object.animations.length !== 1) throw new Error(`Expected one take: ${file}`);
  const rests = restNodes(object), kind = file.startsWith('MH_') ? 'body' : 'face';
  const target = kind === 'body' ? bodyGLB.nodes : faceGLB.nodes;
  const restComparison = compareRest(rests, target);
  const curves = customCurves(raw, file);
  const name = path.basename(file, '.fbx');
  const reference = kind === 'body' ? bodyNodes : rests;
  const converted = convertClip(object.animations[0], reference, name);
  const item = { source: file, sourceBytes: bytes.length, sha256: sha256(bytes), ...converted.stats, restComparison, customCurves: curves.stats };
  if (kind === 'body') {
    if (restComparison.matched !== rests.length || restComparison.maxPositionErrorMeters > 0.00001 || restComparison.maxAngleErrorRadians > 0.00001) throw new Error(`Body reference mismatch: ${file}`);
    item.outfitRestComparison = compareRest(rests.filter(r => outfitGLB.nodes.some(n => n.name === r.name)), outfitGLB.nodes);
    bodyBuilder.animation(name, converted.tracks, object.animations[0].duration, { target: 'f_tal_unw_body', validatedReference: true });
  } else {
    if (!faceBuilder) faceBuilder = new GLBBuilder(reference, '#AIR3 source facial animation reference');
    faceBuilder.animation(name, converted.tracks, object.animations[0].duration, { target: 'original FBX reference skeleton', requiresRetargetingToAIR3Face: true });
    item.requiresRetargeting = true;
    const curveFile = path.join(output, 'animations', `${name}.curves.json`);
    fs.writeFileSync(curveFile, JSON.stringify(curves));
    report.outputs.push({ file: path.basename(curveFile), bytes: fs.statSync(curveFile).size, purpose: 'Named source facial/material controls; not auto-bound to anonymous morph indices' });
  }
  if (kind === 'body' && curves.channels.length) {
    const curveFile = path.join(output, 'animations', `${name}.curves.json`);
    fs.writeFileSync(curveFile, JSON.stringify(curves));
    report.outputs.push({ file: path.basename(curveFile), bytes: fs.statSync(curveFile).size, purpose: 'Nonzero custom source controls' });
  }
  report[kind].push(item);
  console.log(JSON.stringify({ file, kind, duration: converted.stats.durationSeconds, tracks: converted.stats.outputTracks, keys: converted.stats.outputKeys, sourceKeys: converted.stats.inputKeys, customActive: curves.channels.length }));
}
report.outputs.push(bodyBuilder.save(path.join(output, 'animations/body-clips.glb'), { target: 'f_tal_unw_body.glb', units: 'meters', compatibleSharedOutfitBones: true, referenceRestValidated: true }));
if (faceBuilder) report.outputs.push(faceBuilder.save(path.join(output, 'animations/face-spectrum-source.glb'), { target: 'original spectrum FBX skeleton', requiresRetargetingToAIR3Face: true, doNotApplyBlindly: true }));
report.warnings.push('The face spectrum reference pose differs from the exported AIR3 face; it is preserved as a source reference and is not certified as directly compatible.');
report.warnings.push('Full_Emotion_NoMouth_spectrum has active mouth channels. It is not an upper-face-only layer.');
report.warnings.push('No FBX animation input contains mesh geometry or blendshape delta geometry, so these files cannot recover anonymous GLB morph-target ordering.');
report.warnings.push('Body clips retain authored root/pelvis motion; they are not automatically converted into seated animations.');
fs.writeFileSync(path.join(output, 'reports/animations.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ outputs: report.outputs, bodyClips: report.body.length, faceClips: report.face.length }));
