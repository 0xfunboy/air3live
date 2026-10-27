/** Real compiled frontend QA. Exports the WebGL framebuffer, never a browser UI screenshot. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';
import { serviceRoot } from '../src/config.mjs';

const output = resolve(process.env.AIR3_QA_DIR || resolve(serviceRoot, '../docs/validation/current'));
const renders = resolve(output, 'renders'); await mkdir(renders, { recursive: true });
const build = JSON.parse(await readFile(resolve(serviceRoot, 'public/build/manifest.json'), 'utf8'));
const shippedLook = JSON.parse(await readFile(resolve(serviceRoot, 'public/assets/air3/presets/default-look.json'), 'utf8'));
let executablePath = process.env.AIR3_CHROME_PATH;
if (!executablePath) executablePath = (await readFile(resolve(serviceRoot, '.browser-path'), 'utf8')).trim();
const server = spawn(process.execPath, [resolve(serviceRoot, '../tools/preview-server.mjs'), '--studio', serviceRoot, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
let browser, serverLog = '', active = null;
const result = { schema: 'air3.compiled-visual-qa.v1', date: new Date().toISOString(), build,
  captures: [], preview: null, studio: [], passed: false, limitations: ['Visual functional QA, not Unreal parity or a sustained GPU performance benchmark', 'Market feed is intentionally unconfigured; empty monitors are not invented market data', 'Some rig poses are deterministically advanced without intermediate rendering; these images do not measure real-time locomotion FPS'] };
try {
  const base = await new Promise((done, fail) => {
    const timeout = setTimeout(() => fail(new Error('Preview server startup timed out')), 15000);
    server.once('error', (error) => { clearTimeout(timeout); fail(error); });
    server.once('exit', (code) => { clearTimeout(timeout); fail(new Error('Preview server exited: ' + code)); });
    server.stderr.on('data', bytes => { serverLog += bytes; });
    server.stdout.on('data', bytes => {
      serverLog += bytes;
      for (const line of serverLog.split('\n')) try { const row = JSON.parse(line); if (row.preview) { clearTimeout(timeout); done(row.preview); return; } } catch {}
    });
  });
  const args = ['--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'];
  if (process.getuid?.() === 0) args.push('--no-sandbox'); // Only this isolated QA process.
  if (process.env.AIR3_QA_SOFTWARE === 'true') args.push('--enable-unsafe-swiftshader', '--use-angle=swiftshader');
  browser = await puppeteer.launch({ executablePath, headless: true, protocolTimeout: 180000, args });
  result.browser = await browser.version();
  const page = await browser.newPage();
  const requestOwners = new WeakMap();
  page.on('request', q => requestOwners.set(q, { row: active, startedAt: Date.now() }));
  page.on('pageerror', e => active?.errors.push(e.stack || e.message));
  page.on('console', m => { if (m.type() === 'error') active?.errors.push(m.text()); });
  page.on('requestfailed', q => {
    const owner = requestOwners.get(q), row = owner?.row;
    if (!row) return;
    const requestUrl = new URL(q.url());
    const failure = { path: requestUrl.pathname, probeId: requestUrl.searchParams.get('probe'),
      status: q.response()?.status() ?? null, failure: q.failure()?.errorText,
      startedAt: owner.startedAt, failedAt: Date.now(), afterPageTeardown: !!row.teardownAt };
    // Navigating away terminates that page's health worker. Attribute its
    // cancelled request to that page, never the next profile's renderer.
    if (row.teardownAt && failure.path === '/api/health' && failure.failure === 'net::ERR_ABORTED') {
      (row.lifecycleAborts ||= []).push(failure);
    } else row.failedRequests.push(failure);
  });
  page.on('response', r => {
    if (r.status() >= 400) requestOwners.get(r.request())?.row?.httpErrors.push({ path: new URL(r.url()).pathname, status: r.status() });
  });
  function assertPageNetwork(row) {
    row.completedHealthCdpAborts ||= [];
    row.failedRequests = row.failedRequests.filter(failure => {
      const probe = row.final?.health?.probes.find(item => item.probeId === failure.probeId);
      if (failure.path === '/api/health' && failure.failure === 'net::ERR_ABORTED' &&
          failure.status === 200 && failure.probeId && probe?.ok === true) {
        row.completedHealthCdpAborts.push({ ...failure, applicationProbe: probe,
          classification: 'CDP abort after HTTP 200 and complete successful JSON read; exact probe ID correlation' });
        return false;
      }
      return true;
    });
    assert.equal(row.errors.length + row.failedRequests.length + row.httpErrors.length, 0,
      'No JavaScript, shader, asset, HTTP or uncorrelated network errors: ' + (row.quality || 'preview'));
    if (row.quality) {
      assert.equal(row.final.health.workerFailed, false, 'Health worker remains available');
      assert.equal(row.final.health.failures, 0, 'No failed or timed-out application health probes');
      assert.ok(row.final.health.successes > 0 && row.final.gatewayConnected, 'Gateway has completed successful application checks');
    }
  }
  async function frame(name, api) {
    const url = await page.evaluate(api => window[api].captureFrame(), api);
    assert.ok(url?.startsWith('data:image/png;base64,'), 'Valid framebuffer PNG');
    const bytes = Buffer.from(url.split(',')[1], 'base64'); assert.ok(bytes.length > 10000, 'Nonempty scene image');
    await writeFile(resolve(renders, name + '.png'), bytes);
    result.captures.push({ file: 'renders/' + name + '.png', bytes: bytes.length, source: 'WebGL canvas, no browser interface' });
  }
  active = result.preview = { errors: [], failedRequests: [], httpErrors: [] };
  await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
  await page.goto(base + '?quality=software', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !!window.assetPreview, { timeout: 120000 });
  active.ready = await page.evaluate(() => window.assetPreview.ready);
  assert.ok(await page.evaluate(() => [...document.scripts].some(s => s.src.endsWith('/studio/build/preview.js'))), 'Compiled preview entrypoint');
  assert.equal(active.ready.sourceModelTriangles, 267252);
  assert.ok(active.ready.hair, 'New hairstyle loaded');
  assert.equal(active.ready.facialLipSync.ready, true);
  assert.equal(active.ready.facialLipSync.emotion, 'happy');
  assert.equal(active.ready.facialLipSync.emotionIntensity, 1);
  assert.deepEqual(active.ready.look, shippedLook, 'New session starts with the requested appearance and exact supplied lighting');
  assert.equal(active.ready.hair.color, 'espresso');
  assert.equal(active.ready.materials.brows.linkedHairColor, active.ready.hair.colorSrgb);
  active.skinWeights = await page.evaluate(() => assetPreview.inspect());
  for (const mesh of active.skinWeights) assert.ok(mesh.minWeightSum > .9999 && mesh.maxWeightSum < 1.0001);
  assert.equal(active.skinWeights.filter(mesh => mesh.skinAdapter).length, 7);
  active.clips = await page.$$eval('#motion option', rows => rows.map(row => row.value).filter(Boolean));
  assert.equal(active.clips.length, 14);
  assert.equal(active.clips.filter(name => name.startsWith('ACCAD_')).length, 7);
  for (const name of active.clips) {
    await page.evaluate(name => { assetPreview.setMotion(name); assetPreview.setTime(.5); }, name);
    const positions = await page.evaluate(() => assetPreview.bonePositions());
    assert.ok(Object.values(positions).every(v => v?.every(Number.isFinite)), 'Finite body pose: ' + name);
  }
  await page.evaluate(() => { assetPreview.setMotion('MH_Idle01_UE'); assetPreview.setTime(0); assetPreview.setEyeContact(false); assetPreview.front(); assetPreview.advanceForInspection(1); });
  await frame('avatar-front', 'assetPreview');
  await page.evaluate(() => assetPreview.side()); await frame('avatar-side', 'assetPreview');
  await page.evaluate(() => { assetPreview.face(); assetPreview.setEyeContact(true); assetPreview.advanceForInspection(2); }); await frame('avatar-face', 'assetPreview');
  await page.evaluate(() => { assetPreview.setFacialPreview({ blink: 1 }); assetPreview.advanceForInspection(.45); }); await frame('avatar-blink', 'assetPreview');
  assert.equal((await page.evaluate(() => assetPreview.diagnostics())).facialLipSync.blink, 1);
  await page.evaluate(() => { assetPreview.setFacialPreview({ mouthCue: 'D', blink: 0 }); assetPreview.advanceForInspection(.45); }); await frame('avatar-speech-D', 'assetPreview');
  assert.equal((await page.evaluate(() => assetPreview.diagnostics())).facialLipSync.mouthCue, 'D');
  await page.evaluate(() => { assetPreview.setFacialPreview({ mouthCue: 'X', blink: 0, emotion: 'warm', intensity: .35 }); assetPreview.advanceForInspection(.65); });
  await frame('avatar-warm', 'assetPreview');
  await page.evaluate(() => { assetPreview.setFacialPreview({ mouthCue: 'X', blink: 0, emotion: 'surprised', intensity: .30 }); assetPreview.advanceForInspection(.65); });
  await frame('avatar-surprised', 'assetPreview');
  await page.evaluate(() => { assetPreview.clearFacialPreview(); assetPreview.setEyeContact(true); assetPreview.threequarter(); assetPreview.advanceForInspection(2); });
  await frame('avatar-eye-contact-threequarter', 'assetPreview');
  // Exercise the shipped appearance and light controls, not a separate render mock.
  active.lookdev = { initial: await page.evaluate(() => assetPreview.getLookPreset()), hair: [], shoes: [], bootFits: [], clothing: [], mocap: [] };
  assert.equal((await page.evaluate(() => assetPreview.diagnostics())).lighting.lights.length, 5);
  await page.$eval('input[data-range="ambient"]', el => { el.value = '.11'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal((await page.evaluate(() => assetPreview.getLookPreset())).lighting.ambient, .11);
  await page.select('#look-light-select', '1');
  await page.$eval('input[data-number="intensity"]', el => { el.value = '27.5'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.equal((await page.evaluate(() => assetPreview.getLookPreset())).lighting.lights[1].intensity, 27.5);
  const savedBeforeReload = await page.evaluate(() => assetPreview.getLookPreset());
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !!window.assetPreview, { timeout: 120000 }); await page.evaluate(() => assetPreview.ready);
  assert.deepEqual(await page.evaluate(() => assetPreview.getLookPreset()), savedBeforeReload, 'Browser preference survives reload');
  active.lookdev.reloadPersisted = true;
  const imported = structuredClone(savedBeforeReload); imported.name = 'QA import roundtrip'; imported.lighting.lights[4].height = 3.17;
  const importPath = resolve(output, 'look-import-roundtrip.json'); await writeFile(importPath, JSON.stringify(imported));
  await (await page.$('#look-import-file')).uploadFile(importPath);
  await page.waitForFunction(() => assetPreview.getLookPreset().name === 'QA import roundtrip' && !assetPreview.diagnostics().lookBusy, { timeout: 120000 });
  assert.deepEqual(await page.evaluate(() => assetPreview.getLookPreset()), imported, 'File input applies exact JSON');
  active.lookdev.imported = imported;
  await page.evaluate(() => { assetPreview.face(); assetPreview.setPaused(true); assetPreview.advanceForInspection(1); });
  await frame('look-five-spots-face', 'assetPreview');
  await page.evaluate(() => { const p = assetPreview.getLookPreset(); p.lighting.ambient = .01; p.lighting.environment = .06;
    p.lighting.lights.forEach((row, i) => { row.enabled = i === 1; }); assetPreview.setLighting(p.lighting); });
  await frame('look-side-light-face', 'assetPreview');
  await page.evaluate(async () => assetPreview.setLookPreset(await (await fetch('/assets/air3/presets/default-look.json')).json()));
  await page.click('[data-tab="appearance"]');
  await page.select('#look-hair-style', 'wavy');
  await page.waitForFunction(() => assetPreview.diagnostics().hair.style === 'wavy' && !assetPreview.diagnostics().lookBusy, { timeout: 120000 });
  for (const style of ['wavy', 'artemis', 'legacy']) {
    await page.evaluate(async style => { await assetPreview.setHair(style, 'chestnut'); assetPreview.face(); assetPreview.advanceForInspection(.6); }, style);
    active.lookdev.hair.push(await page.evaluate(() => assetPreview.diagnostics().hair));
    await frame('hair-' + style + '-chestnut', 'assetPreview');
    await page.evaluate(() => assetPreview.side()); await frame('hair-' + style + '-side', 'assetPreview');
  }
  for (const color of ['blonde', 'copper', 'auburn', 'chestnut', 'dark-brown', 'espresso', 'black']) {
    await page.evaluate(async color => { await assetPreview.setHair('artemis', color); assetPreview.face(); }, color);
    const state = await page.evaluate(() => assetPreview.diagnostics().hair);
    assert.equal(state.color, color); active.lookdev.hair.push(state);
    assert.equal((await page.evaluate(() => assetPreview.diagnostics())).materials.brows.linkedHairColor, state.colorSrgb, 'Eyebrows track the selected hair tint');
    if (['blonde', 'copper', 'black'].includes(color)) await frame('hair-artemis-' + color, 'assetPreview');
  }
  await page.evaluate(async () => { await assetPreview.setHair('wavy', 'espresso'); assetPreview.setMotion('MH_Idle01_UE'); assetPreview.setTime(0); });
  for (const style of ['original', 'boot', 'shoes-test']) {
    await page.select('#look-footwear', style);
    await page.waitForFunction(style => assetPreview.diagnostics().footwear.style === style && !assetPreview.diagnostics().lookBusy, { timeout: 120000 }, style);
    await page.evaluate(() => { assetPreview.feet(); assetPreview.advanceForInspection(.3); });
    active.lookdev.shoes.push(await page.evaluate(() => assetPreview.diagnostics().footwear));
    await frame('footwear-' + style, 'assetPreview');
  }
  await page.select('#look-footwear', 'boot');
  await page.waitForFunction(() => assetPreview.diagnostics().footwear.style === 'boot' && !assetPreview.diagnostics().lookBusy, { timeout: 120000 });
  for (const fit of ['relaxed', 'low-cut']) {
    await page.select('#look-boot-fit', fit);
    await page.waitForFunction(fit => assetPreview.getLookPreset().footwear.fit === fit && !assetPreview.diagnostics().lookBusy, { timeout: 120000 }, fit);
    await page.evaluate(() => { assetPreview.feetRear(); assetPreview.advanceForInspection(.3); });
    active.lookdev.bootFits.push(await page.evaluate(() => assetPreview.diagnostics().footwear));
    await frame('boot-' + fit + '-rear', 'assetPreview');
  }
  await page.evaluate(async () => { await assetPreview.setFootwear('boot', 'relaxed'); assetPreview.setExpression('happy', 1); });
  for (const style of ['original', 'crop']) {
    await page.select('#look-clothing', style);
    await page.waitForFunction(style => assetPreview.getLookPreset().clothing.style === style && !assetPreview.diagnostics().lookBusy, { timeout: 120000 }, style);
    active.lookdev.clothing.push(await page.evaluate(() => assetPreview.diagnostics().clothing));
    await page.evaluate(() => { assetPreview.front(); assetPreview.advanceForInspection(.3); }); await frame('shirt-' + style + '-front', 'assetPreview');
    if (style === 'crop') {
      await page.evaluate(() => assetPreview.side()); await frame('shirt-crop-side', 'assetPreview');
      await page.evaluate(() => assetPreview.back()); await frame('shirt-crop-back', 'assetPreview');
    }
  }
  const outfitBeforeReload = await page.evaluate(() => assetPreview.getLookPreset());
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !!window.assetPreview, { timeout: 120000 }); await page.evaluate(() => assetPreview.ready);
  assert.deepEqual(await page.evaluate(() => assetPreview.getLookPreset()), outfitBeforeReload, 'Clothing and fitted boots survive reload together');
  active.lookdev.outfitReloadPersisted = true;
  await page.evaluate(async () => { await assetPreview.setFootwear('boot'); assetPreview.front(); assetPreview.setEyeContact(false); });
  for (const name of active.clips.filter(name => name.startsWith('ACCAD_'))) {
    await page.evaluate(name => { assetPreview.setMotion(name); assetPreview.setTime(.45); }, name);
    const bones = await page.evaluate(() => assetPreview.bonePositions());
    assert.ok(Object.values(bones).every(position => position.every(Number.isFinite)));
    active.lookdev.mocap.push({ name, bones });
    if (name === 'ACCAD_Walk_Female') await frame('mocap-walk-in-place', 'assetPreview');
  }
  await page.evaluate(async () => { await assetPreview.setLookPreset(await (await fetch('/assets/air3/presets/default-look.json')).json()); assetPreview.setMotion('MH_Idle01_UE'); assetPreview.setTime(0); });
  active.lookdev.finalPreset = await page.evaluate(() => assetPreview.getLookPreset());
  active.final = await page.evaluate(() => assetPreview.diagnostics());
  assert.equal(active.errors.length + active.failedRequests.length + active.httpErrors.length, 0, 'Preview has no browser or asset errors');
  active.teardownAt = Date.now(); active = null;
  await page.goto('about:blank');
  await page.setViewport({ width: 960, height: 540, deviceScaleFactor: 1 });
  for (const quality of ['software', 'balanced', 'high']) {
    active = { quality, errors: [], failedRequests: [], httpErrors: [] }; result.studio.push(active);
    await page.goto(new URL('/studio?output=1&inspect=1&camera=wide&quality=' + quality, base).href, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => !!window.air3Studio, { timeout: 120000 });
    await page.evaluate(() => air3Studio.ready);
    assert.ok(await page.evaluate(() => [...document.scripts].some(s => s.src.endsWith('/studio/build/app.js'))), 'Compiled studio entrypoint');
    active.ready = await page.evaluate(() => air3Studio.diagnostics());
    assert.ok(active.ready.avatarRig, 'Real avatar is ready, not a calibration mannequin');
    assert.equal(active.ready.avatarRig.facialLipSync.emotion, 'happy');
    assert.equal(active.ready.avatarRig.facialLipSync.emotionIntensity, 1);
    assert.deepEqual(active.ready.look, shippedLook);
    assert.deepEqual(active.ready.branding, { corporateInScene: 1, projectInScene: 1, monitorLogos: 0 });
    active.corporateOverlayCount = await page.$$eval('img[src$="/airewardrop-lockup.png"]', images => images.length);
    assert.equal(active.corporateOverlayCount, 1, 'Exactly one corporate logo outside the 3D scene');
    await page.waitForFunction(() => air3Studio.diagnostics().gatewayConnected, { timeout: 60000 });
    await page.evaluate(() => air3StudioInspector.advance(2));
    await frame('studio-' + quality + '-wide', 'air3Studio');
    await page.evaluate(() => { window.qaCameraFrame = air3Studio.diagnostics().frameCount; air3Studio.setCamera('presenter', true); });
    await page.evaluate(() => air3StudioInspector.advance(1.6));
    await frame('studio-' + quality + '-presenter', 'air3Studio');
    if (quality === 'balanced') {
      await page.evaluate(() => { air3Studio.setCamera('auto', true); air3Studio.presentMonitor('left'); });
      await page.evaluate(() => air3StudioInspector.advance(4));
      await frame('studio-walking-left', 'air3Studio');
      await page.evaluate(() => air3StudioInspector.advance(28));
      const left = await page.evaluate(() => air3Studio.diagnostics());
      assert.equal(left.stageMotion.phase, 'presenting');
      assert.equal(left.effectiveCamera, 'presentation');
      await frame('studio-present-monitor-left', 'air3Studio');
      active.leftPresentation = left.stageMotion;
      await page.evaluate(() => { air3Studio.returnHome(); return air3StudioInspector.advance(38); });
      assert.equal((await page.evaluate(() => air3Studio.diagnostics())).stageMotion.phase, 'home');
      await page.evaluate(() => { air3Studio.presentMonitor('right'); return air3StudioInspector.advance(40); });
      assert.equal((await page.evaluate(() => air3Studio.diagnostics())).stageMotion.phase, 'presenting');
      await frame('studio-present-monitor-right', 'air3Studio');
      active.rightPresentation = (await page.evaluate(() => air3Studio.diagnostics())).stageMotion;
      await page.evaluate(() => { air3Studio.returnHome(); return air3StudioInspector.advance(40); });
      await page.evaluate(() => { air3Studio.presentMonitor('center'); return air3StudioInspector.advance(38); });
      assert.equal((await page.evaluate(() => air3Studio.diagnostics())).stageMotion.phase, 'presenting');
      await frame('studio-present-monitor-center', 'air3Studio');
      active.centerPresentation = (await page.evaluate(() => air3Studio.diagnostics())).stageMotion;
      await page.evaluate(async () => { await air3Studio.setClothing('crop'); return air3StudioInspector.advance(1); });
      await frame('studio-crop-monitor-center', 'air3Studio');
      await page.evaluate(async () => air3Studio.setClothing('original'));
    }
    await page.waitForFunction(() => !air3Studio.diagnostics().health.pending, { timeout: 60000, polling: 200 });
    active.final = await page.evaluate(() => air3Studio.diagnostics());
    assert.equal(active.final.quality.name, quality);
    assertPageNetwork(active);
    active.teardownAt = Date.now(); active = null; await page.goto('about:blank');
  }
  for (const row of [result.preview, ...result.studio]) assertPageNetwork(row);
  result.passed = true;
} catch (error) { result.error = error.stack; process.exitCode = 1; }
finally {
  active = null; await browser?.close();
  server.kill('SIGTERM'); await Promise.race([new Promise(done => server.once('exit', done)), sleep(2000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
  await writeFile(resolve(output, 'compiled-visual-qa.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ passed: result.passed, output, captures: result.captures.map(r => basename(r.file)), error: result.error }));
}
