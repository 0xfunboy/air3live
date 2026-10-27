import * as THREE from 'three';
import { DEFAULT_LIGHTING, LIGHT_NAMES, validateLighting } from './look-presets.mjs';

// Five actual inverse-square conical lights. No front-facing area-light wash.
export class StudioLighting {
  constructor(scene, renderer, { quality, origin = [0, 0, 0], cleanOutput = false, fixtures = false } = {}) {
    this.scene = scene; this.renderer = renderer; this.quality = quality || { name: 'balanced', shadowSize: 1024 };
    this.origin = new THREE.Vector3().fromArray(origin); this.presenter = this.origin.clone();
    this.cleanOutput = cleanOutput; this.disposed = false; this.guidesEnabled = false;
    this.group = new THREE.Group(); this.group.name = 'Five adjustable studio spotlights'; scene.add(this.group);
    this.ambient = new THREE.HemisphereLight(0xf3f5f6, 0x293442, 0); this.group.add(this.ambient);
    this.spots = Array.from({ length: 5 }, (_, i) => {
      const light = new THREE.SpotLight(0xffffff, 0, 16, .5, .65, 2); light.name = LIGHT_NAMES[i];
      light.shadow.mapSize.set(i === 0 ? this.quality.shadowSize : Math.min(1024, this.quality.shadowSize), i === 0 ? this.quality.shadowSize : Math.min(1024, this.quality.shadowSize));
      light.shadow.camera.near = .15; light.shadow.camera.far = 16;
      light.shadow.bias = -.00008; light.shadow.normalBias = .004; light.shadow.radius = 2;
      this.group.add(light, light.target);
      const helper = new THREE.SpotLightHelper(light); helper.name = `${light.name} · cone guide`; helper.visible = false;
      helper.traverse(n => { n.userData.air3NoAO = true; }); this.group.add(helper);
      let fixture = null, lens = null, suspension = null;
      if (fixtures) {
        fixture = new THREE.Group(); fixture.name = `Physical studio fixture ${i + 1}`;
        const shell = new THREE.Mesh(new THREE.CylinderGeometry(.11, .13, .25, 20), new THREE.MeshStandardMaterial({ color: 0x14212a, metalness: .7, roughness: .36 }));
        shell.rotation.x = Math.PI / 2; shell.position.z = -.04; fixture.add(shell);
        const rim = new THREE.Mesh(new THREE.TorusGeometry(.103, .012, 6, 24), new THREE.MeshStandardMaterial({ color: 0x6d818b, metalness: .9, roughness: .28 }));
        rim.position.z = .09; fixture.add(rim);
        lens = new THREE.Mesh(new THREE.CircleGeometry(.089, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
        lens.position.z = .092; fixture.add(lens); this.group.add(fixture);
        suspension = new THREE.Mesh(new THREE.CylinderGeometry(.012, .012, 1, 8), new THREE.MeshStandardMaterial({ color: 0x34414a, metalness: .6, roughness: .4 }));
        this.group.add(suspension);
      }
      return { light, helper, fixture, lens, suspension };
    });
    this.setState(DEFAULT_LIGHTING);
  }
  getState() { return structuredClone(this.state); }
  setState(value) {
    const next = validateLighting(value); this.state = next;
    this.ambient.intensity = next.ambient; this.scene.environmentIntensity = next.environment;
    this.renderer.toneMappingExposure = next.exposure;
    this.spots.forEach(({ light, fixture, lens, suspension }, i) => {
      const row = next.lights[i], angle = row.azimuth * Math.PI / 180;
      light.position.set(this.origin.x + Math.sin(angle) * row.radius, this.origin.y + row.height, this.origin.z + Math.cos(angle) * row.radius);
      light.intensity = row.enabled ? row.intensity : 0; light.color.set(row.color);
      light.angle = row.cone * Math.PI / 180; light.penumbra = row.penumbra;
      // Software preview keeps one shadow map; all five lights still illuminate.
      const shadows = row.enabled && row.shadows && (this.quality.name !== 'software' || i === 0);
      if (light.castShadow && !shadows) { light.shadow.map?.dispose(); light.shadow.map = null; }
      light.castShadow = shadows; light.shadow.needsUpdate = true;
      if (fixture) {
        fixture.position.copy(light.position); lens.material.color.set(row.enabled ? row.color : '#253238');
        const span = Math.max(.05, this.origin.y + 4.35 - light.position.y);
        suspension.position.copy(light.position).add(new THREE.Vector3(0, span / 2 + .08, 0)); suspension.scale.y = span;
      }
    });
    this.update(this.presenter); this.renderer.shadowMap.needsUpdate = true;
    return this.getState();
  }
  setGuides(enabled) { this.guidesEnabled = !!enabled && !this.cleanOutput; this.update(this.presenter); }
  update(position) {
    if (this.disposed) return;
    if (position?.isVector3) this.presenter.copy(position);
    else if (Array.isArray(position)) this.presenter.fromArray(position);
    const target = this.state.followPresenter ? this.presenter : this.origin;
    this.spots.forEach(({ light, helper, fixture }, i) => {
      light.target.position.set(target.x, target.y + this.state.lights[i].targetHeight, target.z);
      light.target.updateMatrixWorld(); light.updateMatrixWorld();
      fixture?.lookAt(light.target.position);
      helper.visible = this.guidesEnabled && this.state.lights[i].enabled;
      if (helper.visible) helper.update();
    });
  }
  diagnostics() {
    return { ...this.getState(), type: 'five conical inverse-square spotlights', guides: this.guidesEnabled,
      actualShadowLights: this.spots.filter(x => x.light.castShadow).length,
      target: this.presenter.toArray(), lights: this.state.lights.map((x, i) => ({ ...x, worldPosition: this.spots[i].light.position.toArray(), actualShadow: this.spots[i].light.castShadow })) };
  }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    for (const { light, helper, fixture, suspension } of this.spots) {
      helper.dispose(); light.dispose();
      fixture?.traverse(node => { node.geometry?.dispose(); node.material?.dispose(); });
      suspension?.geometry.dispose(); suspension?.material.dispose();
    }
    this.scene.remove(this.group);
  }
}
