import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, extname, sep } from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const service = resolve(import.meta.dirname, '..');
const output = resolve(process.env.AIR3_QA_DIR || join(service, '../docs/validation/current'), 'talk-shoulders');
await mkdir(output, { recursive: true });
const chrome = process.env.AIR3_CHROME_PATH || (await readFile(join(service, '.browser-path'), 'utf8')).trim();
const html = `<html><link rel="icon" href="data:,"><style>body{margin:0}canvas{display:block}</style>
<script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {Air3AvatarRig} from '/air3-avatar.mjs';
import {applyAvatarMaterials} from '/avatar-materials.mjs';
import {createAir3Hair} from '/air3-hair.mjs';
import {createHairWardrobe} from '/air3-hair-wardrobe.mjs';
import {createClothingController} from '/air3-clothing.mjs';
const renderer = new THREE.WebGLRenderer({antialias:true, preserveDrawingBuffer:true});
renderer.setSize(1000, 1000); renderer.setPixelRatio(1); renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = .95; document.body.append(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color('#18232e');
scene.add(new THREE.HemisphereLight(0xffffff, 0x574d4a, .5));
const key = new THREE.DirectionalLight(0xfff1df, 2.4); key.position.set(2,3,3); scene.add(key);
const fill = new THREE.DirectionalLight(0xaacfff, .7); fill.position.set(-3,1,-1); scene.add(fill);
const gltf = await new GLTFLoader().loadAsync('/assets/air3/models/AIR3-runtime.glb');
await applyAvatarMaterials(gltf,{renderer}); scene.add(gltf.scene);
const legacyHair = createAir3Hair(gltf.scene, {quality:'balanced'});
const rig = new Air3AvatarRig(gltf); rig.setEyeContactEnabled(false); rig.setMicroExpressionsEnabled(false);
const hair = await createHairWardrobe(gltf.scene, {renderer, quality:'balanced', legacyHair, style:'wavy', color:'espresso'});
const clothing = await createClothingController({avatarRoot:gltf.scene, rig}); await clothing.setStyle('crop');
const camera = new THREE.PerspectiveCamera(34,1,.01,100);
window.go = function(config) {
  rig.talkShoulders.restore(); rig.talkShoulders.enabled = config.corrected;
  rig.setClip(config.clip); rig.setTime(config.time); rig.setEmotion('happy', 1);
  rig.update(0); hair.update(0); clothing.update(0);
  const neck = rig.bodyBones.get('neck_01').getWorldPosition(new THREE.Vector3());
  const target = neck.clone().add(new THREE.Vector3(0,-.10,0));
  camera.position.copy(target).add(config.view === 'side' ? new THREE.Vector3(1.2,.03,1.6) : new THREE.Vector3(.0,.03,1.8));
  camera.lookAt(target); renderer.render(scene,camera);
  const shoulders = Object.fromEntries(['l','r'].map(side => [side,
    rig.bodyBones.get('upperarm_'+side).getWorldPosition(new THREE.Vector3()).toArray()]));
  return {shoulders, neck:neck.toArray(), correction:rig.talkShoulders.diagnostics(), frame:renderer.domElement.toDataURL('image/png')};
}; window.ready = true;
</script></html>`;
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/') { res.setHeader('content-type','text/html'); res.end(html); return; }
    const decoded = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(part => part.startsWith('.'))) throw new Error('Not found');
    const base = decoded.startsWith('/node_modules/') ? service : join(service, 'public');
    const file = resolve(base, '.' + decoded);
    if (!file.startsWith(base + sep) || !types[extname(file)]) throw new Error('Not found');
    res.setHeader('content-type', types[extname(file)]); res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end('Not found'); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser; const errors = [], frames = [];
try {
  browser = await puppeteer.launch({ executablePath: chrome, headless: true,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
  page.on('console', row => { if (row.type() === 'error') errors.push(row.text()); });
  page.on('response', response => { if (response.status() >= 400) errors.push(response.status() + ' ' + response.url()); });
  await page.goto('http://127.0.0.1:' + server.address().port); await page.waitForFunction('window.ready', {timeout:120000});
  for (const [clip, time] of [['MH_Talk',19.6], ['MH_Talk01',3], ['MH_Talk02',4.6], ['MH_Talk03',6.366666666667]]) {
    for (const corrected of [false, true]) for (const view of ['front', 'side']) {
      const config = {clip,time,corrected,view}; const {frame,...pose} = await page.evaluate(config => window.go(config), config);
      const file = clip + '-' + (corrected ? 'corrected' : 'original') + '-' + view + '.png';
      await writeFile(join(output,file), Buffer.from(frame.split(',')[1],'base64')); frames.push({file,config,...pose});
    }
  }
  assert.equal(errors.length,0);
  const sources = {};
  for (const file of ['public/air3-avatar.mjs','public/air3-talk-shoulders.mjs','public/air3-clothing.mjs',
    'public/assets/air3/models/AIR3-runtime.glb','public/assets/air3/clothing/crop-top.glb','scripts/qa-talk-visual.mjs']) {
    const bytes = await readFile(join(service,file)); sources[file] = { bytes:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex') };
  }
  await writeFile(join(output,'visual-report.json'),JSON.stringify({passed:true,date:new Date().toISOString(),
    browser:await browser.version(),renderer:'Chromium SwiftShader; 1000×1000 framebuffer; original source modules',
    sources,errors,frames,limitations:['Diagnostic diffuse lighting differs from the five studio lights.',
      'Each before/after pair uses identical current clothing, hair and clip time; only the talk shoulder envelope changes.',
      'Static source-module frames verify silhouette; they do not measure live FPS or dynamic cloth collisions.']},null,2)+'\n');
  console.log(JSON.stringify({passed:true,captures:frames.length,output}));
} finally { await browser?.close(); await new Promise(done => server.close(done)); }
