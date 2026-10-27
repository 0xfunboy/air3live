import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Air3AvatarRig } from '../air3-avatar.mjs';
import { applyAvatarMaterials } from '../avatar-materials.mjs';
import { createAir3Hair } from '../air3-hair.mjs';
import { createHairWardrobe } from '../air3-hair-wardrobe.mjs';
import { createFootwearController } from '../air3-footwear.mjs';
import { createClothingController } from '../air3-clothing.mjs';
import { StudioLighting } from '../studio-lighting.mjs';
import { LookController, loadInitialLook } from '../look-controller.mjs';
import { mountLookControls } from '../look-controls.mjs';
import { createMocapClips } from '../air3-locomotion.mjs';
import { createStudioEnvironment, resolveStudioQuality } from '../studio-rendering.mjs';
import { mouthCueAt, mouthPoseWeightsAt, normalizeMouthCues } from '../lip-sync.mjs';

const $ = (id) => document.getElementById(id), viewport = $('viewport');
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x303840); scene.fog = new THREE.Fog(0x303840, 6, 18);
const camera = new THREE.PerspectiveCamera(29, 1, .02, 40);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.02;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
const gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
const quality = resolveStudioQuality({}, gpu, location.search);
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, quality.maxPixelRatio)); viewport.appendChild(renderer.domElement);
const environment = createStudioEnvironment(renderer, quality); scene.environment = environment.texture; scene.environmentIntensity = .6;
const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.minDistance = .3; controls.maxDistance = 6; controls.maxPolarAngle = Math.PI * .57;
const lighting = new StudioLighting(scene, renderer, { quality });
const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ color: 0x424a51, roughness: .94 }));
floor.rotation.x = -Math.PI / 2; floor.position.y = -.012; floor.receiveShadow = true; scene.add(floor);
let rig, model, materials, hair, footwear, clothing, look, lookControls, modelTriangles = 0, sourceModelTriangles = 0, last = performance.now(), paused = false, frames = 0, disposed = false, frameAt = 0;
let audioContext, analyser, samples, demoSource, demoStartedAt = 0, demoDuration = 0, demoCues = [], demoPlaying = false;
const errors = []; window.addEventListener('error', (event) => errors.push(event.message));
let resolveReady, rejectReady;
const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }); ready.catch(() => {});

function view(name) {
  if ((name === 'feet' || name === 'feetRear') && rig) {
    const left = rig.bodyBones.get('foot_l').getWorldPosition(new THREE.Vector3());
    const right = rig.bodyBones.get('foot_r').getWorldPosition(new THREE.Vector3());
    const target = left.add(right).multiplyScalar(.5).add(new THREE.Vector3(0, .025, .04));
    controls.target.copy(target); camera.position.copy(target).add(name === 'feetRear' ? new THREE.Vector3(.35, .16, -.75) : new THREE.Vector3(.26, .20, .85));
  } else if (name === 'face' && rig) {
    const target = rig.bodyBones.get('head').getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, .065, .025));
    controls.target.copy(target); camera.position.copy(target).add(new THREE.Vector3(0, .02, .73));
  } else { controls.target.set(0, .94, 0); camera.position.set(...({ front: [0, .98, 4.1], back: [0, .98, -4.1], side: [3.85, 1.0, 0], threequarter: [2.25, 1.08, 3.35] }[name] || [0, .98, 3.85])); }
  controls.update(); $('view-name').textContent = { front: 'FRONTALE', back: 'POSTERIORE', side: 'PROFILO', threequarter: 'TRE QUARTI', face: 'VOLTO', feet: 'SCARPE', feetRear: 'GAMBALE POSTERIORE' }[name];
}
function emotion() { rig?.setEmotion($('emotion').value, Number($('intensity').value)); $('intensity-value').textContent = Math.round(Number($('intensity').value) * 100) + '%'; }
function stopDemo() {
  demoPlaying = false;
  if (demoSource) { demoSource.onended = null; try { demoSource.stop(); } catch {} demoSource.disconnect(); demoSource = null; }
  rig?.setSpeech({ phase: 'idle', amplitude: 0, mouthCue: 'X', lipSync: 'none' });
  $('demo').textContent = 'Ascolta la voce · 12 s'; $('audio-state').textContent = 'Estratto della registrazione fornita con il progetto.';
}
async function playDemo() {
  if (demoPlaying) { stopDemo(); return; } await ready; $('demo').disabled = true;
  try {
    audioContext ||= new AudioContext({ latencyHint: 'playback' }); await audioContext.resume();
    const [wav, timeline] = await Promise.all([fetch('/assets/air3/demo/voice-reference.wav').then((r) => { if (!r.ok) throw new Error('Audio non disponibile'); return r.arrayBuffer(); }), fetch('/assets/air3/demo/voice-reference.json').then((r) => r.json())]);
    const buffer = await audioContext.decodeAudioData(wav); demoCues = normalizeMouthCues(timeline.mouthCues, buffer.duration); demoDuration = buffer.duration;
    if (!analyser) { analyser = audioContext.createAnalyser(); analyser.fftSize = 512; analyser.connect(audioContext.destination); samples = new Float32Array(512); }
    demoSource = audioContext.createBufferSource(); demoSource.buffer = buffer; demoSource.connect(analyser);
    demoStartedAt = audioContext.currentTime + .06; demoPlaying = true; paused = false;
    $('mouth').value = 'auto'; rig.clearFacialPreview(); emotion(); $('pause').textContent = 'Pausa animazione';
    demoSource.onended = stopDemo; demoSource.start(demoStartedAt); $('demo').textContent = 'Ferma la voce';
  } catch (error) { stopDemo(); $('audio-state').textContent = error.message; } finally { $('demo').disabled = false; }
}
window.assetPreview = { ready,
  diagnostics: () => ({ ...rig?.diagnostics(), frames, modelTriangles, sourceModelTriangles, hair: hair?.diagnostics(), calls: renderer.info.render.calls,
    lighting: lighting.diagnostics(), look: look?.getPreset(), lookBusy: !!look?.busy, lookError: look?.error, footwear: footwear?.diagnostics(), clothing: clothing?.diagnostics(),
    renderedTriangles: renderer.info.render.triangles, textures: renderer.info.memory.textures, gpu, quality: quality.name, materials: materials?.diagnostics, errors, demoPlaying }),
  setMotion(name) { rig.setClip(name, { immediate: true }); $('motion').value = name; },
  getLookPreset: () => look?.getPreset(),
  async setLookPreset(value, options) { await ready; return look.apply(value, options); },
  setLighting(value) { return look?.setLighting(value); },
  async setHair(style, color) { await ready; return look.setHair(style, color); },
  async setFootwear(style, fit) { await ready; return look.setFootwear(style, fit); },
  async setClothing(style) { await ready; return look.setClothing(style); },
  setTime(seconds) { paused = true; rig.setTime(seconds); rig.update(0); hair?.update(0); footwear?.update(0); clothing?.update(0); renderer.render(scene, camera); },
  front: () => view('front'), back: () => view('back'), face: () => view('face'), feet: () => view('feet'), feetRear: () => view('feetRear'), side: () => view('side'), threequarter: () => view('threequarter'),
  setExpression(name, intensity = .35) { $('emotion').value = name; $('intensity').value = intensity; emotion(); },
  setEyeContact(enabled) { rig.setEyeContactEnabled(enabled); $('eye-contact').checked = !!enabled; },
  setPaused(value) { paused = !!value; $('pause').textContent = paused ? 'Riprendi animazione' : 'Pausa animazione'; },
  advanceForInspection(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 10) throw new Error('Inspection interval must be 0–10 seconds');
    paused = true; controls.update();
    for (let t = 0; t < seconds; t += 1 / 60) { rig.update(Math.min(1 / 60, seconds - t)); hair?.update(Math.min(1 / 60, seconds - t)); footwear?.update(Math.min(1 / 60, seconds - t)); clothing?.update(Math.min(1 / 60, seconds - t)); }
    renderer.render(scene, camera);
  },
  setFacialPreview(value) { rig.setFacialPreview(value); }, clearFacialPreview() { rig.clearFacialPreview(); },
  async playDemo() { return playDemo(); }, stopDemo,
  captureFrame() { renderer.render(scene, camera); return renderer.domElement.toDataURL('image/png'); },
  inspect() {
    const rows = []; model.traverse((mesh) => { if (!mesh.isSkinnedMesh) return; const attrs = mesh.geometry.attributes; let min = Infinity, max = -Infinity;
      for (let i = 0; i < attrs.skinWeight.count; i++) { let sum = 0; for (const name of ['skinWeight', 'weights_1', 'weights_2']) for (let c = 0; c < 4; c++) sum += attrs[name]?.getComponent(i, c) || 0;
        min = Math.min(min, sum); max = Math.max(max, sum); }
      rows.push({ name: mesh.name, minWeightSum: min, maxWeightSum: max, skinAdapter: !!mesh.userData.air3ExtendedSkinning }); }); return rows;
  },
  bonePositions: () => Object.fromEntries(['head', 'clavicle_l', 'clavicle_r', 'hand_l', 'hand_r', 'foot_l', 'foot_r'].map((name) => [name, rig.bodyBones.get(name)?.getWorldPosition(new THREE.Vector3()).toArray()])),
};
function resize() { const width = viewport.clientWidth, height = viewport.clientHeight; renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); }
const observer = new ResizeObserver(resize); observer.observe(viewport); resize(); view('front');
renderer.setAnimationLoop((now) => {
  if (disposed || now - frameAt < 1000 / 30) return; frameAt = now;
  const dt = Math.min(.1, (now - last) / 1000); last = now;
  controls.update();
  if (rig) {
    if (demoPlaying && audioContext) {
      const elapsed = audioContext.currentTime - demoStartedAt; analyser.getFloatTimeDomainData(samples); let energy = 0; for (const sample of samples) energy += sample * sample;
      const mouthCue = mouthCueAt(demoCues, elapsed, demoDuration);
      rig.setSpeech({ phase: 'playing', amplitude: Math.min(1, Math.sqrt(energy / samples.length) * 8), elapsed: Math.max(0, elapsed), duration: demoDuration, mouthCue,
        mouthWeights: mouthPoseWeightsAt(demoCues, elapsed, demoDuration), lipSync: 'rhubarb:pocketSphinx' });
      $('audio-state').textContent = Math.max(0, elapsed).toFixed(1) + ' / ' + demoDuration.toFixed(1) + ' s · Forma ' + mouthCue;
    }
    rig.update(paused ? 0 : dt);
    hair?.update(paused ? 0 : dt);
    footwear?.update(paused ? 0 : dt);
    clothing?.update(paused ? 0 : dt);
  }
  renderer.render(scene, camera); frames++;
});
for (const name of ['front', 'back', 'threequarter', 'side', 'face', 'feet']) $(name).onclick = () => view(name);
$('pause').onclick = () => { paused = !paused; $('pause').textContent = paused ? 'Riprendi animazione' : 'Pausa animazione'; };
$('emotion').onchange = emotion; $('intensity').oninput = emotion;
$('eye-contact').onchange = () => rig?.setEyeContactEnabled($('eye-contact').checked);
$('mouth').onchange = () => { stopDemo(); if ($('mouth').value === 'auto') rig.clearFacialPreview(); else rig.setFacialPreview({ mouthCue: $('mouth').value }); emotion(); };
$('blink').onclick = () => { rig?.setFacialPreview({ blink: 1 }); setTimeout(() => { rig?.clearFacialPreview(); emotion(); }, 180); };
$('reset-face').onclick = () => { stopDemo(); $('mouth').value = 'auto'; $('emotion').value = 'happy'; $('intensity').value = 1; rig.clearFacialPreview(); emotion(); };
$('demo').onclick = playDemo;
const query = new URLSearchParams(location.search); if (query.has('quality')) $('studio-link').href += '&quality=' + encodeURIComponent(query.get('quality'));
function disposeObject(object) {
  object?.traverse(node => { node.geometry?.dispose(); for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) {
    for (const value of Object.values(material)) if (value?.isTexture) value.dispose(); material.dispose();
  } });
}
function disposePreview() {
  if (disposed) return; disposed = true; stopDemo(); renderer.setAnimationLoop(null); observer.disconnect(); controls.dispose();
  lookControls?.dispose(); look?.dispose(); lighting.dispose(); clothing?.dispose(); footwear?.dispose(); hair?.dispose(); rig?.dispose(); materials?.dispose?.();
  if (model && !model.parent) disposeObject(model); disposeObject(scene);
  environment.dispose(); renderer.dispose(); audioContext?.close().catch(() => {});
}
window.addEventListener('pagehide', disposePreview, { once: true });
try {
  const initialLook = await loadInitialLook();
  if (disposed) throw new Error('Preview closed during initialization');
  lighting.setState(initialLook.preset.lighting);
  const gltf = await new GLTFLoader().loadAsync('/assets/air3/models/AIR3-runtime.glb');
  if (disposed) { disposeObject(gltf.scene); throw new Error('Preview closed while loading avatar'); }
  model = gltf.scene;
  model.traverse((node) => { if (node.isMesh) sourceModelTriangles += (node.geometry.index?.count ?? node.geometry.attributes.position.count) / 3; });
  const loadedMaterials = await applyAvatarMaterials(gltf, { renderer, assetBase: '/assets/air3', quality: quality.name });
  if (disposed) { loadedMaterials.dispose?.(); throw new Error('Preview closed while loading materials'); }
  materials = loadedMaterials;
  hair = createAir3Hair(model, { quality: quality.name });
  rig = new Air3AvatarRig(gltf); rig.registerClips(createMocapClips()); rig.update(0);
  model.updateMatrixWorld(true);
  // Hidden source hair remains available for comparison; it must not inflate
  // the scale of the newly styled character through its old high bun bounds.
  const bounds = new THREE.Box3(); model.traverseVisible((node) => { if (node.isMesh) bounds.union(new THREE.Box3().setFromObject(node, true)); });
  const size = bounds.getSize(new THREE.Vector3());
  const holder = new THREE.Group(); holder.scale.setScalar(1.76 / size.y);
  model.position.sub(new THREE.Vector3((bounds.min.x + bounds.max.x) / 2, bounds.min.y, (bounds.min.z + bounds.max.z) / 2)); holder.add(model); scene.add(holder);
  model.traverseVisible((node) => { if (node.isMesh) { node.castShadow = !node.userData.air3NoShadow; node.receiveShadow = true; modelTriangles += (node.geometry.index?.count ?? node.geometry.attributes.position.count) / 3; } });
  const wardrobe = await createHairWardrobe(model, { renderer, quality: quality.name, legacyHair: hair, style: initialLook.preset.hair.style, color: initialLook.preset.hair.color });
  if (disposed) { wardrobe.dispose(); throw new Error('Preview closed while loading hair'); }
  hair = wardrobe;
  const shoes = await createFootwearController({ avatarRoot: model, rig, renderer, quality: quality.name });
  if (disposed) { shoes.dispose(); throw new Error('Preview closed while preparing footwear'); }
  footwear = shoes;
  const shirt = await createClothingController({ avatarRoot: model, rig, renderer, quality: quality.name });
  if (disposed) { shirt.dispose(); throw new Error('Preview closed while preparing clothing'); }
  clothing = shirt;
  look = new LookController({ lighting, hair, footwear, clothing, shipped: initialLook.shipped, source: initialLook.source });
  await look.apply(initialLook.preset, { persist: false, source: initialLook.source });
  if (disposed) throw new Error('Preview closed while loading look');
  lookControls = mountLookControls($('look-panel'), look);
  const updateGeometryCount = () => { modelTriangles = 0; model.traverseVisible(node => { if (node.isMesh) modelTriangles += (node.geometry.index?.count ?? node.geometry.attributes.position.count) / 3; }); $('triangles').textContent = modelTriangles.toLocaleString('it-IT'); };
  look.subscribe(updateGeometryCount); updateGeometryCount();
  rig.setCameraTarget(camera); rig.setEyeContactEnabled($('eye-contact').checked);
  for (const clip of [...rig.idles, ...rig.talks, ...createMocapClips()]) { const option = document.createElement('option'); option.value = clip.name; option.textContent = ({ACCAD_Stand_Female:'Mocap · Fermo', ACCAD_Start_Female:'Mocap · Partenza', ACCAD_Walk_Female:'Mocap · Camminata', ACCAD_Stop_Female:'Mocap · Arresto', ACCAD_TurnLeft_Female:'Mocap · Svolta sinistra', ACCAD_TurnRight_Female:'Mocap · Svolta destra', ACCAD_TurnAround_Female:'Mocap · Inversione'})[clip.name] || clip.name.replace('MH_', '').replace('_UE', ''); $('motion').append(option); }
  $('motion').disabled = false; $('motion').onchange = () => rig.setClip($('motion').value, { immediate: false });
  $('quality').textContent = quality.name; $('triangles').textContent = modelTriangles.toLocaleString('it-IT'); $('clips').textContent = rig.idles.length + ' idle · ' + rig.talks.length + ' talk · 7 mocap'; $('state').textContent = 'Pronta';
  emotion(); view('front'); renderer.render(scene, camera); $('loading').hidden = true; $('demo').disabled = false; resolveReady(window.assetPreview.diagnostics());
} catch (error) { if (!disposed) { $('loading').querySelector('strong').textContent = 'Caricamento non riuscito'; $('loading').querySelector('span').textContent = error.message; $('state').textContent = 'Errore'; } rejectReady(error); disposePreview(); }
