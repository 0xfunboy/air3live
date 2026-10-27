const $ = id => document.getElementById(id);
let settings, status, pollTimer, previewTimer, authenticated = false, polling = false, lastJob = null, lastChatKey = '', previewURL = null;
const errors = {
  OPERATOR_UNAUTHORIZED: 'Accesso scaduto o chiave operatore non corretta.', ORIGIN_NOT_ALLOWED: 'Apri la regia dal suo indirizzo configurato.',
  PUBLIC_ORIGIN_REQUIRED: 'Per un accesso remoto imposta AIR3_PUBLIC_ORIGIN sul server.',
  STREAM_DESTINATION_REQUIRED: 'Inserisci e salva URL server e stream key prima di premere LIVE.',
  BROWSER_NOT_INSTALLED: 'Installa il browser di cattura con npm run browser:install --prefix studio-broadcast.',
  FFMPEG_NOT_AVAILABLE: 'FFmpeg non è disponibile nel PATH del server. Installa FFmpeg e riavvia la regia.',
  ENCODER_PROBE_FAILED: 'L’encoder selezionato non ha superato la prova. Prova Automatico oppure verifica i driver GPU.',
  STOP_BEFORE_STREAM_SETTINGS: 'Arresta l’uscita prima di cambiare destinazione, formato o encoder.',
  BROADCAST_ALREADY_ACTIVE: 'C’è già un’uscita attiva. Arrestala prima di avviarne un’altra.',
  BROADCAST_NOT_ACTIVE: 'Avvia una registrazione o la live per comandare il renderer in uscita.',
  STAGE_BUSY: 'La presentatrice sta completando il movimento. Riprova quando si ferma.',
  COMMAND_TIMEOUT: 'Il renderer non ha risposto in tempo. Controlla lo stato nelle verifiche.',
  TWITCH_CONFIG_REQUIRED: 'Completa Client ID, Client secret e canale Twitch.',
  INVALID_LIVE_SETTINGS: 'Controlla i valori inseriti. Server, chiavi e intervalli devono rispettare il formato previsto.',
  INVALID_TICKER: 'La guida ammette fino a 12 righe, ognuna di massimo 240 caratteri.',
};
function notice(message, success = false) { $('notice').textContent = message; $('notice').classList.toggle('success', success); $('notice').hidden = !message; }
async function api(path, { method = 'GET', body, timeout = 30000 } = {}) {
  const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  let data; try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    if (response.status === 401 && !path.endsWith('/session')) showLogin();
    const error = new Error(errors[data.error] || data.error || `Richiesta non riuscita (${response.status})`); error.code = data.error; throw error;
  }
  return data;
}
function bind(id, action, { submit = false } = {}) {
  $(id).addEventListener(submit ? 'submit' : 'click', async event => {
    event.preventDefault(); const element = submit ? event.submitter : $(id);
    if (element) element.disabled = true;
    try { notice(''); await action(event); } catch (error) { notice(error.message || 'Operazione non riuscita.'); }
    finally { if (element) element.disabled = false; if (status) renderStatus(status); }
  });
}
function val(id, value) { $(id).value = value ?? ''; }
function checked(id, value) { $(id).checked = !!value; }
function showLogin() { authenticated = false; clearTimeout(pollTimer); clearTimeout(previewTimer); $('login-panel').hidden = false; $('control-room').hidden = true; $('logout').hidden = true; $('connection').textContent = 'Accesso operatore'; }
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
  updateKeyLabels(); updateProvider();
}
function updateKeyLabels() {
  $('stream-key-state').textContent = settings?.stream.hasKey ? 'Salvata sul server · campo vuoto la mantiene' : 'Non configurata';
  $('chat-secret').placeholder = settings?.twitch.hasClientSecret ? 'Client secret salvato sul server' : 'Client secret dell’app Twitch';
}
function fillTitles(t) {
  val('title-label', t.label); val('title-main', t.title); val('title-subtitle', t.subtitle); val('title-ticker', t.ticker.join('\n'));
  val('title-speed', t.speed); val('title-ttl', t.ttlSeconds); checked('title-enabled', t.enabled);
}
function updateProvider() { $('twitch-test').hidden = $('stream-provider').value !== 'twitch'; }
$('stream-provider').addEventListener('change', updateProvider);
$('stream-profile').addEventListener('change', () => val('stream-bitrate', { '720p30': 3000, '1080p30': 4500, '1080p60': 6000 }[$('stream-profile').value]));
$('scene-intensity').addEventListener('input', () => { $('scene-intensity-output').textContent = Math.round(Number($('scene-intensity').value) * 100) + '%'; });
async function saveSettings(patch) { settings = await api('/api/live/settings', { method: 'PATCH', body: patch }); updateKeyLabels(); return settings; }
function streamInput() {
  return { provider: $('stream-provider').value, server: $('stream-server').value.trim(), profile: $('stream-profile').value,
    bitrateKbps: Number($('stream-bitrate').value), encoder: $('stream-encoder').value, quality: $('stream-quality').value,
    autoRecovery: $('stream-auto-recovery') ? $('stream-auto-recovery').checked : true,
    twitchBandwidthTest: false, ...($('stream-key').value ? { key: $('stream-key').value.trim() } : {}) };
}
async function saveStream() { await saveSettings({ stream: streamInput() }); val('stream-key', ''); }
bind('stream-form', async () => { await saveStream(); notice('Destinazione salvata.', true); }, { submit: true });
bind('scene-form', async () => {
  await saveSettings({ scene: { camera: $('scene-camera').value, emotion: $('scene-emotion').value,
    intensity: Number($('scene-intensity').value), eyeContact: $('scene-eye').checked, roaming: $('scene-roaming').checked } });
  notice('Regia e presentatrice aggiornate.', true);
}, { submit: true });
bind('titles-form', async () => {
  await api('/api/live/titles', { method: 'POST', body: { enabled: $('title-enabled').checked, label: $('title-label').value,
    title: $('title-main').value, subtitle: $('title-subtitle').value, ticker: $('title-ticker').value,
    speed: Number($('title-speed').value), ttlSeconds: Number($('title-ttl').value) } }); notice('Titolazione aggiornata.', true);
}, { submit: true });
bind('titles-clear', async () => { const t = await api('/api/live/titles', { method: 'DELETE' }); fillTitles(t); notice('Titolazione rimossa.', true); });
bind('voice-settings-form', async () => {
  await saveSettings({ tts: { baseUrl: $('tts-url').value.trim(), model: $('tts-model').value, voiceIt: $('tts-it').value,
    voiceEn: $('tts-en').value, speed: Number($('tts-speed').value), ...($('tts-key').value ? { apiKey: $('tts-key').value } : {}) } });
  val('tts-key', ''); notice('Server e voce salvati. Puoi mettere in coda una lettura di prova.', true);
}, { submit: true });
bind('narration-form', async () => {
  const row = await api('/api/live/narrations', { method: 'POST', body: { text: $('narration-text').value, language: $('narration-language').value } });
  lastJob = row.id; $('narration-cancel').disabled = false; $('narration-status').textContent = 'Lettura in coda · ' + row.status;
}, { submit: true });
bind('narration-cancel', async () => { if (lastJob) await api('/api/live/narrations/' + encodeURIComponent(lastJob), { method: 'DELETE' }); });
bind('market-form', async () => {
  await saveSettings({ market: { enabled: $('market-enabled').checked, provider: $('market-provider').value, symbol: $('market-symbol').value,
    range: $('market-range').value, wallpanelSource: $('market-wallpanel').value, ...($('market-key').value ? { coinglassKey: $('market-key').value } : {}) } });
  val('market-key', ''); notice('Configurazione dei monitor aggiornata.', true);
}, { submit: true });
async function saveChat(forceEnabled = false) {
  await saveSettings({ twitch: { enabled: forceEnabled || $('chat-enabled').checked, channel: $('chat-channel').value,
    clientId: $('chat-client').value, ...($('chat-secret').value ? { clientSecret: $('chat-secret').value } : {}) } });
  val('chat-secret', ''); if (forceEnabled) checked('chat-enabled', true);
}
bind('chat-form', async () => { await saveChat(); notice('Configurazione chat salvata.', true); }, { submit: true });
bind('twitch-authorize', async () => {
  await saveChat(true); const { url } = await api('/api/live/twitch/authorize', { method: 'POST', body: {} });
  if (new URL(url).origin !== 'https://id.twitch.tv') throw new Error('Indirizzo OAuth inatteso.');
  location.assign(url);
});
bind('twitch-disconnect', async () => { await api('/api/live/twitch/disconnect', { method: 'POST', body: {} }); notice('Chat scollegata.', true); });
async function start(mode) {
  await saveStream();
  const result = await api('/api/live/start', { method: 'POST', body: { mode }, timeout: 45000 });
  renderStatus({ ...status, settings, broadcast: result }); notice(mode === 'record' ? 'Avvio della registrazione locale. Attendo i primi fotogrammi dell’encoder.' : 'Avvio dell’invio. Controlla anche l’ingresso sulla piattaforma.', true);
}
bind('go-live', () => start('live')); bind('record', () => start('record')); bind('twitch-test', () => start('twitch-test'));
bind('stop', async () => { const result = await api('/api/live/stop', { method: 'POST', body: {}, timeout: 40000 }); renderStatus({ ...status, broadcast: result }); notice('Uscita arrestata.', true); await loadRecordings(); });
bind('preflight', async () => { await saveStream(); const r = await api('/api/live/preflight', { method: 'POST', body: { mode: 'record' }, timeout: 45000 }); notice(`Prova encoder superata: ${r.encoder}, ${r.width} × ${r.height} a ${r.fps} fps. Il renderer GPU sarà verificato all’avvio.`, true); });
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
    const author = document.createElement('strong'); author.textContent = row.author || row.displayName || row.userName || row.login || 'Utente';
    const provider = document.createElement('small'); provider.textContent = row.provider || 'Twitch'; author.append(provider);
    const text = document.createElement('p'); text.textContent = row.text || '';
    const title = document.createElement('button'); title.textContent = 'Prepara titolo';
    title.addEventListener('click', () => { val('title-main', (row.text || '').slice(0, 120)); val('title-subtitle', `Dalla chat · ${row.author || row.displayName || row.userName || row.login || 'Utente'}`); checked('title-enabled', true); selectTab('titles'); $('title-main').focus(); });
    item.append(author, text, title); target.append(item);
  }
  if (!messages.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'In attesa di messaggi.'; target.append(p); }
  target.scrollTop = target.scrollHeight;
}
function renderStatus(s) {
  if (!s) return; status = s; if (s.settings) settings = s.settings; const b = s.broadcast;
  const active = !['stopped', 'failed'].includes(b.phase) || b.busy;
  const phases = { stopped: 'Studio offline', starting: 'Preparazione dell’uscita', running: b.mode === 'record' ? 'Registrazione locale' : b.mode === 'twitch-test' ? 'Test banda Twitch' : 'Live · invio in corso', stalled: 'Uscita in ritardo', reconnecting: 'Riconnessione automatica 24/7', stopping: 'Arresto in corso', failed: 'Uscita interrotta' };
  $('phase').textContent = phases[b.phase] || b.phase;
  $('phase-dot').classList.toggle('on', b.phase === 'running'); $('phase-dot').classList.toggle('working', active && b.phase !== 'running');
  $('go-live').disabled = active; $('record').disabled = active; $('twitch-test').disabled = active;
  $('stop').disabled = !active || b.phase === 'stopping';
  $('destination-summary').textContent = b.error || `${settings?.stream.provider === 'restream' ? 'Restream' : settings?.stream.provider === 'twitch' ? 'Twitch' : 'RTMP personalizzato'} · ${settings?.stream.profile || ''} · ${b.encoder || settings?.stream.encoder || 'auto'}${b.mode === 'record' ? ' · file locale' : ''}`;
  $('render-fps').textContent = Number.isFinite(b.renderFps) ? b.renderFps.toFixed(1) + ' fps' : '—';
  $('encode-fps').textContent = b.lastProgressAt ? Number(b.fps).toFixed(1) + ' fps' : '—';
  $('output-rate').textContent = b.bitrate && b.bitrate !== 'N/A' ? b.bitrate : '—';
  const seconds = Math.floor(b.elapsedSeconds || 0); $('elapsed').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  $('preview-age').textContent = b.previewAt ? `Frame di ${Math.max(0, Math.round((Date.now() - b.previewAt) / 1000))} s fa` : 'Anteprima del renderer';
  $('connection').textContent = 'Regia collegata'; $('twitch-redirect').textContent = s.redirectUri || '';
  $('events').textContent = (b.events || []).map(e => `${e.at?.slice(11, 19) || ''}  ${e.event}${e.message ? ' · ' + e.message : ''}`).join('\n');
  $('market-status').textContent = s.market?.enabled === false ? 'Fonti disattivate' : `${s.market?.provider || settings?.market.provider || ''} · ${s.market?.symbol || ''}`;
  renderChat(s.chat || {}, s.externalChat);
}
async function loadRecordings() {
  if (!authenticated) return; const r = await api('/api/live/recordings'); $('recordings').replaceChildren();
  if (!r.recordings.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Nessuna registrazione locale.'; $('recordings').append(p); return; }
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
    btn.textContent = 'Scarica MKV ↓';
    btn.addEventListener('click', async () => {
      try {
        btn.disabled = true;
        btn.textContent = 'Download…';
        const res = await fetch('/api/live/recordings/' + encodeURIComponent(row.name), { credentials: 'same-origin' });
        if (!res.ok) throw new Error('Download non riuscito: ' + res.status);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = row.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        btn.textContent = 'Completato ✓';
      } catch (err) {
        notice('Errore download: ' + err.message);
        btn.textContent = 'Riprova ↓';
      } finally {
        setTimeout(() => { btn.disabled = false; btn.textContent = 'Scarica MKV ↓'; }, 3000);
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
      const job = await api('/api/live/narrations/' + encodeURIComponent(lastJob)); $('narration-status').textContent = `Lettura: ${job.status}${job.error ? ' · ' + job.error : ''}`;
      $('narration-cancel').disabled = ['finished', 'failed', 'cancelled', 'expired'].includes(job.status);
      if ($('narration-cancel').disabled) lastJob = null;
    }
  } catch (error) { $('connection').textContent = 'Regia non raggiungibile'; if (error.code !== 'OPERATOR_UNAUTHORIZED') notice(error.message); }
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
  if (result) { notice(result === 'connected' ? 'Twitch autorizzato. La chat si collega se abilitata.' : 'Autorizzazione Twitch non completata. Verifica redirect e credenziali.', result === 'connected'); history.replaceState(null, '', '/control'); }
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
