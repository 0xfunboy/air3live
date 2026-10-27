import { LIGHT_NAMES, parseLookPreset } from './look-presets.mjs';

const HAIR = [ ['legacy', 'Coda corta · originale'], ['wavy', 'Wavy · coda ondulata'], ['artemis', 'Artemis · prova non commerciale'] ];
const COLORS = [ ['blonde', 'Biondo'], ['copper', 'Rame'], ['auburn', 'Castano ramato'], ['chestnut', 'Castano'], ['dark-brown', 'Castano scuro'], ['espresso', 'Castano quasi nero'], ['black', 'Nero'] ];
const SHOES = [ ['original', 'Sneakers originali'], ['boot', 'Stivaletti'], ['shoes-test', 'Scarpe test · uso non commerciale'] ];
const CLOTHES = [['original', 'Maglietta originale'], ['crop', 'Maglietta corta · off shoulder']];
const FITS = [['relaxed', 'Gambale adattato'], ['low-cut', 'Gambale basso']];
const options = rows => rows.map(([id, name]) => `<option value="${id}">${name}</option>`).join('');
const range = (field, label, min, max, step, unit = '') => `<label class="look-range"><span>${label}<small>${unit}</small></span><span class="look-range-input"><input data-range="${field}" type="range" min="${min}" max="${max}" step="${step}" aria-label="${label}"><input data-number="${field}" type="number" min="${min}" max="${max}" step="${step}" aria-label="${label}, valore esatto"></span></label>`;

export function mountLookControls(mount, controller, { drawer = false } = {}) {
  if (!mount) return { dispose() {} };
  mount.classList.add('look-controls'); if (drawer) mount.classList.add('look-drawer');
  mount.innerHTML = `<div class="look-heading"><div><p>REGIA DEL PERSONAGGIO</p><h2>Luci e aspetto</h2></div>${drawer ? '<button type="button" class="look-close" aria-label="Chiudi luci e aspetto">✕</button>' : ''}</div>
    <p class="look-intro">Regola la luce sul volto. Confronta capelli, maglietta e scarpe nella stessa scena.</p>
    <div class="look-tabs" role="tablist" aria-label="Luci e aspetto"><button type="button" role="tab" aria-selected="true" data-tab="lighting">Luci</button><button type="button" role="tab" aria-selected="false" data-tab="appearance">Aspetto</button></div>
    <fieldset class="look-fields"><legend class="sr-only">Regolazioni</legend>
    <section data-page="lighting"><h3>Ambiente</h3>
      ${range('ambient', 'Luce diffusa', 0, 1.5, .01)}
      ${range('environment', 'Ambiente e riflessi', 0, 2, .01)}
      ${range('exposure', 'Esposizione', .2, 2.5, .01)}
      <div class="look-divider"></div><h3>Cinque faretti conici</h3>
      <label class="look-label" for="look-light-select">Faretto da regolare</label><select id="look-light-select">${options(LIGHT_NAMES.map((label, i) => [String(i), `${i + 1}. ${label}`]))}</select>
      <div class="look-inline"><label><input id="look-light-enabled" type="checkbox"> Acceso</label><label><input id="look-light-shadows" type="checkbox"> Ombre</label><label class="look-color">Colore <input id="look-light-color" type="color" aria-label="Colore del faretto"></label></div>
      ${range('intensity', 'Potenza', 0, 150, .5, 'cd')}
      ${range('azimuth', 'Posizione sul cerchio', -180, 180, 1, '°')}
      ${range('radius', 'Distanza dal centro', .7, 6, .05, 'm')}
      ${range('height', 'Altezza faretto', 1.6, 5, .05, 'm')}
      ${range('targetHeight', 'Altezza di puntamento', .2, 2, .05, 'm')}
      ${range('cone', 'Semiapertura del cono', 10, 75, 1, '°')}
      ${range('penumbra', 'Morbidezza del bordo', 0, 1, .01)}
      <label class="look-check"><input id="look-follow" type="checkbox"> Punta alla presentatrice quando si sposta</label>
      <label class="look-check"><input id="look-guides" type="checkbox"> Mostra guide dei coni</label>
      <p class="look-help">0° davanti, +90° a destra della scena, ±180° dietro. Le guide restano fuori dall’uscita pulita. Il profilo Software calcola le ombre del solo faretto principale.</p>
    </section>
    <section data-page="appearance" hidden><h3>Capelli</h3><label class="look-label" for="look-hair-style">Acconciatura</label><select id="look-hair-style">${options(HAIR)}</select>
      <label class="look-label" for="look-hair-color">Colore</label><select id="look-hair-color">${options(COLORS)}</select>
      <div class="look-swatches" aria-hidden="true"><i style="--swatch:#d6b678"></i><i style="--swatch:#a64e25"></i><i style="--swatch:#70351f"></i><i style="--swatch:#4a2e22"></i><i style="--swatch:#281b16"></i><i style="--swatch:#3b2b21"></i><i style="--swatch:#100e0e"></i></div>
      <p class="look-help">Sette tonalità, compreso Castano quasi nero. Le sopracciglia seguono il colore scelto. Le acconciature conservano i propri dettagli.</p>
      <div class="look-divider"></div><h3>Maglietta</h3><label class="look-label" for="look-clothing">Modello</label><select id="look-clothing">${options(CLOTHES)}</select><div class="look-divider"></div><h3>Scarpe</h3><label class="look-label" for="look-footwear">Modello</label><select id="look-footwear">${options(SHOES)}</select>
      <div id="look-fit-row"><label class="look-label" for="look-boot-fit">Calzata stivaletti</label><select id="look-boot-fit">${options(FITS)}</select></div><p class="look-help">Confronta il gambale adattato e la versione bassa nella vista Scarpe, anche di profilo e da dietro.</p>
      <p id="look-asset-note" class="look-license" role="status"></p>
    </section></fieldset>
    <div class="look-divider"></div><section class="look-preset"><h3>Il tuo preset</h3><label class="look-label" for="look-preset-name">Nome</label><input id="look-preset-name" type="text" maxlength="80" autocomplete="off">
      <div class="look-actions"><button id="look-export" type="button">Esporta JSON ↓</button><button id="look-import" type="button">Importa JSON</button><button id="look-reset" type="button">Ripristina</button></div>
      <input id="look-import-file" class="sr-only" type="file" accept=".json,application/json" tabindex="-1">
      <p id="look-status" class="look-help" role="status"></p><p class="look-help">Le prove si salvano in questo browser. Esporta il JSON per condividere i valori o fissarli nel pacchetto.</p>
    </section>`;
  const $ = id => mount.querySelector('#' + id);
  let selected = 0, disposed = false, localError = '';
  const statusText = status => status.error || localError || (status.busy ? 'Caricamento del modello…' : status.saved ? 'Preset salvato nel browser.' : status.source === 'package' ? 'Preset incluso nel pacchetto.' : 'Preset del browser applicato.');
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
    const restricted = [preset.hair.style === 'artemis' && 'Artemis', preset.footwear.style === 'shoes-test' && 'Scarpe test'].filter(Boolean);
    $('look-asset-note').textContent = restricted.length ? `${restricted.join(' e ')}: licenza non commerciale. Questa scelta è per prove; per l’uso aziendale serve un’autorizzazione del titolare.` : 'Modelli attivi: attribuzioni e licenze nel dossier del pacchetto.';
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
    try { if (file.size > 32768) throw new Error('Preset troppo grande: massimo 32 KB.'); await controller.apply(parseLookPreset(await file.text())); }
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
    if (toggle) { toggle.disabled = false; toggle.onclick = () => open(mount.hidden); }
    mount.querySelector('.look-close').onclick = () => open(false);
    mount.addEventListener('keydown', event => { if (event.key === 'Escape') open(false); });
  }
  refresh();
  return { dispose() { disposed = true; unsubscribe(); if (toggle) toggle.onclick = null; mount.replaceChildren(); } };
}
