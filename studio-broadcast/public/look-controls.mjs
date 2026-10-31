import { LIGHT_NAMES, parseLookPreset } from './look-presets.mjs';

const HAIR = [ ['legacy', 'Original Ponytail'], ['wavy', 'Wavy Ponytail'], ['artemis', 'Artemis · Non-commercial test'] ];
const COLORS = [ ['blonde', 'Blonde'], ['copper', 'Copper'], ['auburn', 'Auburn'], ['chestnut', 'Chestnut'], ['dark-brown', 'Dark Brown'], ['espresso', 'Espresso'], ['black', 'Black'] ];
const SHOES = [ ['original', 'Original Sneakers'], ['boot', 'Boots'], ['shoes-test', 'Test Shoes · Non-commercial'] ];
const CLOTHES = [['original', 'Original Top'], ['crop', 'Cropped Off-Shoulder Top']];
const FITS = [['relaxed', 'Relaxed Boot Cut'], ['low-cut', 'Low-Cut']];
const options = rows => rows.map(([id, name]) => `<option value="${id}">${name}</option>`).join('');
const range = (field, label, min, max, step, unit = '') => `<label class="look-range"><span>${label}<small>${unit}</small></span><span class="look-range-input"><input data-range="${field}" type="range" min="${min}" max="${max}" step="${step}" aria-label="${label}"><input data-number="${field}" type="number" min="${min}" max="${max}" step="${step}" aria-label="${label}, exact value"></span></label>`;

export function mountLookControls(mount, controller, { drawer = false } = {}) {
  if (!mount) return { dispose() {} };
  mount.classList.add('look-controls'); if (drawer) mount.classList.add('look-drawer');
  mount.innerHTML = `<div class="look-heading"><div><p>CHARACTER DIRECTION</p><h2>Lighting & Appearance</h2></div>${drawer ? '<button type="button" class="look-close" aria-label="Close lighting and appearance">✕</button>' : ''}</div>
    <p class="look-intro">Adjust facial lighting. Compare hair, top, and footwear in the active scene.</p>
    <div class="look-tabs" role="tablist" aria-label="Lighting and Appearance"><button type="button" role="tab" aria-selected="true" data-tab="lighting">Lighting</button><button type="button" role="tab" aria-selected="false" data-tab="appearance">Appearance</button></div>
    <fieldset class="look-fields"><legend class="sr-only">Adjustments</legend>
    <section data-page="lighting"><h3>Environment</h3>
      ${range('ambient', 'Diffuse Ambient Light', 0, 1.5, .01)}
      ${range('environment', 'Environment & Reflections', 0, 2, .01)}
      ${range('exposure', 'Exposure', .2, 2.5, .01)}
      <div class="look-divider"></div><h3>Five Spotlights</h3>
      <label class="look-label" for="look-light-select">Spotlight to Adjust</label><select id="look-light-select">${options(LIGHT_NAMES.map((label, i) => [String(i), `${i + 1}. ${label}`]))}</select>
      <div class="look-inline"><label><input id="look-light-enabled" type="checkbox"> Enabled</label><label><input id="look-light-shadows" type="checkbox"> Shadows</label><label class="look-color">Color <input id="look-light-color" type="color" aria-label="Spotlight color"></label></div>
      ${range('intensity', 'Intensity', 0, 150, .5, 'cd')}
      ${range('azimuth', 'Azimuth Angle', -180, 180, 1, '°')}
      ${range('radius', 'Distance from Center', .7, 6, .05, 'm')}
      ${range('height', 'Spotlight Height', 1.6, 5, .05, 'm')}
      ${range('targetHeight', 'Target Height', .2, 2, .05, 'm')}
      ${range('cone', 'Beam Angle', 10, 75, 1, '°')}
      ${range('penumbra', 'Penumbra Softness', 0, 1, .01)}
      <label class="look-check"><input id="look-follow" type="checkbox"> Track presenter on stage movements</label>
      <label class="look-check"><input id="look-guides" type="checkbox"> Show spotlight cones</label>
      <p class="look-help">0° front, +90° stage right, ±180° back. Spotlight guides remain hidden in clean program output. Software profile computes shadows for primary spotlight only.</p>
    </section>
    <section data-page="appearance" hidden><h3>Hair</h3><label class="look-label" for="look-hair-style">Hairstyle</label><select id="look-hair-style">${options(HAIR)}</select>
      <label class="look-label" for="look-hair-color">Color</label><select id="look-hair-color">${options(COLORS)}</select>
      <div class="look-swatches" aria-hidden="true"><i style="--swatch:#d6b678"></i><i style="--swatch:#a64e25"></i><i style="--swatch:#70351f"></i><i style="--swatch:#4a2e22"></i><i style="--swatch:#281b16"></i><i style="--swatch:#3b2b21"></i><i style="--swatch:#100e0e"></i></div>
      <p class="look-help">Seven color tones including Espresso dark brown. Brows track hair color selection.</p>
      <div class="look-divider"></div><h3>Clothing</h3><label class="look-label" for="look-clothing">Style</label><select id="look-clothing">${options(CLOTHES)}</select><div class="look-divider"></div><h3>Footwear</h3><label class="look-label" for="look-footwear">Style</label><select id="look-footwear">${options(SHOES)}</select>
      <div id="look-fit-row"><label class="look-label" for="look-boot-fit">Boot Fit</label><select id="look-boot-fit">${options(FITS)}</select></div><p class="look-help">Compare relaxed cut and low-cut versions in the footwear view.</p>
      <p id="look-asset-note" class="look-license" role="status"></p>
    </section></fieldset>
    <div class="look-divider"></div><section class="look-preset"><h3>Your Preset</h3><label class="look-label" for="look-preset-name">Name</label><input id="look-preset-name" type="text" maxlength="80" autocomplete="off">
      <div class="look-actions"><button id="look-export" type="button">Export JSON ↓</button><button id="look-import" type="button">Import JSON</button><button id="look-reset" type="button">Reset</button></div>
      <input id="look-import-file" class="sr-only" type="file" accept=".json,application/json" tabindex="-1">
      <p id="look-status" class="look-help" role="status"></p><p class="look-help">Customizations are stored in this browser. Export JSON to share settings or persist them.</p>
    </section>`;
  const $ = id => mount.querySelector('#' + id);
  let selected = 0, disposed = false, localError = '';
  const statusText = status => status.error || localError || (status.busy ? 'Loading model…' : status.saved ? 'Preset saved in browser.' : status.source === 'package' ? 'Default package preset.' : 'Browser preset applied.');
  function render(preset, status) {
    if (disposed) return;
    mount.querySelector('.look-fields').disabled = status.busy;
    for (const key of ['look-import', 'look-reset', 'look-export', 'look-preset-name']) $(key).disabled = status.busy;
    const light = preset.lighting.lights[selected];
    for (const input of mount.querySelectorAll('[data-range],[data-number]')) {
      const field = input.dataset.range || input.dataset.number;
      input.value = ['ambient', 'environment', 'exposure'].includes(field) ? preset.lighting[field] : light[field];
    }
    $('look-light-enabled').checked = light.enabled; $('look-light-shadows').checked = light.shadows; $('look-light-color').value = light.color;
    $('look-follow').checked = preset.lighting.followPresenter;
    $('look-hair-style').value = preset.hair.style; $('look-hair-color').value = preset.hair.color; $('look-footwear').value = preset.footwear.style; $('look-clothing').value = preset.clothing.style;
    $('look-boot-fit').value = preset.footwear.fit; $('look-fit-row').hidden = preset.footwear.style !== 'boot';
    if (document.activeElement !== $('look-preset-name')) $('look-preset-name').value = preset.name;
    const restricted = [preset.hair.style === 'artemis' && 'Artemis', preset.footwear.style === 'shoes-test' && 'Test Shoes'].filter(Boolean);
    $('look-asset-note').textContent = restricted.length ? `${restricted.join(' and ')}: non-commercial license for evaluation.` : 'Active models: attributions and licenses documented in package repository.';
    $('look-asset-note').classList.toggle('restricted', !!restricted.length);
    $('look-status').textContent = statusText(status);
  }
  const unsubscribe = controller.subscribe(render);
  const refresh = () => render(controller.getPreset(), controller.status());
  const report = error => { localError = error?.message || String(error); refresh(); };
  const run = task => {
    localError = ''; let generation = controller.generation;
    Promise.resolve().then(() => { const promise = task(); generation = controller.generation; return promise; })
      .catch(error => { if (generation === controller.generation) report(error); });
  };
  function updateLighting(field, value) {
    try {
      const next = controller.lighting.getState();
      if (['ambient', 'environment', 'exposure', 'followPresenter'].includes(field)) next[field] = value;
      else next.lights[selected][field] = value;
      localError = ''; controller.setLighting(next);
    } catch (error) { report(error); }
  }
  for (const input of mount.querySelectorAll('[data-range]')) input.addEventListener('input', () => updateLighting(input.dataset.range, Number(input.value)));
  for (const input of mount.querySelectorAll('[data-number]')) input.addEventListener('change', () => updateLighting(input.dataset.number, Number(input.value)));
  $('look-light-select').onchange = () => { selected = Number($('look-light-select').value); refresh(); };
  $('look-light-enabled').onchange = () => updateLighting('enabled', $('look-light-enabled').checked);
  $('look-light-shadows').onchange = () => updateLighting('shadows', $('look-light-shadows').checked);
  $('look-light-color').oninput = () => updateLighting('color', $('look-light-color').value);
  $('look-follow').onchange = () => updateLighting('followPresenter', $('look-follow').checked);
  $('look-guides').onchange = () => controller.lighting.setGuides($('look-guides').checked);
  $('look-hair-style').onchange = () => run(() => controller.setHair($('look-hair-style').value, $('look-hair-color').value));
  $('look-hair-color').onchange = () => run(() => controller.setHair($('look-hair-style').value, $('look-hair-color').value));
  $('look-footwear').onchange = () => run(() => controller.setFootwear($('look-footwear').value));
  $('look-boot-fit').onchange = () => run(() => controller.setFootwear($('look-footwear').value, $('look-boot-fit').value));
  $('look-clothing').onchange = () => run(() => controller.setClothing($('look-clothing').value));
  $('look-preset-name').onchange = () => run(() => controller.setName($('look-preset-name').value));
  $('look-export').onclick = () => {
    const blob = new Blob([controller.export()], { type: 'application/json' }), url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = 'airewardrop-look.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $('look-import').onclick = () => $('look-import-file').click();
  $('look-import-file').onchange = () => run(async () => {
    const file = $('look-import-file').files[0]; if (!file) return;
    try { if (file.size > 32768) throw new Error('Preset too large: maximum 32 KB.'); await controller.apply(parseLookPreset(await file.text())); }
    finally { $('look-import-file').value = ''; }
  });
  $('look-reset').onclick = () => run(() => controller.reset());
  for (const tab of mount.querySelectorAll('[data-tab]')) tab.onclick = () => {
    for (const button of mount.querySelectorAll('[data-tab]')) button.setAttribute('aria-selected', String(button === tab));
    for (const section of mount.querySelectorAll('[data-page]')) section.hidden = section.dataset.page !== tab.dataset.tab;
  };
  const toggle = document.getElementById('look-toggle');
  if (drawer) {
    mount.hidden = true;
    const open = value => { mount.hidden = !value; toggle?.setAttribute('aria-expanded', String(value)); if (value) mount.querySelector('.look-close').focus(); else toggle?.focus(); };
    toggle?.addEventListener('click', () => open(mount.hidden));
    mount.querySelector('.look-close')?.addEventListener('click', () => open(false));
    window.addEventListener('keydown', e => { if (e.key === 'Escape' && !mount.hidden) { e.preventDefault(); open(false); } });
  }
  return { dispose() { disposed = true; unsubscribe(); } };
}
