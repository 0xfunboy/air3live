import { fetchJson, FEEDS, isStale, ageLabel } from './pure.mjs';
import { MarketData } from './data.mjs';
import { SpeechPlayer } from './speech-player.mjs';
import { StudioMonitors } from './monitors.mjs';
import { StudioScene } from './studio-scene.mjs';
import { normalizeMouthCues, mouthCueAt, mouthPoseWeightsAt } from './lip-sync.mjs';
import { normalizeEmotionName } from './air3-face.mjs';
import { loadInitialLook } from './look-controller.mjs';
import { mountLookControls } from './look-controls.mjs';
import { resolvePresenterEmotion } from './presenter-emotion.mjs';
import { createLiveMarketClient } from './live-market-client.mjs';
import { createProgramClient, mountLiveTitles } from './live-program.mjs';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
if (params.get('output') === '1') document.body.classList.add('output');

let scene, market, monitors, config, player, tickTimer, sampleRaf, lookControls, healthTimer, destroyed = false, gatewayOk = false, healthPending = false;
let healthWorker, healthWorkerFailed = false;
const healthProbes = [];
let healthSuccesses = 0, healthFailures = 0, healthLastSuccessAt = null;
let resolveReady, rejectReady;
const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
ready.catch(() => {}); // Diagnostics/UI retain boot failures; consumer still sees rejection.

let demoContext = null, demoAnalyser = null, demoSamples = null, demoSource = null;
let demoStartedAt = 0, demoDuration = 0, demoCues = [], demoPlaying = false;
let currentEmotion = { name: 'happy', intensity: 1 };
let lastPresentationJob = null;
let liveMarket, programClient, liveTitles, programState, lastProgramLook = '', lastProgramScene = '';
let playerOptions = null, resumeAfterDemo = null;

function setEmotion(name, intensity = .35) {
  if (!Number.isFinite(intensity)) return false;
  const normalized = normalizeEmotionName(name);
  currentEmotion = { name: normalized, intensity: Math.max(0, Math.min(1, intensity)) };
  if ($('studio-emotion')) $('studio-emotion').value = normalized;
  if ($('emotion-intensity')) $('emotion-intensity').value = currentEmotion.intensity;
  if ($('emotion-strength')) $('emotion-strength').textContent = Math.round(currentEmotion.intensity * 100) + '%';
  scene?.avatarRig?.setEmotion(normalized, currentEmotion.intensity);
  return true;
}

function applyPresentation(state) {
  if (state.phase !== 'playing' || !state.currentJob || state.currentJob === lastPresentationJob) return;
  lastPresentationJob = state.currentJob;
  if (state.presentation?.action === 'home') scene?.returnHome();
  else if (state.presentation?.action === 'monitor') scene?.presentMonitor(state.presentation.monitor);
}

function stopDemoVoice() {
  demoPlaying = false;
  document.body.classList.remove('speech-active');
  if (demoSource) {
    demoSource.onended = null;
    try { demoSource.stop(); } catch {}
    demoSource.disconnect();
    demoSource = null;
  }
  const idleState = {
    phase: 'idle', connected: player?.state?.connected ?? false, currentJob: null,
    text: '', elapsed: 0, duration: 0, amplitude: 0, mouthCue: 'X', lipSync: 'none',
    emotion: currentEmotion
  };
  scene?.setSpeech(idleState);
  monitors?.setSpeech(idleState);
  const btn = $('studio-audio-test');
  if (btn) {
    btn.textContent = '▶ TEST VOCE & LIP-SYNC';
    btn.classList.remove('playing');
  }
  const resume = resumeAfterDemo; resumeAfterDemo = null;
  if (resume && !destroyed) void player.connect(resume).catch(() => {});
}

async function playDemoVoice(customEmotion = null) {
  if (demoPlaying) { stopDemoVoice(); return; }
  await ready;
  if (player?.state.connected) {
    $('notice').textContent = 'Il test voce è disponibile nell’anteprima; la trasmissione ha già il proprio player audio.';
    return;
  }
  const btn = $('studio-audio-test');
  if (btn) btn.disabled = true;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('Web Audio non disponibile');
    demoContext ||= new AudioCtx({ latencyHint: 'playback' });
    await demoContext.resume();

    const [wav, timeline] = await Promise.all([
      fetch('/assets/air3/demo/voice-reference.wav').then(r => {
        if (!r.ok) throw new Error('Traccia audio reference non trovata');
        return r.arrayBuffer();
      }),
      fetch('/assets/air3/demo/voice-reference.json').then(r => r.json())
    ]);

    const buffer = await demoContext.decodeAudioData(wav);
    demoCues = normalizeMouthCues(timeline.mouthCues, buffer.duration);
    demoDuration = buffer.duration;

    if (!demoAnalyser) {
      demoAnalyser = demoContext.createAnalyser();
      demoAnalyser.fftSize = 512;
      demoAnalyser.connect(demoContext.destination);
      demoSamples = new Float32Array(512);
    }

    demoSource = demoContext.createBufferSource();
    demoSource.buffer = buffer;
    demoSource.connect(demoAnalyser);
    demoStartedAt = demoContext.currentTime + .04;
    demoPlaying = true;

    if (customEmotion) {
      if (typeof customEmotion === 'string') setEmotion(customEmotion, currentEmotion.intensity);
      else setEmotion(customEmotion.name || currentEmotion.name, customEmotion.intensity ?? currentEmotion.intensity);
    } else if ($('studio-emotion')) {
      setEmotion($('studio-emotion').value, Number($('emotion-intensity').value));
    }

    demoSource.onended = stopDemoVoice;
    demoSource.start(demoStartedAt);

    if (btn) {
      btn.textContent = '⏹ FERMA AUDIO';
      btn.classList.add('playing');
    }
    $('speech-title').textContent = 'Voice on air (Test)';
    $('subtitle').textContent = 'Prova della voce della presentatrice';
  } catch (err) {
    stopDemoVoice();
    if ($('notice')) $('notice').textContent = `Errore riproduzione voce test: ${err.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

window.air3Studio = Object.freeze({
  ready,
  async armAudio() { await ready; return player.armAudio(); },
  async connectPlayer(options) { await ready; playerOptions = { ...options }; return player.connect(options); },
  async disconnectPlayer() { resumeAfterDemo = null; playerOptions = null; if (player) await player.disconnect(); },
  setCamera(mode, immediate = false) { scene?.setCamera(mode, immediate); },
  setEmotion,
  setEyeContact(enabled) { scene?.avatarRig?.setEyeContactEnabled(enabled); if ($('eye-contact')) $('eye-contact').checked = !!enabled; },
  presentMonitor(id) { return scene?.presentMonitor(id) ?? false; },
  returnHome() { return scene?.returnHome() ?? false; },
  enableRoaming(enabled) { scene?.enableRoaming(enabled); if ($('stage-auto')) $('stage-auto').checked = !!enabled; },
  async playDemoVoice(options = {}) { return playDemoVoice(options); },
  async playLiveTestVoice() {
    await ready;
    if (player.state.currentJob || demoPlaying) throw new Error('Una lettura è già in corso');
    const resume = playerOptions;
    await player.disconnect({ keepAudio: true });
    resumeAfterDemo = resume;
    await playDemoVoice();
    if (!demoPlaying && resumeAfterDemo) stopDemoVoice();
  },
  stopDemoVoice() { stopDemoVoice(); },
  captureFrame() { return scene?.captureFrame(); },
  getLookPreset() { return scene?.look?.getPreset(); },
  async setLookPreset(value, options) { await ready; return scene.look.apply(value, options); },
  setLighting(value) { return scene?.look?.setLighting(value); },
  async setHair(style, color) { await ready; return scene.look.setHair(style, color); },
  async setFootwear(style, fit) { await ready; return scene.look.setFootwear(style, fit); },
  async setClothing(style) { await ready; return scene.look.setClothing(style); },
  diagnostics() {
    const render = scene?.diagnostics() ?? { frameCount: 0, lastRenderedFrameAt: 0, gpuRenderer: null };
    const audio = player?.diagnostics() ?? { phase: 'booting', audioState: 'not-created', currentJob: null };
    return { ready: !!scene?.frameCount, ...render, audioState: audio.audioState, currentJob: audio.currentJob,
      speech: demoPlaying ? { phase: 'playing', lipSync: 'rhubarb:pocketSphinx', elapsed: demoContext ? demoContext.currentTime - demoStartedAt : 0, duration: demoDuration, emotion: currentEmotion } : audio,
      gatewayConnected: gatewayOk,
      health: { pending: healthPending, workerFailed: healthWorkerFailed,
        successes: healthSuccesses, failures: healthFailures, lastSuccessAt: healthLastSuccessAt,
        probes: healthProbes.map(probe => ({ ...probe })) },
      data: market ? { mode: market.state.mode, websocket: market.state.connection, snapshotAt: market.state.fetchedAt,
        chartAt: market.state.chartAt, reportAt: market.state.reportAt, stale: isStale(market.state.fetchedAt) } : liveMarket?.state() || null,
      liveProgram: programState ? { revision: programState.revision, titles: programState.titles } : null };
  },
});

if (params.get('inspect') === '1') window.air3StudioInspector = Object.freeze({
  async advance(seconds) { await ready; return scene.advanceForInspection(seconds); },
  resume() { if (scene) scene.inspectionPaused = false; },
  setFacialPreview(value) { scene?.avatarRig?.setFacialPreview(value); },
  clearFacialPreview() { scene?.avatarRig?.clearFacialPreview(); },
  bones() { return scene?.avatarRig ? Object.fromEntries([...scene.avatarRig.bodyBones]
    .filter(([name]) => ['head', 'pelvis', 'hand_l', 'hand_r', 'foot_l', 'foot_r'].includes(name))
    .map(([name, bone]) => [name, bone.matrixWorld.elements.slice(12, 15)])) : {}; },
});

function updateOutputLink() {
  const query = new URLSearchParams({ output: '1', feed: $('feed').value, timeframe: $('timeframe').value });
  const quality = params.get('quality') || config?.renderQuality;
  if (quality && quality !== 'auto') query.set('quality', quality);
  const camera = $('camera').value; if (camera !== 'auto') query.set('camera', camera);
  $('output-link').href = `/studio?${query}`;
}

function updateMarket(state) {
  monitors.setMarket(state);
  const fresh = !isStale(state.fetchedAt);
  $('data-led').classList.toggle('fresh', fresh);
  $('feed-state').textContent = `${FEEDS[state.mode].label.toUpperCase()} · ${fresh ? 'DATA RECEIVED' : 'DATA UNKNOWN / STALE'}`;
  $('data-stat').textContent = state.connection === 'disabled' ? 'NOT CONFIGURED' : `${FEEDS[state.mode].label.toUpperCase()} / ${state.connection.toUpperCase()}`;
  $('data-detail').textContent = state.connection === 'disabled' ? 'Set DAPP_BASE_URL in the gateway environment.' : `Snapshot ${ageLabel(state.fetchedAt)} · OHLCV ${ageLabel(state.chartAt)}`;
  $('market-age').textContent = fresh ? `PUBLIC DATA · SNAPSHOT ${ageLabel(state.fetchedAt).toUpperCase()} · UTC` : 'FINANCIAL DATA UNKNOWN / STALE';
  $('next-trade').disabled = state.trades.length < 2;
  $('notice').textContent = state.error || state.chartError || '';
}

function updateLiveMarket(snapshot) {
  monitors.setLiveMarketSnapshot(snapshot);
  const fresh = !snapshot.connection.stale && !snapshot.demo;
  $('data-led').classList.toggle('fresh', fresh);
  const source = snapshot.demo ? 'DEMO · DATI SIMULATI' : snapshot.provider === 'coinglass' ? 'COINGLASS · MODEL3' : 'MERCATO · LIQUIDAZIONI OSSERVATE';
  $('feed-state').textContent = source;
  $('data-stat').textContent = `${source} / ${snapshot.connection.status}`;
  $('data-detail').textContent = snapshot.connection.error || snapshot.heatmap.coverage || '';
  $('market-age').textContent = snapshot.demo ? 'DEMO GRAFICA · NON DATI REALI' : snapshot.connection.stale ? 'FONTE DATI NON AGGIORNATA' : `${snapshot.config.symbol} · AGGIORNAMENTO ${ageLabel(snapshot.heatmap.updatedAt || snapshot.generatedAt).toUpperCase()}`;
  $('next-trade').disabled = true;
}

async function applyProgram(state) {
  if (destroyed) return; programState = state;
  liveTitles?.update(state.titles);
  const lookKey = JSON.stringify(state.look), sceneKey = JSON.stringify(state.scene);
  if (lookKey !== lastProgramLook && scene?.look) {
    await scene.look.apply(state.look, { persist: false, source: 'live-control' }); lastProgramLook = lookKey;
  }
  if (sceneKey !== lastProgramScene && scene?.avatarRig) {
    scene.setCamera(state.scene.camera); $('camera').value = state.scene.camera;
    setEmotion(state.scene.emotion, state.scene.intensity);
    scene.avatarRig.setEyeContactEnabled(state.scene.eyeContact); $('eye-contact').checked = state.scene.eyeContact;
    scene.enableRoaming(state.scene.roaming); $('stage-auto').checked = state.scene.roaming;
    lastProgramScene = sceneKey;
  }
}

function updateSpeech(state) {
  if (state.connected && demoPlaying) stopDemoVoice();
  if ($('studio-audio-test')) $('studio-audio-test').disabled = !!state.connected;
  applyPresentation(state);
  monitors?.setSpeech(state);
  market?.setPaused(state.phase === 'playing');
  scene?.setSpeech({ ...state, emotion: resolvePresenterEmotion(state, currentEmotion) });
  $('mode-badge').classList.toggle('active', state.connected);
  $('mode-badge').textContent = state.connected ? 'BROADCAST PLAYER' : 'MUTED OBSERVER';
  $('audio-stat').textContent = state.connected ? `${state.phase.toUpperCase()} / ${state.audioState.toUpperCase()}` : 'MUTED OBSERVER';
  $('audio-detail').textContent = state.error || (state.currentJob ? `Job ${state.currentJob}` : state.connected ? 'Single voice · server lease · audio clock' : 'No narration claims are made by this preview.');
  $('speech-title').textContent = state.phase === 'playing' ? 'Voice on air' : state.phase === 'decoding' ? 'Preparing narration' : state.connected ? 'Narration ready' : 'Muted preview';
  $('subtitle').textContent = state.text || (state.connected ? 'Waiting for the next authorized narration.' : 'This observer does not claim or play narration jobs.');
  document.body.classList.toggle('speech-active', state.phase === 'playing');
}

function health() {
  if (destroyed || healthPending || healthWorkerFailed) return;
  if (!healthWorker) {
    healthWorker = new Worker('/studio/build/health.js', { type: 'module' });
    healthWorker.onmessage = ({ data }) => {
      if (data?.type !== 'health' || destroyed) return;
      healthPending = false; gatewayOk = data.ok === true;
      healthProbes.push({ probeId: data.probeId, startedAt: data.startedAt, checkedAt: data.checkedAt,
        elapsedMs: data.elapsedMs, ok: gatewayOk, errorName: data.errorName, errorCode: data.errorCode });
      if (healthProbes.length > 128) healthProbes.shift();
      if (gatewayOk) { healthSuccesses++; healthLastSuccessAt = data.checkedAt; } else healthFailures++;
      $('gateway-status').textContent = gatewayOk ? 'GATEWAY CONNECTED' : 'GATEWAY UNREACHABLE';
    };
    healthWorker.onerror = () => {
      healthWorkerFailed = true; healthPending = false; gatewayOk = false;
      if (!destroyed) $('gateway-status').textContent = 'GATEWAY CHECK UNAVAILABLE';
    };
  }
  healthPending = true; healthWorker.postMessage({ type: 'probe' });
}

function tick() {
  if (destroyed) return;
  const clock = new Date().toLocaleTimeString('en-GB', { timeZone: 'UTC', hour12: false });
  $('clock').textContent = `${clock} UTC`; $('program-clock').textContent = `${clock} UTC`;
  if (market) updateMarket(market.state);
  if (scene) {
    const d = scene.diagnostics();
    $('render-stat').textContent = `${d.fps.toFixed(1)} FPS · ${d.width} × ${d.height}`;
    $('gpu-stat').textContent = d.gpuRenderer;
    $('avatar-stat').textContent = scene.mannequin ? 'CALIBRATION MODEL' : 'CONFIGURED GLB';
    const motion = d.stageMotion;
    if ($('stage-state')) $('stage-state').textContent = motion ? ({ home: 'Postazione principale', walking: 'In cammino', turning: 'Orientamento', presenting: 'Presentazione del monitor', settling: 'Arrivo', idle: 'In postazione' }[motion.phase] || motion.phase) : 'Preparazione della presentatrice';
    $('avatar-label').textContent = scene.mannequin ? 'CALIBRATION MANNEQUIN · ORIGINAL AVATAR NOT CONFIGURED' : scene.avatarStatus.toUpperCase();
    $('avatar-label').classList.toggle('loaded', !scene.mannequin);
    $('avatar-detail').textContent = scene.avatarStatus.includes('failed') ? scene.avatarStatus : scene.avatarRig ? 'Retargeted body · PBR materials · facial rig · audio-clock articulation.' : 'Configure an avatar to enable facial controls.';
    $('lip-label').textContent = player.state.phase === 'playing' ? (player.state.lipSync.startsWith('rhubarb:') ? 'AUDIO-ALIGNED LIP SYNC' : 'AUDIO AMPLITUDE FALLBACK') : 'AUTONOMOUS MARKET STUDIO';
  }
  tickTimer = setTimeout(tick, 1000);
}

function sample() {
  if (destroyed) return;
  if (demoPlaying && demoContext && demoAnalyser) {
    const elapsed = demoContext.currentTime - demoStartedAt;
    demoAnalyser.getFloatTimeDomainData(demoSamples);
    let energy = 0;
    for (const s of demoSamples) energy += s * s;
    const mouthCue = mouthCueAt(demoCues, elapsed, demoDuration);
    const speechState = {
      phase: 'playing',
      connected: true,
      currentJob: 'test-voice',
      text: 'Prova della voce della presentatrice',
      elapsed: Math.max(0, elapsed),
      duration: demoDuration,
      amplitude: Math.min(1, Math.sqrt(energy / demoSamples.length) * 8),
      mouthCue,
      mouthWeights: mouthPoseWeightsAt(demoCues, elapsed, demoDuration),
      lipSync: 'rhubarb:pocketSphinx',
      emotion: currentEmotion
    };
    scene?.setSpeech(speechState);
    monitors?.setSpeech(speechState);
    document.body.classList.add('speech-active');
    $('speech-progress').textContent = `${elapsed.toFixed(1)} / ${demoDuration.toFixed(1)}s [${mouthCue}]`;
    $('lip-label').textContent = `AUDIO-ALIGNED LIP SYNC [${mouthCue}] · ${currentEmotion.name.toUpperCase()}`;
    $('audio-stat').textContent = 'PLAYING / RUNNING (TEST)';
    $('audio-detail').textContent = `Forma labiale ${mouthCue} · Espressione ${currentEmotion.name}`;
  } else {
    const state = player?.sample();
    if (state) {
      applyPresentation(state);
      scene?.setSpeech({ ...state, emotion: resolvePresenterEmotion(state, currentEmotion) });
      $('speech-progress').textContent = state.phase === 'playing' ? `${state.elapsed.toFixed(1)} / ${state.duration.toFixed(1)}s` : '—';
    }
  }
  sampleRaf = requestAnimationFrame(sample);
}

function disposeApp() {
  if (destroyed) return; destroyed = true;
  stopDemoVoice(); clearTimeout(tickTimer); clearInterval(healthTimer); cancelAnimationFrame(sampleRaf);
  healthWorker?.terminate(); lookControls?.dispose(); market?.stop(); liveMarket?.stop(); programClient?.stop(); liveTitles?.dispose();
  Promise.resolve(player?.disconnect()).catch(() => {});
  scene?.dispose(); monitors?.dispose(); demoContext?.close().catch(() => {});
}
window.addEventListener('pagehide', disposeApp, { once: true });

async function boot() {
  try {
    config = await fetchJson('/api/public-config');
    const initialLook = await loadInitialLook();
    if (config.live) {
      programState = await fetchJson('/api/live/program'); initialLook.preset = programState.look; initialLook.source = 'live-control';
      document.body.classList.add('live-program');
    }
    if (destroyed) throw new Error('Studio closed during initialization');
    config.lookPreset = initialLook.preset; config.lookShipped = initialLook.shipped; config.lookSource = initialLook.source;
    $('feed').value = params.get('feed') === 'auto' ? 'auto' : 'track';
    const requestedTimeframe = params.get('timeframe');
    if ([...$('timeframe').options].some((o) => o.value === requestedTimeframe)) config.defaultTimeframe = requestedTimeframe;
    $('timeframe').value = config.defaultTimeframe || '1h';
    monitors = new StudioMonitors((id) => scene?.dirty(id));
    scene = new StudioScene($('viewport'), monitors, config, (message) => { $('avatar-detail').textContent = message; });
    const cameraMode = params.get('camera');
    if (['wide', 'presenter', 'screens'].includes(cameraMode)) { scene.setCamera(cameraMode, true); $('camera').value = cameraMode; }
    $('quality').value = params.get('quality') || config.renderQuality || 'auto';
    $('quality').addEventListener('change', () => { const url = new URL(location.href); url.searchParams.set('quality', $('quality').value); location.href = url.href; });
    player = new SpeechPlayer(updateSpeech);
    if (config.live) {
      liveMarket = createLiveMarketClient({ onUpdate: updateLiveMarket });
      liveTitles = mountLiveTitles(document.querySelector('.program'));
      $('feed').disabled = true; $('timeframe').disabled = true;
      $('feed').replaceChildren(new Option('Monitor della regia live', 'live', true, true));
    } else market = new MarketData(config, updateMarket);
    $('feed').addEventListener('change', () => {
      market?.start($('feed').value); updateOutputLink();
      const url = new URL(location.href); url.searchParams.set('feed', $('feed').value); history.replaceState(null, '', url);
    });
    $('timeframe').addEventListener('change', () => { market?.setTimeframe($('timeframe').value); updateOutputLink(); });
    $('camera').addEventListener('change', () => { scene.setCamera($('camera').value); updateOutputLink(); });
    $('next-trade').addEventListener('click', () => market?.advance());
    $('refresh').addEventListener('click', () => { market?.refreshTrades(); market?.refreshReports(); market?.refreshChart(); liveMarket?.refresh(); health(); });
    $('studio-audio-test')?.addEventListener('click', () => playDemoVoice());
    $('studio-emotion')?.addEventListener('change', () => setEmotion($('studio-emotion').value, Number($('emotion-intensity').value)));
    $('emotion-intensity')?.addEventListener('input', () => setEmotion($('studio-emotion').value, Number($('emotion-intensity').value)));
    $('eye-contact')?.addEventListener('change', () => scene.avatarRig?.setEyeContactEnabled($('eye-contact').checked));
    $('stage-present')?.addEventListener('click', () => scene.presentMonitor($('stage-target').value));
    $('stage-home')?.addEventListener('click', () => scene.returnHome());
    $('stage-auto')?.addEventListener('change', () => scene.enableRoaming($('stage-auto').checked));
    updateSpeech(player.state); market?.start($('feed').value); liveMarket?.start(); updateOutputLink();
    await scene.firstFrame;
    await scene.avatarReady;
    if (destroyed) throw new Error('Studio closed during initialization');
    if (scene.look) lookControls = mountLookControls($('look-panel'), scene.look, { drawer: true });
    setEmotion($('studio-emotion').value, Number($('emotion-intensity').value));
    if (config.live) {
      await applyProgram(programState);
      programClient = createProgramClient({ onUpdate: applyProgram }); programClient.start();
      $('live-regia-link').hidden = false; $('save-live-look').hidden = false;
      $('save-live-look').addEventListener('click', async () => {
        const button = $('save-live-look'); button.disabled = true;
        try {
          const response = await fetch('/api/live/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ look: scene.look.getPreset() }) });
          if (!response.ok) throw new Error('Apri la regia live ed esegui l’accesso prima di salvare il look.');
          $('notice').textContent = 'Look salvato nella regia e applicato all’uscita.';
        } catch (error) { $('notice').textContent = error.message; } finally { button.disabled = false; }
      });
    }
    if (scene.stageMotion) for (const id of ['stage-present', 'stage-home', 'stage-auto']) $(id).disabled = false;
    if (params.get('roam') === '1') { scene.enableRoaming(true); $('stage-auto').checked = true; }
    $('loading').hidden = true;
    resolveReady({ renderer: 'three.js/WebGL', avatar: scene.avatarStatus });
    tick(); sample(); health();
    healthTimer = setInterval(health, 10_000);
  } catch (error) {
    if (destroyed) { rejectReady(error); return; }
    $('loading').hidden = false;
    $('loading').querySelector('strong').textContent = 'STUDIO COULD NOT START';
    $('loading').querySelector('p').textContent = error.message;
    $('notice').textContent = `Startup failed: ${error.message}`;
    rejectReady(error); disposeApp();
  }
}
boot();
