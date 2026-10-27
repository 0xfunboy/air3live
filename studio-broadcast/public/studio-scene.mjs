import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Air3AvatarRig } from './air3-avatar.mjs';
import { Air3StageMotion } from './air3-stage-motion.mjs';
import { applyAvatarMaterials } from './avatar-materials.mjs';
import { createAir3Hair } from './air3-hair.mjs';
import { createHairWardrobe } from './air3-hair-wardrobe.mjs';
import { createFootwearController } from './air3-footwear.mjs';
import { createClothingController } from './air3-clothing.mjs';
import { StudioLighting } from './studio-lighting.mjs';
import { LookController } from './look-controller.mjs';
import { defaultLook } from './look-presets.mjs';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { resolveStudioQuality, createStudioEnvironment, createStudioFloor, createStudioPost } from './studio-rendering.mjs';

const CYAN = 0x45deeb;

// All coordinates are metres. The presenter has a clear route behind the desk;
// these authoring anchors are also consumed by the movement/pointing controller.
export const STAGE_LAYOUT = Object.freeze({
  home: Object.freeze([-.75, .005, .65]),
  monitorTargets: Object.freeze({
    left: Object.freeze([-3.55, 1.95, -2.3]),
    center: Object.freeze([0, 2.15, -3.55]),
    right: Object.freeze([3.55, 1.95, -2.3]),
  }),
  monitorSpots: Object.freeze({
    left: Object.freeze([-2.5, .005, -.85]),
    center: Object.freeze([-.8, .005, -1.85]),
    right: Object.freeze([2.45, .005, -.85]),
  }),
  routes: Object.freeze({
    left: Object.freeze([[-.75, .005, .65], [-1.55, .005, -.15], [-2.5, .005, -.85]]),
    center: Object.freeze([[-.75, .005, .65], [-.9, .005, -.75], [-.8, .005, -1.85]]),
    right: Object.freeze([[-.75, .005, .65], [-.65, .005, -.45], [.75, .005, -.75], [2.45, .005, -.85]]),
  }),
  desk: Object.freeze({ center: Object.freeze([1.65, 0, 1.2]), halfSize: Object.freeze([1.35, .56, .57]) }),
  monitorWidths: Object.freeze({ left: 2.7, center: 3.45, right: 2.7 }),
});

const metal = (color, roughness = .35, metalness = .65) => new THREE.MeshPhysicalMaterial({ color, roughness, metalness, clearcoat: .25, clearcoatRoughness: .3 });
const lightMaterial = (color = CYAN, intensity = 2) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: .25 });

function box(group, size, position, material, rotation = null) {
  const bevel = Math.min(.025, ...size.map((v) => v * .16));
  const geometry = Math.min(...size) > .045 ? new RoundedBoxGeometry(...size, 2, bevel) : new THREE.BoxGeometry(...size);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position); if (rotation) mesh.rotation.set(...rotation);
  mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); return mesh;
}
function cylinder(group, top, bottom, height, pos, material, segments = 64) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(top, bottom, height, segments), material);
  mesh.position.set(...pos); mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); return mesh;
}
function sphere(group, radius, scale, pos, material) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 16), material);
  mesh.scale.set(...scale); mesh.position.set(...pos); mesh.castShadow = true; group.add(mesh); return mesh;
}
function ellipseRail(group, rx, rz, y, material, thickness = .012, centreZ = -.10, start = -Math.PI, end = Math.PI) {
  const points = [];
  for (let i = 0; i <= 96; i++) {
    const angle = THREE.MathUtils.lerp(start, end, i / 96);
    points.push(new THREE.Vector3(rx * Math.sin(angle), y, centreZ - rz * Math.cos(angle)));
  }
  const closed = end - start >= Math.PI * 1.999;
  if (closed) points.pop(); // Do not duplicate the endpoint in a closed spline.
  const curve = new THREE.CatmullRomCurve3(points, closed, 'centripetal');
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 128, thickness, 6, curve.closed), material);
  mesh.castShadow = false; group.add(mesh); return mesh;
}

function curvedWall(group, rx, rz, bottom, height, material, start = -1.90, end = 1.90) {
  const positions = [], uvs = [], indices = [], segments = 80;
  for (let i = 0; i <= segments; i++) {
    const a = THREE.MathUtils.lerp(start, end, i / segments), x = rx * Math.sin(a), z = -.1 - rz * Math.cos(a);
    positions.push(x, bottom, z, x, bottom + height, z); uvs.push(i / segments, 0, i / segments, 1);
    if (i < segments) { const k = i * 2; indices.push(k, k + 2, k + 1, k + 2, k + 3, k + 1); }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); geometry.setIndex(indices); geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material); mesh.receiveShadow = true; group.add(mesh); return mesh;
}

function labelTexture(file) {
  const c = document.createElement('canvas'); c.width = 1536; c.height = 320;
  const ctx = c.getContext('2d');
  const texture = new THREE.CanvasTexture(c); texture.colorSpace = THREE.SRGBColorSpace;
  const image = new Image(); image.decoding = 'async';
  image.onload = () => {
    ctx.clearRect(0, 0, c.width, c.height);
    const scale = Math.min(c.width / image.naturalWidth, c.height / image.naturalHeight);
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    ctx.drawImage(image, (c.width - width) / 2, (c.height - height) / 2, width, height);
    texture.needsUpdate = true;
  };
  image.src = '/assets/air3/branding/' + file;
  texture.addEventListener('dispose', () => { image.onload = null; });
  return texture;
}

function makeMannequin() {
  const group = new THREE.Group(), shell = metal(0x899da4, .4, .4), dark = metal(0x142c35, .45), trim = lightMaterial(CYAN, .8);
  sphere(group, .33, [1, 1.2, .9], [0, 2.43, 0], shell);
  sphere(group, .31, [.9, .65, .91], [0, 2.38, .045], dark);
  cylinder(group, .105, .12, .18, [0, 2.07, 0], dark, 20);
  cylinder(group, .34, .22, .75, [0, 1.62, 0], shell, 32);
  cylinder(group, .22, .25, .24, [0, 1.12, 0], dark, 32);
  sphere(group, .29, [1, .7, .8], [0, .94, 0], shell);
  const eyes = [];
  for (const side of [-1, 1]) {
    const eye = box(group, [.105, .025, .02], [side * .13, 2.47, .292], trim); eyes.push(eye);
    sphere(group, .14, [1, 1, 1], [side * .37, 1.92, 0], dark);
    const upper = cylinder(group, .10, .085, .49, [side * .43, 1.64, .01], shell, 20); upper.rotation.z = side * .16;
    sphere(group, .09, [1, 1, 1], [side * .47, 1.36, .015], dark);
    const lower = cylinder(group, .078, .064, .43, [side * .49, 1.11, .065], shell, 20); lower.rotation.x = -.15;
    sphere(group, .09, [.75, 1.3, .65], [side * .51, .85, .11], shell);
    cylinder(group, .12, .09, .50, [side * .155, .64, .015], shell, 20);
    sphere(group, .09, [1, 1, 1], [side * .155, .37, .015], dark);
    cylinder(group, .09, .067, .27, [side * .155, .19, .015], shell, 20);
    box(group, [.16, .12, .30], [side * .155, .055, .075], dark);
  }
  const jaw = box(group, [.145, .018, .025], [0, 2.30, .294], trim);
  box(group, [.07, .35, .016], [0, 1.64, .288], trim);
  return { group, jaw, eyes };
}

export class StudioScene {
  constructor(container, monitors, config, onStatus) {
    this.container = container; this.monitors = monitors; this.onStatus = onStatus;
    this.config = config; this.disposed = false; this.frameCount = 0; this.lastFrameAt = 0;
    this.lastRaf = 0; this.lastRender = 0; this.fpsFrames = 0; this.fpsStart = performance.now(); this.fps = 0;
    this.speaking = false; this.manualCamera = 'auto'; this.amplitude = 0; this.avatarStatus = 'Calibration mannequin';
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x101c27);
    this.scene.fog = new THREE.FogExp2(0x101c27, .012);
    this.camera = new THREE.PerspectiveCamera(37, 16 / 9, .06, 65);
    this.camera.position.set(2.0, 2.45, 8.7); this.lookTarget = new THREE.Vector3(0, 1.65, -1.0);
    this.camera.lookAt(this.lookTarget);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.setAttribute('aria-label', 'airewardrop three-dimensional broadcast studio');
    container.appendChild(this.renderer.domElement);
    const gl = this.renderer.getContext(), extension = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpu = extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    this.quality = resolveStudioQuality(config, this.gpu, location.search);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio));
    this.environment = createStudioEnvironment(this.renderer, this.quality);
    this.scene.environment = this.environment.texture; this.scene.environmentIntensity = .5;
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault(); this.contextLost = true;
      const error = new Error('WebGL context lost before studio readiness');
      this.rejectAvatarInitialization?.(error); this.avatarLoadingManager?.abort();
      this.rejectAvatarPresented?.(error); this.rejectFirstFrame?.(error);
      this.resolveFirstFrame = null; this.rejectFirstFrame = null;
      this.onStatus('WebGL context lost; broadcaster restart required');
    });
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      this.environment?.dispose();
      this.environment = createStudioEnvironment(this.renderer, this.quality);
      this.scene.environment = this.environment.texture; this.renderer.shadowMap.needsUpdate = true;
      this.contextLost = false; this.onStatus('WebGL context restored; studio environment rebuilt');
    });
    this.textures = {};
    this.build();
    this.post = createStudioPost(this.renderer, this.scene, this.camera, this.quality);
    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(container);
    this.firstFrame = new Promise((resolve, reject) => { this.resolveFirstFrame = resolve; this.rejectFirstFrame = reject; });
    this.firstFrame.catch(() => {});
    this.raf = requestAnimationFrame((now) => this.frame(now));
    if (config.avatarUrl) {
      const cancelled = new Promise((_, reject) => { this.rejectAvatarInitialization = reject; });
      this.avatarReady = Promise.race([this.loadAvatar(config.avatarUrl), cancelled])
        .finally(() => { this.rejectAvatarInitialization = null; });
    } else this.avatarReady = Promise.resolve();
    this.avatarReady.catch(() => {});
  }

  build() {
    this.stageLayout = STAGE_LAYOUT; this.monitorGroups = new Map();
    const room = new THREE.Group(); room.name = 'airewardrop oval broadcast architecture'; this.scene.add(room);
    const wall = metal(0x14202b, .67, .18), graphite = metal(0x0b151e, .34, .55),
      aluminium = metal(0x84959e, .27, .88), slate = metal(0x223641, .43, .5),
      neon = lightMaterial(CYAN, 2.15), neutralLine = lightMaterial(0xbad7e0, 1.6);
    wall.side = THREE.DoubleSide;
    this.floor = createStudioFloor(this.scene, this.quality);
    box(room, [12.8, .12, 11.5], [0, -.09, -.5], graphite);
    // A continuous elliptical wall and floating soffit enclose the audience.
    // Screens stand forward of the arc instead of sharing its surface.
    curvedWall(room, 6.15, 4.65, -.02, 4.45, wall);
    curvedWall(room, 5.98, 4.47, .05, .63, graphite);
    curvedWall(room, 5.98, 4.47, 3.63, .30, graphite);
    const slats = new THREE.InstancedMesh(new THREE.BoxGeometry(.034, 3.50, .15), slate, 59);
    const tr = new THREE.Object3D();
    for (let i = 0; i < 59; i++) {
      const a = THREE.MathUtils.lerp(-1.87, 1.87, i / 58);
      tr.position.set(6.04 * Math.sin(a), 2.09, -.1 - 4.54 * Math.cos(a)); tr.rotation.y = -a;
      tr.updateMatrix(); slats.setMatrixAt(i, tr.matrix);
    }
    slats.castShadow = true; slats.receiveShadow = true; room.add(slats);
    ellipseRail(room, 5.93, 4.43, .69, neon, .014, -.1, -1.90, 1.90);
    ellipseRail(room, 5.91, 4.41, 3.61, neutralLine, .018, -.1, -1.90, 1.90);
    ellipseRail(room, 5.86, 4.36, 3.94, neon, .012, -.1, -1.90, 1.90);
    // A continuous oval floor inlay gives the set depth in the wide camera.
    ellipseRail(room, 5.20, 3.88, .001, neon, .010, -.10);
    ellipseRail(room, 5.06, 3.74, .001, aluminium, .009, -.10);
    ellipseRail(room, 3.92, 2.98, .001, metal(0x46717b, .33, .7), .008, -.10);
    // The five physical projector heads are created by StudioLighting.

    // Compact desk on the right leaves the presenter a real aisle to all screens.
    const desk = new THREE.Group(); desk.name = 'airewardrop glass and stone desk';
    desk.position.fromArray(STAGE_LAYOUT.desk.center); room.add(desk); this.desk = desk;
    const topMaterial = new THREE.MeshPhysicalMaterial({ color: 0x193c49, roughness: .19, metalness: .32,
      clearcoat: 1, clearcoatRoughness: .10 });
    const top = box(desk, [2.70, .075, 1.10], [0, 1.04, 0], topMaterial);
    top.geometry.dispose(); top.geometry = new RoundedBoxGeometry(2.70, .075, 1.10, 5, .035);
    box(desk, [2.52, .018, .028], [0, 1.013, .553], neon).castShadow = false;
    box(desk, [2.36, .06, .88], [0, .09, -.05], graphite);
    for (const x of [-1.03, 1.03]) {
      box(desk, [.09, .89, .68], [x, .55, -.05], aluminium);
      box(desk, [.022, .73, .035], [x, .55, .305], neon).castShadow = false;
    }
    const glass = new THREE.MeshPhysicalMaterial({ color: 0xa4d5dc, metalness: 0, roughness: .10,
      transmission: this.quality.name === 'software' ? 0 : .88,
      transparent: this.quality.name === 'software', opacity: this.quality.name === 'software' ? .3 : 1,
      depthWrite: this.quality.name !== 'software', thickness: .035, ior: 1.48,
      attenuationColor: new THREE.Color(0x75c7cc), attenuationDistance: 2, clearcoat: 1, clearcoatRoughness: .08 });
    box(desk, [1.99, .72, .035], [0, .56, .34], glass).castShadow = false;
    box(desk, [1.94, .29, .07], [0, .53, .12], graphite);
    const deskLogo = new THREE.Mesh(new THREE.PlaneGeometry(1.86, .3875), new THREE.MeshBasicMaterial({
      map: labelTexture('air3-lockup.png'), transparent: true, depthWrite: false }));
    deskLogo.name = 'branding-project-desk';
    deskLogo.position.set(0, .59, .38); deskLogo.userData.air3NoAO = true; desk.add(deskLogo);
    this.createMonitor(this.monitors.center, 'desk', [1.2, 1.34, .95], [-.12, -.05, 0], .71, false);
    box(room, [.53, .018, .19], [1.22, 1.09, 1.53], aluminium);
    const tablet = box(room, [.40, .016, .28], [2.2, 1.09, 1.37], graphite, [-.04, .12, 0]); tablet.castShadow = false;
    this.createMonitor(this.monitors.left, 'left', STAGE_LAYOUT.monitorTargets.left, [0, .50, 0], STAGE_LAYOUT.monitorWidths.left);
    this.createMonitor(this.monitors.center, 'center', STAGE_LAYOUT.monitorTargets.center, [0, 0, 0], STAGE_LAYOUT.monitorWidths.center);
    this.createMonitor(this.monitors.right, 'right', STAGE_LAYOUT.monitorTargets.right, [0, -.50, 0], STAGE_LAYOUT.monitorWidths.right);
    // Glass side fins show a physical thickness and break up the curved wall.
    for (const side of [-1, 1]) {
      const fin = box(room, [.045, 2.75, .85], [side * 5.05, 1.56, -.65], glass);
      fin.rotation.y = side * .63; fin.castShadow = false;
      box(room, [.07, .06, .90], [side * 5.05, .16, -.65], aluminium, [0, side * .63, 0]);
    }

    this.avatar = new THREE.Group(); this.avatar.position.fromArray(STAGE_LAYOUT.home); this.avatar.rotation.y = .05;
    this.mannequin = makeMannequin(); this.mannequin.group.scale.setScalar(1.76 / 2.83);
    this.avatar.add(this.mannequin.group); this.scene.add(this.avatar);
    this.morphs = [];
    this.lighting = new StudioLighting(this.scene, this.renderer, { quality: this.quality, origin: STAGE_LAYOUT.home, fixtures: true, cleanOutput: new URLSearchParams(location.search).get('output') === '1' });
    this.lighting.setState((this.config.lookPreset || defaultLook()).lighting);
  }

  createMonitor(canvas, id, position, rotation, width, halo = true) {
    const group = new THREE.Group(); group.name = `Market monitor ${id}`;
    group.position.set(...position); group.rotation.set(...rotation);
    const height = width * 9 / 16;
    box(group, [width + .12, height + .12, .15], [0, 0, -.075], metal(0x090f14, .25, .7));
    box(group, [width + .045, height + .045, .035], [0, 0, .003], metal(0x50636d, .3, .85));
    // VESA spine, visible articulated rear crossbar, cable channel and a base.
    const support = metal(0x64747d, .29, .86), dark = metal(0x101b24, .40, .55);
    if (id !== 'desk') {
      const ground = -position[1];
      box(group, [.18, position[1] + .12, .16], [0, ground / 2, -.31], support);
      box(group, [Math.min(1.05, width * .4), .13, .19], [0, -.09, -.24], dark);
      box(group, [.053, position[1] - .25, .04], [0, ground / 2 - .04, -.412], dark);
      box(group, [1.18, .10, .83], [0, ground + .055, -.22], dark);
      box(group, [.84, .018, .04], [0, ground + .109, .15], support).castShadow = false;
    } else {
      box(group, [.065, .23, .055], [0, -.20, -.075], support);
      box(group, [.30, .025, .22], [0, -.268, -.025], dark);
    }
    if (halo) box(group, [width - .08, .016, .018], [0, -height / 2 - .047, -.01], lightMaterial(CYAN, 2)).castShadow = false;
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter; texture.generateMipmaps = false;
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.textures[id] = texture;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
    screen.position.z = .025; screen.userData.air3NoAO = true; group.add(screen); this.scene.add(group);
    this.monitorGroups.set(id, group);
    return group;
  }

  getMonitorTarget(id) {
    const group = this.monitorGroups.get(id); if (!group || id === 'desk') return null;
    group.updateWorldMatrix(true, false); return group.localToWorld(new THREE.Vector3(0, -.10, .03));
  }
  presentMonitor(id) { return this.stageMotion?.presentMonitor(id) ?? false; }
  returnHome() { return this.stageMotion?.returnHome() ?? false; }
  enableRoaming(value = true) { return this.stageMotion?.setEnabled(!!value) ?? false; }

  dirty(id = 'all') {
    for (const [key, texture] of Object.entries(this.textures)) if (id === 'all' || id === key || (id === 'center' && key === 'desk')) texture.needsUpdate = true;
  }

  async loadAvatar(path) {
    let loadedAvatar = null;
    try {
      const url = new URL(path, location.origin);
      const localAsset = (pathname) => pathname.startsWith('/assets/') || pathname.startsWith('/studio/assets/');
      if (url.origin !== location.origin || !localAsset(url.pathname) || url.search || url.hash) {
        throw new Error('Avatar must be a same-origin /assets/ file');
      }
      this.avatarStatus = 'Loading configured avatar'; this.onStatus(this.avatarStatus);
      const manager = new THREE.LoadingManager(); this.avatarLoadingManager = manager;
      manager.setURLModifier((resource) => {
        if (resource.startsWith('blob:') || resource.startsWith('data:')) return resource;
        const u = new URL(resource, location.href);
        if (u.origin !== location.origin || !localAsset(u.pathname)) throw new Error('External avatar resources are not allowed');
        return u.href;
      });
      const loader = new GLTFLoader(manager);
      const gltf = await loader.loadAsync(url.href); loadedAvatar = gltf.scene;
      if (this.disposed || this.contextLost) { this.disposeObject(gltf.scene); throw new Error('Studio became unavailable while loading the avatar'); }
      if (gltf.scene.userData.air3?.profile === 'browser-geometry-with-skeletal-animation') {
        this.avatarMaterials = await applyAvatarMaterials(gltf, { renderer: this.renderer,
          assetBase: new URL('../', url).pathname.replace(/\/$/, ''), quality: this.quality.name });
        if (this.disposed || this.contextLost) { this.avatarMaterials?.dispose?.(); this.disposeObject(gltf.scene); throw new Error('Studio became unavailable while loading avatar materials'); }
        this.avatarHair = createAir3Hair(gltf.scene, { quality: this.quality.name });
        this.avatarRig = new Air3AvatarRig(gltf);
        this.avatarRig.setCameraTarget(this.camera);
      }
      gltf.scene.updateMatrixWorld(true);
      const bounds = new THREE.Box3();
      gltf.scene.traverseVisible(obj => { if (obj.isMesh) bounds.union(new THREE.Box3().setFromObject(obj, true)); });
      const size = bounds.getSize(new THREE.Vector3());
      if (!Number.isFinite(size.y) || size.y <= 0 || size.y > 10000) throw new Error('Invalid avatar bounds');
      const root = new THREE.Group(); root.add(gltf.scene);
      root.scale.setScalar(1.76 / size.y);
      this.avatarModel = gltf.scene; this.avatarRoot = root;
      gltf.scene.position.sub(new THREE.Vector3((bounds.min.x + bounds.max.x) / 2, bounds.min.y, (bounds.min.z + bounds.max.z) / 2));
      this.avatar.remove(this.mannequin.group); this.disposeObject(this.mannequin.group); this.mannequin = null;
      this.avatar.add(root);
      this.avatar.updateWorldMatrix(true, true);
      if (this.avatarRig) {
        this.stageMotion = new Air3StageMotion(this.avatarRig, this.avatar, this.stageLayout);
        const preset = this.config.lookPreset || defaultLook();
        const wardrobe = await createHairWardrobe(gltf.scene, { renderer: this.renderer, quality: this.quality.name,
          loader, legacyHair: this.avatarHair, style: preset.hair.style, color: preset.hair.color });
        if (this.disposed || this.contextLost) { wardrobe.dispose(); throw new Error('Studio unavailable while loading hair'); }
        this.avatarHair = wardrobe;
        const footwear = await createFootwearController({ avatarRoot: gltf.scene, rig: this.avatarRig, renderer: this.renderer, quality: this.quality.name });
        if (this.disposed || this.contextLost) { footwear.dispose(); throw new Error('Studio unavailable while loading footwear'); }
        this.footwear = footwear;
        const clothing = await createClothingController({ avatarRoot: gltf.scene, rig: this.avatarRig, renderer: this.renderer, quality: this.quality.name });
        if (this.disposed || this.contextLost) { clothing.dispose(); throw new Error('Studio unavailable while loading clothing'); }
        this.clothing = clothing;
        this.look = new LookController({ lighting: this.lighting, hair: this.avatarHair, footwear: this.footwear, clothing: this.clothing,
          shipped: this.config.lookShipped || defaultLook(), source: this.config.lookSource || 'package' });
        await this.look.apply(preset, { persist: false, source: this.config.lookSource || 'package' });
        if (this.disposed || this.contextLost) throw new Error('Studio unavailable while preparing appearance');
      }
      gltf.scene.traverse((obj) => {
        if (obj.isMesh) { obj.castShadow = !obj.userData.air3NoShadow; obj.receiveShadow = true; }
        for (const [name, index] of Object.entries(obj.morphTargetDictionary ?? {})) {
          if (/^(jawopen|mouthopen)$/i.test(name.replace(/[^a-z]/gi, ''))) this.morphs.push({ obj, index });
        }
      });
      if (gltf.animations.length && !this.avatarRig) {
        this.mixer = new THREE.AnimationMixer(gltf.scene);
        const idle = gltf.animations.find((a) => /idle/i.test(a.name));
        if (idle) this.mixer.clipAction(idle).play();
      }
      this.avatarStatus = this.avatarRig ? 'Presentatrice virtuale · live' :
        this.morphs.length ? 'Configured GLB · amplitude jaw' : 'Configured GLB · no jaw morph';
      this.onStatus(this.avatarStatus);
      // Ready means the complete avatar has passed through the actual renderer,
      // not just that its network requests and JSON parsing have completed.
      await new Promise((resolve, reject) => {
        const finish = (error) => {
          clearTimeout(this.avatarFrameTimer); this.avatarFrameTimer = null;
          this.resolveAvatarPresented = null; this.rejectAvatarPresented = null;
          if (error) reject(error); else resolve();
        };
        this.resolveAvatarPresented = () => finish();
        this.rejectAvatarPresented = (error) => finish(error);
        this.avatarFrameTimer = setTimeout(() => finish(new Error('Configured avatar did not produce its first frame in time')),
          this.quality.softwareRenderer ? 45_000 : 30_000);
        if (this.disposed) finish(new Error('Studio disposed before avatar readiness'));
        else if (this.contextLost) finish(new Error('WebGL context lost before avatar readiness'));
      });
    } catch (error) {
      this.avatarStatus = 'Configured avatar failed to start';
      if (!this.disposed) this.onStatus(`${this.avatarStatus}: ${error.message}`);
      if (loadedAvatar && loadedAvatar !== this.avatarModel) this.disposeObject(loadedAvatar);
      if (!this.disposed) this.dispose();
      throw error;
    }
  }

  setSpeech(state) {
    this.speaking = state.phase === 'playing'; this.amplitude = state.amplitude || 0;
    this.avatarRig?.setSpeech(state);
  }
  setCamera(mode, immediate = false) {
    if (['auto', 'wide', 'presenter', 'screens'].includes(mode)) { this.manualCamera = mode; this.snapCamera = immediate; }
  }
  resize() {
    const width = Math.max(1, this.container.clientWidth), height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false); this.camera.aspect = width / height; this.camera.updateProjectionMatrix();
    this.post?.resize(width, height);
  }

  updatePose(dt, t) {
    this.stageMotion?.update(dt, t);
    const mode = this.manualCamera === 'auto' ? (this.stageMotion?.moving ? 'wide' : this.stageMotion?.phase === 'presenting' ? 'presentation' : this.speaking ? 'presenter' : Math.floor(t / 18) % 3 === 2 ? 'screens' : 'wide') : this.manualCamera;
    this.effectiveCamera = mode;
    let pos, look;
    if (mode === 'presenter') {
      const a = this.avatar.position;
      pos = [a.x + .10 + Math.sin(t * .06) * .015, 1.52, a.z + 2.12]; look = [a.x, 1.36, a.z];
    } else if (mode === 'presentation') {
      const a = this.avatar.position, screen = this.stageLayout.monitorTargets[this.stageMotion.targetId];
      const x = THREE.MathUtils.lerp(a.x, screen[0], .42), z = THREE.MathUtils.lerp(a.z, screen[2], .42);
      pos = [x - Math.sign(screen[0]) * .65, 2.05, z + 5.4]; look = [x, 1.55, z];
    } else if (mode === 'screens') { pos = [.15 + Math.sin(t * .06) * .06, 2.55, 6.7]; look = [0, 1.95, -2.6]; }
    else { pos = [2.0 + Math.sin(t * .055) * .07, 2.45, 8.7]; look = [0, 1.60, -1.0]; }
    const blend = this.snapCamera ? 1 : 1 - Math.exp(-dt * .95); this.snapCamera = false;
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, mode === 'presenter' ? 27 : mode === 'screens' ? 34 : 37, blend);
    this.camera.updateProjectionMatrix();
    this.camera.position.lerp(new THREE.Vector3(...pos), blend); this.lookTarget.lerp(new THREE.Vector3(...look), blend); this.camera.lookAt(this.lookTarget);
    this.avatar.scale.y = this.avatarRig ? 1 : 1 + Math.sin(t * 1.4) * .002;
    this.mixer?.update(dt);
    this.avatarRig?.update(dt);
    this.stageMotion?.afterRigUpdate?.();
    this.avatarHair?.update(dt);
    this.footwear?.update(dt);
    this.clothing?.update(dt);
    this.lighting.update(this.avatar.position);
    if (this.mannequin) {
      this.mannequin.jaw.scale.y = THREE.MathUtils.damp(this.mannequin.jaw.scale.y, 1 + this.amplitude * 4, 18, dt);
      const blink = t % 4.7 < .11 ? .15 : 1;
      for (const eye of this.mannequin.eyes) eye.scale.y = blink;
    }
    for (const { obj, index } of this.morphs) obj.morphTargetInfluences[index] = THREE.MathUtils.damp(obj.morphTargetInfluences[index] || 0, this.amplitude * .75, 16, dt);
  }

  // Deterministic inspection advances the real rig/controller without rendering
  // every intermediate frame. It is exposed only by the ?inspect=1 QA surface.
  // These poses are never counted as measured rendering frames or FPS.
  advanceForInspection(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 45) throw new Error('Inspection interval must be 0–45 seconds');
    this.inspectionPaused = true;
    let remaining = seconds;
    this.inspectionTime ??= performance.now() / 1000;
    while (remaining > 1e-8) {
      const step = Math.min(1 / 60, remaining); remaining -= step; this.inspectionTime += step;
      this.updatePose(step, this.inspectionTime);
    }
    return this.diagnostics();
  }

  frame(now) {
    if (this.disposed) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
    const targetFps = Math.min(60, Math.max(10, this.config.fps || 30));
    if (now - this.lastRender < 1000 / targetFps - 1 || this.contextLost) return;
    const dt = Math.min(.1, (now - (this.lastRender || now)) / 1000); this.lastRender = now;
    const t = now / 1000;
    if (!this.inspectionPaused) this.updatePose(dt, t);
    this.floor.beginFrame(this.frameCount);
    this.renderer.info.reset(); this.post.render(dt);
    this.frameCount++; this.fpsFrames++; this.lastFrameAt = Date.now();
    if (now - this.fpsStart >= 1000) { this.fps = this.fpsFrames * 1000 / (now - this.fpsStart); this.fpsFrames = 0; this.fpsStart = now; }
    this.resolveFirstFrame?.(); this.resolveFirstFrame = null; this.rejectFirstFrame = null;
    this.resolveAvatarPresented?.(); this.resolveAvatarPresented = null;
  }

  captureFrame() {
    if (this.disposed || this.contextLost) throw new Error('Studio render context is unavailable');
    this.floor.refresh?.(); this.renderer.info.reset();
    this.post.render(0);
    return this.renderer.domElement.toDataURL('image/png');
  }

  diagnostics() { return { frameCount: this.frameCount, lastRenderedFrameAt: this.lastFrameAt, lastFrameAt: this.lastFrameAt,
    fps: Number(this.fps.toFixed(1)), gpuRenderer: this.gpu, gpu: this.gpu, contextLost: !!this.contextLost,
    renderer: 'three.js/WebGL', width: this.renderer.domElement.width, height: this.renderer.domElement.height,
    drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, avatar: this.avatarStatus,
    jawMorphs: this.morphs.length, camera: this.manualCamera, effectiveCamera: this.effectiveCamera,
    avatarRig: this.avatarRig?.diagnostics() ?? null,
    quality: this.quality, environment: this.environment.diagnostics, reflections: this.floor.diagnostics,
    postprocessing: this.post.diagnostics, stageLayout: this.stageLayout, stageMotion: this.stageMotion?.diagnostics() ?? null,
    lighting: this.lighting.diagnostics(), look: this.look?.getPreset() ?? null, lookBusy: !!this.look?.busy, lookError: this.look?.error, footwear: this.footwear?.diagnostics() ?? null, clothing: this.clothing?.diagnostics() ?? null,
    hair: this.avatarHair?.diagnostics() ?? null, avatarMaterials: this.avatarMaterials?.diagnostics ?? null,
    branding: { corporateInScene: this.scene.getObjectByName('branding-corporate-backdrop') ? 1 : 0,
      projectInScene: this.scene.getObjectByName('branding-project-desk') ? 1 : 0, monitorLogos: 0 } };
  }

  disposeObject(root) {
    root.traverse((obj) => {
      obj.geometry?.dispose();
      for (const mat of (Array.isArray(obj.material) ? obj.material : [obj.material])) {
        if (!mat) continue;
        for (const value of Object.values(mat)) if (value?.isTexture) value.dispose();
        mat.dispose();
      }
    });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; cancelAnimationFrame(this.raf); this.resizeObserver.disconnect();
    const error = new Error('Studio disposed before readiness');
    this.rejectAvatarInitialization?.(error); this.avatarLoadingManager?.abort();
    this.rejectAvatarPresented?.(error); this.rejectFirstFrame?.(error);
    this.resolveFirstFrame = null; this.rejectFirstFrame = null;
    clearTimeout(this.avatarFrameTimer);
    this.look?.dispose(); this.lighting?.dispose(); this.clothing?.dispose(); this.footwear?.dispose();
    this.stageMotion?.dispose?.(); this.avatarHair?.dispose(); this.avatarRig?.dispose(); this.mixer?.stopAllAction(); this.avatarMaterials?.dispose?.();
    this.post?.dispose(); this.floor?.dispose(); this.environment?.dispose();
    this.disposeObject(this.scene); this.renderer.dispose(); this.renderer.domElement.remove();
  }
}
