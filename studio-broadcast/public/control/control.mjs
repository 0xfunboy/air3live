const $ = id => document.getElementById(id);
let settings, status, pollTimer, previewTimer, authenticated = false, polling = false, lastJob = null, lastChatKey = '', previewURL = null;
const errors = {
  OPERATOR_UNAUTHORIZED: 'Access expired or invalid operator key.', ORIGIN_NOT_ALLOWED: 'Open the control room from its configured origin.',
  PUBLIC_ORIGIN_REQUIRED: 'For remote access, configure AIR3_PUBLIC_ORIGIN on the server.',
  STREAM_DESTINATION_REQUIRED: 'Please enter and save the server URL and stream key before going live.',
  BROWSER_NOT_INSTALLED: 'Install the capture browser using npm run browser:install --prefix studio-broadcast.',
  FFMPEG_NOT_AVAILABLE: 'FFmpeg is not available in PATH. Please install FFmpeg and restart.',
  ENCODER_PROBE_FAILED: 'The selected encoder failed preflight check. Try Automatic or check GPU drivers.',
  STOP_BEFORE_STREAM_SETTINGS: 'Stop broadcast output before changing destination, format, or encoder.',
  BROADCAST_ALREADY_ACTIVE: 'A broadcast session is already running. Stop it before starting another.',
  BROADCAST_NOT_ACTIVE: 'Start a test recording or live broadcast to control the renderer output.',
  STAGE_BUSY: 'The virtual presenter is currently transitioning. Please wait until stationary.',
  COMMAND_TIMEOUT: 'The renderer did not respond in time. Check diagnostics for details.',
  TWITCH_CONFIG_REQUIRED: 'Please provide Client ID, Client Secret, and Twitch channel.',
  INVALID_LIVE_SETTINGS: 'Invalid settings. Verify server URL, keys, and values.',
  INVALID_TICKER: 'Ticker supports up to 12 lines, up to 240 characters each.',
};
function notice(message, success = false) {
  for (const id of ['notice', 'login-notice']) {
    const el = $(id);
    if (el) { el.textContent = message; el.classList.toggle('success', success); el.hidden = !message; }
  }
}
async function api(path, { method = 'GET', body, timeout = 30000 } = {}) {
  const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  let data; try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    if (response.status === 401 && !path.endsWith('/session')) showLogin();
    const error = new Error(errors[data.error] || data.error || `Request failed (${response.status})`); error.code = data.error; throw error;
  }
  return data;
}
function bind(id, action, { submit = false } = {}) {
  $(id).addEventListener(submit ? 'submit' : 'click', async event => {
    event.preventDefault(); const element = submit ? event.submitter : $(id);
    if (element) element.disabled = true;
    try { notice(''); await action(event); } catch (error) { notice(error.message || 'Operation failed.'); }
    finally { if (element) element.disabled = false; if (status) renderStatus(status); }
  });
}
function val(id, value) { $(id).value = value ?? ''; }
function checked(id, value) { $(id).checked = !!value; }
function showLogin() { authenticated = false; clearTimeout(pollTimer); clearTimeout(previewTimer); $('login-panel').hidden = false; $('control-room').hidden = true; $('logout').hidden = true; $('connection').textContent = 'Operator Login'; }
function selectTab(name) {
  for (const button of document.querySelectorAll('[data-tab]')) {
    const on = button.dataset.tab === name; if (on) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    $('tab-' + button.dataset.tab).hidden = !on;
  }
  if (name === 'diagnostics') void loadRecordings().catch(e => notice(e.message));
}
for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => selectTab(button.dataset.tab));
function fillSettings(s) {
  settings = s;
  val('stream-provider', s.stream.provider); val('stream-server', s.stream.server); val('stream-profile', s.stream.profile);
  val('stream-bitrate', s.stream.bitrateKbps); val('stream-encoder', s.stream.encoder); val('stream-quality', s.stream.quality);
  checked('stream-auto-recovery', s.stream.autoRecovery !== false);
  val('scene-camera', s.scene.camera); val('scene-emotion', s.scene.emotion); val('scene-intensity', s.scene.intensity);
  $('scene-intensity-output').textContent = Math.round(s.scene.intensity * 100) + '%';
  checked('scene-eye', s.scene.eyeContact); checked('scene-roaming', s.scene.roaming);
  val('tts-url', s.tts.baseUrl); val('tts-model', s.tts.model); val('tts-it', s.tts.voiceIt); val('tts-en', s.tts.voiceEn); val('tts-speed', s.tts.speed);
  val('market-provider', s.market.provider); val('market-symbol', s.market.symbol); val('market-range', s.market.range); val('market-wallpanel', s.market.wallpanelSource); checked('market-enabled', s.market.enabled);
  val('chat-channel', s.twitch.channel); val('chat-client', s.twitch.clientId); checked('chat-enabled', s.twitch.enabled);
  $('stream-key-state').textContent = s.stream.hasKey ? 'Saved' : 'Not configured';
  $('twitch-redirect').textContent = s.twitch.redirectUri || location.origin + '/api/live/twitch/callback';
  $('chat-secret').placeholder = settings?.twitch.hasClientSecret ? 'Client secret saved on server' : 'Blank preserves saved secret';
  $('stream-key').placeholder = settings?.stream.hasKey ? 'Stream key saved on server' : 'Paste platform stream key';
  $('tts-key').placeholder = settings?.tts.hasApiKey ? 'TTS API Key saved on server' : 'Blank preserves saved key';
  $('twitch-test').hidden = s.stream.provider !== 'twitch';
  updateProviderForm(s.stream.provider);
}
function updateProviderForm(provider) {
  const isRestream = provider === 'restream';
  const isTwitch = provider === 'twitch';
  const serverInput = $('stream-server');
  if (isRestream) {
    if (!serverInput.value || serverInput.value.includes('twitch.tv')) serverInput.value = 'rtmps://live.restream.io/live';
    serverInput.readOnly = false;
  } else if (isTwitch) {
    if (!serverInput.value || serverInput.value.includes('restream.io')) serverInput.value = 'rtmp://live.twitch.tv/app';
    serverInput.readOnly = false;
  } else {
    serverInput.readOnly = false;
  }
}
$('stream-provider').addEventListener('change', e => {
  updateProviderForm(e.target.value);
  $('twitch-test').hidden = e.target.value !== 'twitch';
});
function fillTitles(t) {
  checked('title-enabled', t.enabled); val('title-label', t.label); val('title-main', t.title); val('title-subtitle', t.subtitle);
  val('title-ticker', t.ticker); val('title-speed', t.speed); val('title-ttl', t.ttlSeconds);
}
async function saveSettings(diff) { const s = await api('/api/live/settings', { method: 'PATCH', body: diff }); fillSettings(s); return s; }
function streamInput() {
  return { provider: $('stream-provider').value, server: $('stream-server').value.trim(), profile: $('stream-profile').value,
    bitrateKbps: Number($('stream-bitrate').value), encoder: $('stream-encoder').value, quality: $('stream-quality').value,
    autoRecovery: $('stream-auto-recovery').checked,
    twitchBandwidthTest: false, ...($('stream-key').value ? { key: $('stream-key').value.trim() } : {}) };
}
async function saveStream() { await saveSettings({ stream: streamInput() }); val('stream-key', ''); }
bind('stream-form', async () => { await saveStream(); notice('Stream destination saved.', true); }, { submit: true });
bind('scene-form', async () => {
  await saveSettings({ scene: { camera: $('scene-camera').value, emotion: $('scene-emotion').value,
    intensity: Number($('scene-intensity').value), eyeContact: $('scene-eye').checked, roaming: $('scene-roaming').checked } });
  notice('Presenter and stage direction updated.', true);
}, { submit: true });
bind('titles-form', async () => {
  await api('/api/live/titles', { method: 'POST', body: { enabled: $('title-enabled').checked, label: $('title-label').value,
    title: $('title-main').value, subtitle: $('title-subtitle').value, ticker: $('title-ticker').value,
    speed: Number($('title-speed').value), ttlSeconds: Number($('title-ttl').value) } }); notice('Titles updated on-air.', true);
}, { submit: true });
bind('titles-clear', async () => { const t = await api('/api/live/titles', { method: 'DELETE' }); fillTitles(t); notice('Titles cleared.', true); });
bind('voice-settings-form', async () => {
  await saveSettings({ tts: { baseUrl: $('tts-url').value.trim(), model: $('tts-model').value, voiceIt: $('tts-it').value,
    voiceEn: $('tts-en').value, speed: Number($('tts-speed').value), ...($('tts-key').value ? { apiKey: $('tts-key').value } : {}) } });
  val('tts-key', ''); notice('Voice settings saved. You can now queue a test narration.', true);
}, { submit: true });
bind('narration-form', async () => {
  const row = await api('/api/live/narrations', { method: 'POST', body: { text: $('narration-text').value, language: $('narration-language').value } });
  lastJob = row.id; $('narration-cancel').disabled = false; $('narration-status').textContent = 'Speech queued · ' + row.status;
}, { submit: true });
bind('narration-cancel', async () => { if (lastJob) await api('/api/live/narrations/' + encodeURIComponent(lastJob), { method: 'DELETE' }); });
bind('market-form', async () => {
  await saveSettings({ market: { enabled: $('market-enabled').checked, provider: $('market-provider').value, symbol: $('market-symbol').value,
    range: $('market-range').value, wallpanelSource: $('market-wallpanel').value, ...($('market-key').value ? { coinglassKey: $('market-key').value } : {}) } });
  val('market-key', ''); notice('Studio monitors configuration updated.', true);
}, { submit: true });
async function saveChat(forceEnabled = false) {
  await saveSettings({ twitch: { enabled: forceEnabled || $('chat-enabled').checked, channel: $('chat-channel').value,
    clientId: $('chat-client').value, ...($('chat-secret').value ? { clientSecret: $('chat-secret').value } : {}) } });
  val('chat-secret', ''); if (forceEnabled) checked('chat-enabled', true);
}
bind('chat-form', async () => { await saveChat(); notice('Chat configuration saved.', true); }, { submit: true });
bind('twitch-authorize', async () => {
  await saveChat(true); const { url } = await api('/api/live/twitch/authorize', { method: 'POST', body: {} });
  if (new URL(url).origin !== 'https://id.twitch.tv') throw new Error('Unexpected OAuth redirect URL.');
  location.assign(url);
});
bind('twitch-disconnect', async () => { await api('/api/live/twitch/disconnect', { method: 'POST', body: {} }); notice('Chat disconnected.', true); });
async function start(mode) {
  await saveStream();
  const result = await api('/api/live/start', { method: 'POST', body: { mode }, timeout: 45000 });
  renderStatus({ ...status, settings, broadcast: result }); notice(mode === 'record' ? 'Starting local recording. Waiting for encoder frames.' : 'Starting live broadcast. Monitor incoming stream on destination dashboard.', true);
}
bind('go-live', () => start('live')); bind('record', () => start('record')); bind('twitch-test', () => start('twitch-test'));
bind('stop', async () => { const result = await api('/api/live/stop', { method: 'POST', body: {}, timeout: 40000 }); renderStatus({ ...status, broadcast: result }); notice('Broadcast stopped.', true); await loadRecordings(); });
bind('preflight', async () => { await saveStream(); const r = await api('/api/live/preflight', { method: 'POST', body: { mode: 'record' }, timeout: 45000 }); notice(`Encoder preflight passed: ${r.encoder}, ${r.width} × ${r.height} at ${r.fps} fps. GPU renderer will be verified on launch.`, true); });
const command = value => api('/api/live/command', { method: 'POST', body: value });
bind('stage-present', () => command({ type: 'monitor', monitor: $('stage-target').value }));
bind('stage-home', () => command({ type: 'home' })); bind('reference-audio', () => command({ type: 'test-voice' }));
bind('quick-voice-btn', () => command({ type: 'test-voice' }));
function renderChat(chat, external = []) {
  $('chat-state').textContent = chat.error || `${chat.state || 'offline'}${chat.channel ? ' · ' + chat.channel : ''}`;
  const messages = [...(chat.messages || []), ...external].sort((a, b) => (a.receivedAt || a.timestamp || a.createdAt || 0) - (b.receivedAt || b.timestamp || b.createdAt || 0)).slice(-100);
  const key = messages.map(x => x.id || x.messageId).join('|'); if (key === lastChatKey) return; lastChatKey = key;
  const target = $('chat-messages'); target.replaceChildren();
  for (const row of messages) {
    const item = document.createElement('div'); item.className = 'chat-message';
    const author = document.createElement('strong'); author.textContent = row.author || row.displayName || row.userName || row.login || 'User';
    const provider = document.createElement('small'); provider.textContent = row.provider || 'Twitch'; author.append(provider);
    const text = document.createElement('p'); text.textContent = row.text || '';
    const title = document.createElement('button'); title.textContent = 'Promote to title';
    title.addEventListener('click', () => { val('title-main', (row.text || '').slice(0, 120)); val('title-subtitle', `From chat · ${row.author || row.displayName || row.userName || row.login || 'User'}`); checked('title-enabled', true); selectTab('titles'); $('title-main').focus(); });
    item.append(author, text, title); target.append(item);
  }
  if (!messages.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Waiting for incoming chat messages.'; target.append(p); }
  target.scrollTop = target.scrollHeight;
}
function renderStatus(s) {
  if (!s) return; status = s; if (s.settings) settings = s.settings; const b = s.broadcast;
  const active = !['stopped', 'failed'].includes(b.phase) || b.busy;
  const phases = { stopped: 'Studio Offline', starting: 'Preparing broadcast', running: b.mode === 'record' ? 'Local Recording' : b.mode === 'twitch-test' ? 'Twitch Bandwidth Test' : 'ON AIR · Live', stalled: 'Stream Stalled', reconnecting: '24/7 Auto-reconnecting', stopping: 'Stopping Broadcast', failed: 'Broadcast Halted' };
  $('phase').textContent = phases[b.phase] || b.phase;
  $('phase-dot').classList.toggle('on', b.phase === 'running'); $('phase-dot').classList.toggle('working', active && b.phase !== 'running');
  $('go-live').disabled = active; $('record').disabled = active; $('twitch-test').disabled = active;
  $('stop').disabled = !active || b.phase === 'stopping';
  $('destination-summary').textContent = b.error || `${settings?.stream.provider === 'restream' ? 'Restream' : settings?.stream.provider === 'twitch' ? 'Twitch' : 'Custom RTMP'} · ${settings?.stream.profile || ''} · ${b.encoder || settings?.stream.encoder || 'auto'}${b.mode === 'record' ? ' · local file' : ''}`;
  $('render-fps').textContent = Number.isFinite(b.renderFps) ? b.renderFps.toFixed(1) + ' fps' : '—';
  $('encode-fps').textContent = Number.isFinite(b.encodeFps) ? b.encodeFps.toFixed(1) + ' fps' : '—';
  $('output-rate').textContent = Number.isFinite(b.bitrateKbps) ? `${Math.round(b.bitrateKbps)} kbit/s` : '—';
  $('elapsed').textContent = b.elapsedFormatted || '00:00';
  $('connection').textContent = active ? 'On-Air Active' : 'Connected';
  $('preview-age').textContent = b.previewAgeMs !== null && b.previewAgeMs !== undefined ? `${(b.previewAgeMs / 1000).toFixed(1)}s ago` : 'Renderer Preview';
  $('events').textContent = (b.events || []).map(e => `[${e.at.slice(11, 19)}] ${e.type}: ${e.message}`).join('\n');
  renderChat(s.chat, s.externalChat);
}
async function loadRecordings() {
  const r = await api('/api/live/recordings');
  $('recordings').replaceChildren();
  if (!r.recordings.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'No local recordings.'; $('recordings').append(p); return; }
  for (const row of r.recordings) {
    const item = document.createElement('div');
    item.className = 'recording-item';
    const name = document.createElement('span');
    name.textContent = row.name;
    const right = document.createElement('div');
    right.className = 'recording-actions';
    const size = document.createElement('span');
    size.className = 'muted';
    size.textContent = (row.bytes / 1e6).toFixed(1) + ' MB';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'download-btn';
    btn.textContent = 'Download MKV ↓';
    btn.addEventListener('click', async () => {
      try {
        btn.disabled = true;
        btn.textContent = 'Downloading…';
        const res = await fetch('/api/live/recordings/' + encodeURIComponent(row.name), { credentials: 'same-origin' });
        if (!res.ok) throw new Error('Download failed: ' + res.status);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = row.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        btn.textContent = 'Completed ✓';
      } catch (err) {
        notice('Download error: ' + err.message);
        btn.textContent = 'Retry ↓';
      } finally {
        setTimeout(() => { btn.disabled = false; btn.textContent = 'Download MKV ↓'; }, 3000);
      }
    });
    right.append(size, btn);
    item.append(name, right);
    $('recordings').append(item);
  }
}
bind('reload-recordings', loadRecordings);
async function poll() {
  if (!authenticated || polling) return; polling = true;
  try {
    renderStatus(await api('/api/live/status'));
    if (lastJob) {
      const job = await api('/api/live/narrations/' + encodeURIComponent(lastJob)); $('narration-status').textContent = `Narration: ${job.status}${job.error ? ' · ' + job.error : ''}`;
      $('narration-cancel').disabled = ['finished', 'failed', 'cancelled', 'expired'].includes(job.status);
      if ($('narration-cancel').disabled) lastJob = null;
    }
  } catch (error) { $('connection').textContent = 'Control room unreachable'; if (error.code !== 'OPERATOR_UNAUTHORIZED') notice(error.message); }
  finally { polling = false; if (authenticated) pollTimer = setTimeout(poll, 1800); }
}
async function pollPreview() {
  if (!authenticated) return;
  try {
    if (status && !['stopped', 'failed'].includes(status.broadcast.phase)) {
      const response = await fetch('/api/live/preview.jpg', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (response.status === 200) {
        const next = URL.createObjectURL(await response.blob()); $('program-preview').src = next;
        if (previewURL) URL.revokeObjectURL(previewURL); previewURL = next; $('program-preview').hidden = false; $('preview-placeholder').hidden = true;
      }
    }
  } catch { /* The status poll reports connection loss; keep the last dated frame. */ }
  finally { if (authenticated) previewTimer = setTimeout(pollPreview, 5000); }
}
async function enter() {
  const s = await api('/api/live/status'); authenticated = true; fillSettings(s.settings); fillTitles(s.titles); renderStatus(s);
  $('login-panel').hidden = true; $('control-room').hidden = false; $('logout').hidden = false;
  clearTimeout(pollTimer); clearTimeout(previewTimer); void poll(); void pollPreview();
  const result = new URLSearchParams(location.search).get('twitch');
  if (result) { notice(result === 'connected' ? 'Twitch authorized. Chat connects when enabled.' : 'Twitch authorization incomplete. Verify redirect URL and credentials.', result === 'connected'); history.replaceState(null, '', '/control'); }
}
bind('login-form', async () => { await api('/api/live/session', { method: 'POST', body: { token: $('operator-token').value } }); val('operator-token', ''); await enter(); }, { submit: true });
bind('local-login', async () => { await api('/api/live/session', { method: 'POST', body: { local: true } }); await enter(); });
bind('logout', async () => { await api('/api/live/session', { method: 'DELETE' }); showLogin(); });
window.addEventListener('pagehide', () => { authenticated = false; clearTimeout(pollTimer); clearTimeout(previewTimer); if (previewURL) URL.revokeObjectURL(previewURL); }, { once: true });
try {
  const session = await api('/api/live/session');
  if (!session.authenticated) await api('/api/live/session', { method: 'POST', body: { local: true } });
  await enter();
} catch { showLogin(); }
