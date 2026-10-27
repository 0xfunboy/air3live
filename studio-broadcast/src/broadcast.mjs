import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { loadBroadcastConfig, serviceRoot } from './config.mjs';
import { encoderArgs, selectEncoder, redactValue, softwareRenderer } from './encoder.mjs';
import { attachStdinControl } from './lifecycle.mjs';

const config = loadBroadcastConfig();
const secrets = [config.outputUrl, process.env.AIR3_RTMP_KEY, config.gateway.producerToken,
  config.gateway.playerToken, config.gateway.tts.apiKey];
const log = (event, data = {}) => console.log(JSON.stringify(redactValue({ at: new Date().toISOString(), event, ...data }, secrets)));
const controller = new AbortController();
let controlPage = null;
let previewRequestedUntil = 0;
const ipcEnabled = process.env.AIR3_LIVE_IPC === 'true' && typeof process.send === 'function';
if (ipcEnabled) {
  process.on('disconnect', () => controller.abort());
  process.on('message', async message => {
    if (message?.type === 'stop') { controller.abort(); return; }
    if (message?.type === 'preview-request') { previewRequestedUntil = Date.now() + 15_000; return; }
    if (message?.type !== 'command' || typeof message.id !== 'string' || message.id.length > 100) return;
    const reply = result => { if (process.connected) process.send({ type: 'command-result', id: message.id, ...result }, () => {}); };
    if (!controlPage || controlPage.isClosed() || controller.signal.aborted) { reply({ ok: false, error: 'RENDERER_NOT_READY' }); return; }
    try {
      const action = message.action;
      if (!action || !['monitor', 'home', 'test-voice', 'stop-test-voice'].includes(action.type) ||
          (action.type === 'monitor' && !['left', 'center', 'right'].includes(action.monitor))) throw new Error('Invalid action');
      const accepted = await bounded(controlPage.evaluate(async action => {
        if (action.type === 'monitor') return window.air3Studio.presentMonitor(action.monitor);
        if (action.type === 'home') return window.air3Studio.returnHome();
        if (action.type === 'test-voice') { await window.air3Studio.playLiveTestVoice(); return true; }
        window.air3Studio.stopDemoVoice(); return true;
      }, action), 12_000, 'Renderer command timed out');
      reply({ ok: accepted !== false, error: accepted === false ? 'STAGE_BUSY' : undefined });
    } catch { reply({ ok: false, error: 'COMMAND_FAILED' }); }
  });
}
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
const detachStdin = attachStdinControl(process.stdin, controller, { supervised: config.controlStdin });
if (config.durationSeconds) setTimeout(() => controller.abort(), config.durationSeconds * 1000).unref();
const source = await readFile(resolve(serviceRoot, 'node_modules/puppeteer-stream/dist/PuppeteerStream.js'), 'utf8');
if (!source.includes('new ws_1.WebSocketServer({ host: "127.0.0.1", port: i })')) throw new Error('Capture transport is not restricted to loopback; run npm run capture:patch');
if (source.split('AIR3 capture mutex cleanup').length !== 3) throw new Error('Capture retry cleanup is missing; run npm run capture:patch');
const encoder = await selectEncoder(config);
log('encoder-selected', { encoder, requested: config.encoder, hardware: ['h264_nvenc', 'h264_qsv'].includes(encoder) });
const capture = await import('puppeteer-stream');

async function bounded(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  })]); } finally { clearTimeout(timer); }
}
function renderSummary(d) {
  return { gpuRenderer: d.gpuRenderer, frameCount: d.frameCount, fps: d.fps,
    width: d.width, height: d.height, audioState: d.audioState, currentJob: d.currentJob,
    quality: d.quality?.name, avatar: d.avatar, avatarRig: d.avatarRig,
    stageMotion: d.stageMotion, effectiveCamera: d.effectiveCamera, hair: d.hair,
    footwear: d.footwear, clothing: d.clothing, branding: d.branding, lighting: d.lighting, look: d.look,
    environment: d.environment, reflections: d.reflections, postprocessing: d.postprocessing,
    lipSync: d.speech?.lipSync };
}

async function session(signal) {
  let browser, page, media, ffmpeg, watchdog;
  let progressText = '', progress = {}, previewAt = 0;
  let failed;
  let lastFrameCount = -1;
  let lastFrameAt = Date.now();
  let lastMediaAt = Date.now();
  let checking = false;
  let lastSpeechState = '';
  const playerId = 'broadcaster-' + randomUUID();
  const destination = config.mode === 'file'
    ? resolve(config.recordingDir, `studio-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.mkv`)
    : config.outputUrl;
  if (config.mode === 'file') await mkdir(config.recordingDir, { recursive: true });
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const fail = (error) => { if (!failed) failed = error; resolveDone(); };
  const onAbort = () => resolveDone();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const args = ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--hide-scrollbars'];
    if (config.angle !== 'default') args.push(`--use-angle=${config.angle}`);
    if (config.angle === 'vulkan') args.push('--enable-features=Vulkan', '--enable-gpu');
    if (config.angle === 'swiftshader') args.push('--enable-unsafe-swiftshader');
    if (config.noSandbox) args.push('--no-sandbox');
    browser = await capture.launch({ executablePath: config.browserPath, headless: 'new', args,
      defaultViewport: { width: config.gateway.width, height: config.gateway.height, deviceScaleFactor: 1 },
      timeout: 45000, protocolTimeout: 45000, startDelay: 1000 });
    browser.once('disconnected', () => { if (!signal.aborted) fail(new Error('Browser disconnected')); });
    page = await browser.newPage();
    page.on('pageerror', (error) => log('studio-page-error', { message: error.message.slice(0, 500) }));
    page.on('console', message => { if (message.type() === 'error') log('studio-console-error', { message: message.text().slice(0, 1500) }); });
    page.on('error', () => fail(new Error('Studio page crashed')));
    await page.goto(config.studioUrl, { waitUntil: 'networkidle0', timeout: 45000 });
    await page.waitForFunction(() => Boolean(window.air3Studio?.ready), { timeout: 30000 });
    await bounded(page.evaluate(() => window.air3Studio.ready), 30000, 'Studio readiness timed out');
    await bounded(page.evaluate(() => window.air3Studio.armAudio()), 10000, 'Studio audio initialization timed out');
    const diagnostics = await page.evaluate(() => window.air3Studio.diagnostics());
    const software = softwareRenderer(diagnostics);
    log('renderer-ready', { diagnostics: renderSummary(diagnostics), software });
    if (config.requireHardware && software) throw new Error('Hardware WebGL rendering was required but not verified');
    if (signal.aborted) return;
    media = await bounded(capture.getStream(page, { audio: true, video: true, mimeType: 'video/webm;codecs=vp8,opus',
      audioBitsPerSecond: 128000, videoBitsPerSecond: config.captureBitrateKbps * 1000,
      frameSize: 200, streamConfig: { highWaterMarkMB: 2 },
      videoConstraints: { mandatory: { minWidth: config.gateway.width, maxWidth: config.gateway.width,
        minHeight: config.gateway.height, maxHeight: config.gateway.height, maxFrameRate: config.gateway.fps } },
      audioConstraints: { mandatory: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } },
    }), 30000, 'Browser capture startup timed out');
    const argsOut = encoderArgs(config, encoder, destination);
    if (ipcEnabled) argsOut.unshift('-progress', 'pipe:3', '-stats_period', '2');
    ffmpeg = spawn(config.ffmpeg, argsOut, { stdio: ipcEnabled ? ['pipe', 'ignore', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe'] });
    if (ipcEnabled) ffmpeg.stdio[3].on('data', data => {
      progressText = (progressText + String(data)).slice(-64_000);
      let at; while ((at = progressText.indexOf('\n')) >= 0) {
        const line = progressText.slice(0, at).trim(); progressText = progressText.slice(at + 1);
        const equals = line.indexOf('='); if (equals < 1) continue;
        progress[line.slice(0, equals)] = line.slice(equals + 1);
        if (line.startsWith('progress=')) {
          log('encoder-progress', { frame: Number(progress.frame) || 0, fps: Number(progress.fps) || 0,
            seconds: (Number(progress.out_time_us) || 0) / 1e6, bitrate: progress.bitrate || null,
            speed: progress.speed || null, bytes: Number(progress.total_size) || 0 }); progress = {};
        }
      }
    });
    ffmpeg.once('error', () => fail(new Error('FFmpeg process could not start')));
    ffmpeg.once('exit', (code) => { if (!signal.aborted) fail(new Error(`FFmpeg exited (${code})`)); });
    ffmpeg.stdin.on('error', () => fail(new Error('Encoder input closed')));
    ffmpeg.stderr.on('data', (data) => log('encoder-message', { message: String(data).trim().slice(0, 1500) }));
    media.on('error', () => fail(new Error('Capture stream error')));
    media.on('data', () => { lastMediaAt = Date.now(); });
    media.pipe(ffmpeg.stdin);
    await bounded(page.evaluate(({ token, playerId }) => window.air3Studio.connectPlayer({ token, playerId }),
      { token: config.gateway.playerToken, playerId }), 10000, 'Studio player connection timed out');
    log('broadcast-running', { mode: config.mode, recording: config.mode === 'file' ? destination : undefined,
      width: config.gateway.width, height: config.gateway.height, fps: config.gateway.fps, encoder });
    controlPage = page;
    // Startup includes loading/compiling the avatar. The live watchdog measures
    // from the start of capture, not from before that potentially long setup.
    lastMediaAt = Date.now(); lastFrameAt = Date.now(); lastFrameCount = diagnostics.frameCount ?? 0;
    watchdog = setInterval(async () => {
      if (checking || signal.aborted) return;
      checking = true;
      try {
        const buffered = media.readableLength + media.writableLength + ffmpeg.stdin.writableLength;
        if (buffered > config.maxBufferBytes) throw new Error('Capture backpressure exceeded the bounded buffer limit');
        const d = await bounded(page.evaluate(() => window.air3Studio.diagnostics()), 8000, 'Renderer diagnostics timed out');
        if (ipcEnabled) {
          log('renderer-metrics', { fps: d.fps, gpuRenderer: d.gpuRenderer });
          if (Date.now() < previewRequestedUntil && Date.now() - previewAt > 5000 && process.connected) {
            previewAt = Date.now();
            const jpeg = await bounded(page.screenshot({ type: 'jpeg', quality: 55, encoding: 'base64' }), 8000, 'Preview capture timed out');
            if (jpeg.length < 1_500_000 && process.connected) process.send({ type: 'preview', jpeg }, () => {});
          }
        }
        const speechState = `${d.currentJob || ''}:${d.speech?.phase}:${d.speech?.lipSync}`;
        if (speechState !== lastSpeechState) {
          lastSpeechState = speechState;
          log('speech-playback', { job: d.currentJob, phase: d.speech?.phase, lipSync: d.speech?.lipSync,
            elapsed: d.speech?.elapsed, duration: d.speech?.duration, mouthCue: d.speech?.mouthCue,
            expression: d.avatarRig?.facialLipSync?.emotion, expressionIntensity: d.avatarRig?.facialLipSync?.emotionIntensity });
        }
        const frames = d.frameCount ?? d.renderedFrames ?? d.frames ?? 0;
        if (frames > lastFrameCount) { lastFrameCount = frames; lastFrameAt = Date.now(); }
        if (Date.now() - lastFrameAt > 15000 || Date.now() - lastMediaAt > 15000) throw new Error('Frame/capture watchdog timed out');
      } catch (e) { fail(e); }
      finally { checking = false; }
    }, 2000);
    if (signal.aborted) resolveDone();
    await done;
  } finally {
    if (controlPage === page) controlPage = null;
    clearInterval(watchdog);
    signal.removeEventListener('abort', onAbort);
    if (page && !page.isClosed()) {
      try { log('renderer-final', { diagnostics: renderSummary(await bounded(
        page.evaluate(() => window.air3Studio?.diagnostics()), 2000, 'Final diagnostics timed out')) }); } catch {}
    }
    if (page && !page.isClosed()) await Promise.race([
      page.evaluate(() => window.air3Studio?.disconnectPlayer()), sleep(2000),
    ]).catch(() => {});
    if (media) {
      // stop() only asks MediaRecorder to stop; its final dataavailable event and
      // WebSocket close arrive afterwards. Keep the pipe until readable EOF.
      let onDrained;
      const drained = media.readableEnded || media.destroyed ? Promise.resolve() : new Promise((resolve) => {
        onDrained = resolve; media.once('end', resolve); media.once('close', resolve);
      });
      await Promise.race([media.stop(), sleep(1500)]).catch(() => {});
      await bounded(drained, 4000, 'Capture final chunk timed out').catch((error) => log('capture-drain-timeout', { message: error.message }));
      if (onDrained) { media.off('end', onDrained); media.off('close', onDrained); }
      media.unpipe(); media.destroy();
    }
    if (ffmpeg) {
      if (!ffmpeg.stdin.writableEnded && !ffmpeg.stdin.destroyed) ffmpeg.stdin.end();
      if (ffmpeg.exitCode === null) await Promise.race([new Promise(r => ffmpeg.once('exit', r)), sleep(4000)]);
      if (ffmpeg.exitCode === null) { ffmpeg.kill('SIGTERM'); await sleep(1000); }
      if (ffmpeg.exitCode === null) ffmpeg.kill('SIGKILL');
    }
    if (browser) {
      const proc = browser.process();
      await Promise.race([browser.close().catch(() => {}), sleep(3000)]);
      if (proc && proc.exitCode === null) proc.kill('SIGKILL');
    }
  }
  if (failed && !signal.aborted) throw failed;
}

try {
  const transport = await bounded(capture.wss, 10000, 'Capture loopback listener failed to start');
  if (!transport?.address()) throw new Error('Capture loopback listener is unavailable');
  let restarts = 0;
  while (!controller.signal.aborted) {
    try { await session(controller.signal); break; }
    catch (error) {
      log('broadcast-error', { message: error.message, attempt: restarts + 1 });
      if (controller.signal.aborted) break;
      if (restarts >= config.maxRestarts) { process.exitCode = 1; break; }
      const waitMs = Math.min(30000, 1000 * 2 ** restarts++);
      await sleep(waitMs, undefined, { signal: controller.signal }).catch(() => {});
    }
  }
} finally {
  detachStdin();
  const server = await bounded(capture.wss, 3000, 'Capture transport shutdown timed out').catch(() => null);
  if (server) {
    for (const client of server.clients) client.terminate();
    await new Promise(r => server.close(r));
  }
  log('broadcaster-stopped');
  if (ipcEnabled && process.connected) process.disconnect();
}
