import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { patchSkinMaterial } from './air3-avatar.mjs';

export const STUDIO_QUALITY = Object.freeze({
  high: Object.freeze({ name: 'high', maxPixelRatio: 1.25, shadowSize: 2048, reflectionSize: 1024, reflectionInterval: 1, ao: true, bloom: true, msaa: 4, environmentSize: 256 }),
  balanced: Object.freeze({ name: 'balanced', maxPixelRatio: 1, shadowSize: 1024, reflectionSize: 512, reflectionInterval: 2, ao: false, bloom: true, msaa: 2, environmentSize: 256 }),
  software: Object.freeze({ name: 'software', maxPixelRatio: 1, shadowSize: 512, reflectionSize: 0, reflectionInterval: 1, ao: false, bloom: false, msaa: 0, environmentSize: 128 }),
});

export function resolveStudioQuality(config = {}, gpu = '', query = '') {
  const requested = new URLSearchParams(query).get('quality') || config.renderQuality || config.quality || 'auto';
  const software = /swiftshader|llvmpipe|software rasterizer/i.test(gpu);
  const name = Object.hasOwn(STUDIO_QUALITY, requested) ? requested : software ? 'software' : 'balanced';
  return { ...STUDIO_QUALITY[name], requested, softwareRenderer: software,
    selectionReason: name === requested ? 'explicit selection' : software ? 'software renderer detected' : 'balanced default' };
}

// HDR illumination is authored as geometry/light in linear space. It is baked
// once into a PMREM cube-UV texture, so there is no runtime HDR download.
export function createStudioEnvironment(renderer, quality) {
  const source = new THREE.Scene();
  const roomMaterial = new THREE.MeshStandardMaterial({ color: 0x60666d, roughness: 1, side: THREE.BackSide });
  const room = new THREE.Mesh(new THREE.BoxGeometry(18, 12, 18), roomMaterial);
  room.position.y = 3; source.add(room);
  source.add(new THREE.HemisphereLight(0xffffff, 0x66717c, .4));
  const point = new THREE.PointLight(0xfff5ed, 200, 25, 2); point.position.set(-3, 6, 4); source.add(point);
  const panels = [
    { pos: [-4, 4, 5], scale: [3, 4, .05], color: 0xfff8f0, power: 7, yaw: -.4 },
    { pos: [4, 3, 3], scale: [3, 3.3, .05], color: 0xddefff, power: 4, yaw: .45 },
    { pos: [0, 7, -.5], scale: [7, .05, 3], color: 0xffffff, power: 8, yaw: 0 },
    { pos: [-5, 2, -4], scale: [1, 4, .05], color: 0x73d7dc, power: 2, yaw: -.3 },
    { pos: [4, 2.7, -5], scale: [2, 3, .05], color: 0xffd6a9, power: 1.5, yaw: .2 },
  ];
  for (const panel of panels) {
    const mat = new THREE.MeshLambertMaterial({ color: 0x000000, emissive: panel.color, emissiveIntensity: panel.power });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...panel.scale), mat);
    mesh.position.set(...panel.pos); mesh.rotation.y = panel.yaw; source.add(mesh);
  }
  const generator = new THREE.PMREMGenerator(renderer);
  const target = generator.fromScene(source, .06, .1, 40, { size: quality.environmentSize });
  target.texture.name = 'AIR3 neutral studio softbox HDR PMREM';
  source.traverse((node) => { node.geometry?.dispose(); node.material?.dispose(); });
  generator.dispose();
  return { texture: target.texture, dispose: () => target.dispose(),
    diagnostics: { source: 'authored linear HDR softbox scene', pmrem: true, resolution: quality.environmentSize } };
}

const floorShader = {
  name: 'AIR3 polished stone reflection',
  uniforms: {
    color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null },
    texel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
  },
  vertexShader: /* glsl */`
    uniform mat4 textureMatrix;
    varying vec4 vReflectionUv;
    varying vec3 vWorldPosition;
    void main() {
      vReflectionUv = textureMatrix * vec4(position, 1.0);
      vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    uniform vec2 texel;
    varying vec4 vReflectionUv;
    varying vec3 vWorldPosition;
    void main() {
      vec2 uv = vReflectionUv.xy / vReflectionUv.w;
      vec2 blur = texel * 1.6;
      vec3 reflected = texture2D(tDiffuse, uv).rgb * .40;
      reflected += texture2D(tDiffuse, uv + vec2(blur.x, 0.)).rgb * .15;
      reflected += texture2D(tDiffuse, uv - vec2(blur.x, 0.)).rgb * .15;
      reflected += texture2D(tDiffuse, uv + vec2(0., blur.y)).rgb * .15;
      reflected += texture2D(tDiffuse, uv - vec2(0., blur.y)).rgb * .15;
      float grazing = 1. - clamp(abs(normalize(cameraPosition - vWorldPosition).y), 0., 1.);
      float fresnel = .13 + .35 * pow(grazing, 4.);
      // Small deterministic variation is a stone finish, not temporal noise.
      float grain = fract(sin(dot(floor(vWorldPosition.xz * 180.), vec2(12.9898,78.233))) * 43758.5453);
      vec3 finish = color * (.97 + grain * .06);
      gl_FragColor = vec4(mix(finish, reflected, fresnel), 1.);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
};

export function createStudioFloor(scene, quality) {
  const baseColor = 0x243440;
  if (!quality.reflectionSize) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(12, 11), new THREE.MeshPhysicalMaterial({
      color: baseColor, metalness: .3, roughness: .26, clearcoat: .5, clearcoatRoughness: .22 }));
    mesh.rotation.x = -Math.PI / 2; mesh.position.set(0, -.015, -.5); mesh.receiveShadow = true; scene.add(mesh);
    return { mesh, beginFrame() {}, dispose() {}, diagnostics: { mode: 'environment reflection only' } };
  }
  const size = quality.reflectionSize;
  const reflector = new Reflector(new THREE.PlaneGeometry(12, 11), {
    color: baseColor, textureWidth: size, textureHeight: size, clipBias: .0003, shader: floorShader, multisample: 0,
  });
  reflector.name = 'Polished floor planar reflection';
  reflector.rotation.x = -Math.PI / 2; reflector.position.set(0, -.015, -.5);
  reflector.material.uniforms.texel.value.set(1 / size, 1 / size);
  reflector.userData.air3Reflection = true;
  scene.add(reflector);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(12, 11), new THREE.ShadowMaterial({ color: 0x03090e, opacity: .35, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.set(0, -.014, -.5); shadow.receiveShadow = true; scene.add(shadow);
  const update = reflector.onBeforeRender;
  let frame = 0, lastCapture = -Infinity, rendering = false;
  reflector.onBeforeRender = function (renderer, currentScene, camera) {
    if (rendering || currentScene.userData.air3GBuffer || frame - lastCapture < quality.reflectionInterval) return;
    rendering = true;
    try { update.call(this, renderer, currentScene, camera); lastCapture = frame; }
    finally { rendering = false; }
  };
  return { mesh: reflector, beginFrame(next) { frame = next; }, refresh() { lastCapture = -Infinity; }, dispose: () => reflector.dispose(),
    diagnostics: { mode: 'planar reflection', resolution: size, updateEveryRenderedFrames: quality.reflectionInterval, softened: true } };
}

// A shared normal override drops the extra skin weights. This G-buffer uses a
// normal material per mesh and the same twelve-influence shader adapter instead.
// Transparent/refractive/alpha-card surfaces do not become solid AO rectangles.
class AvatarSafeGTAOPass extends GTAOPass {
  constructor(scene, camera) {
    super(scene, camera, 512, 512, undefined,
      { radius: .2, thickness: .7, distanceExponent: 1.5, distanceFallOff: .8, scale: 1, samples: 8, screenSpaceRadius: false },
      { radius: 5, samples: 8, rings: 2, lumaPhi: 8, depthPhi: 2, normalPhi: 3 });
    this.blendIntensity = .45;
    this.materialCache = new Map();
    const size = super.setSize.bind(this);
    this.setSize = (width, height) => size(Math.max(1, Math.round(width * .6)), Math.max(1, Math.round(height * .6)));
  }
  _renderOverride(renderer, _normalMaterial, renderTarget, clearColor, clearAlpha) {
    const replacements = [], hidden = [], oldBackground = this.scene.background, oldOverride = this.scene.overrideMaterial;
    const oldTarget = renderer.getRenderTarget(), oldColor = renderer.getClearColor(new THREE.Color()), oldAlpha = renderer.getClearAlpha();
    const oldAutoClear = renderer.autoClear, oldShadowUpdate = renderer.shadowMap.autoUpdate;
    this.scene.userData.air3GBuffer = true;
    this.scene.traverse((node) => {
      if (!node.isMesh || !node.visible) return;
      const source = Array.isArray(node.material) ? node.material[0] : node.material;
      if (!source || source.transparent || source.transmission > 0 || source.alphaTest > 0 || node.userData.air3NoAO) {
        hidden.push(node); node.visible = false; return;
      }
      let entry = this.materialCache.get(node);
      if (!entry || entry.source !== source) {
        entry?.material.dispose();
        let material = new THREE.MeshNormalMaterial({ side: source.side });
        const attrs = node.geometry.attributes;
        if (node.isSkinnedMesh && attrs.weights_1) material = patchSkinMaterial(material, attrs.weights_2 ? 3 : 2);
        entry = { source, material }; this.materialCache.set(node, entry);
      }
      replacements.push([node, node.material]); node.material = entry.material;
    });
    try {
      this.scene.background = null; this.scene.overrideMaterial = null;
      renderer.shadowMap.autoUpdate = false; renderer.autoClear = false;
      renderer.setRenderTarget(renderTarget); renderer.setClearColor(clearColor, clearAlpha); renderer.clear();
      renderer.render(this.scene, this.camera);
    } finally {
      for (const [node, material] of replacements) node.material = material;
      for (const node of hidden) node.visible = true;
      this.scene.background = oldBackground; this.scene.overrideMaterial = oldOverride;
      this.scene.userData.air3GBuffer = false;
      renderer.shadowMap.autoUpdate = oldShadowUpdate; renderer.autoClear = oldAutoClear;
      renderer.setClearColor(oldColor, oldAlpha); renderer.setRenderTarget(oldTarget);
    }
  }
  dispose() {
    for (const entry of this.materialCache.values()) entry.material.dispose();
    this.materialCache.clear(); super.dispose();
  }
}

export function createStudioPost(renderer, scene, camera, quality) {
  if (!quality.bloom && !quality.ao) return {
    render() { renderer.render(scene, camera); }, resize() {}, dispose() {},
    diagnostics: { output: 'direct ACES/sRGB', ao: false, bloom: false },
  };
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: Math.min(quality.msaa, renderer.capabilities.maxSamples) });
  const composer = new EffectComposer(renderer, target);
  const render = new RenderPass(scene, camera); composer.addPass(render);
  const passes = [render];
  if (quality.ao) { const ao = new AvatarSafeGTAOPass(scene, camera); composer.addPass(ao); passes.push(ao); }
  if (quality.bloom) {
    const bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), .12, .30, 1.5);
    composer.addPass(bloom); passes.push(bloom);
  }
  const output = new OutputPass(); composer.addPass(output); passes.push(output);
  return {
    render(dt) { composer.render(dt); },
    resize(width, height) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(width, height); },
    dispose() { for (const pass of passes) pass.dispose?.(); composer.dispose(); },
    diagnostics: { output: 'linear half-float → ACES/sRGB', ao: quality.ao ? 'GTAO at 60% resolution, extended skin weights preserved' : false,
      bloom: quality.bloom ? 'HDR threshold 1.50, strength 0.12' : false, msaa: target.samples },
  };
}
