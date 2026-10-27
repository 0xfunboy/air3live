import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { QueueError } from './queue.mjs';

const AUTH = 'https://id.twitch.tv/oauth2/';
const API = 'https://api.twitch.tv/helix/';
const SOCKET = 'wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30';
const SCOPE = 'user:read:chat';
const EVENTS = Object.freeze(['channel.chat.message', 'channel.chat.message_delete', 'channel.chat.clear', 'channel.chat.clear_user_messages']);
const STATE_TTL = 10 * 60_000;
const VALIDATION_INTERVAL = 60 * 60_000;
const TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const clean = (value, max = 500) => typeof value === 'string' ? value.replace(TEXT, ' ').slice(0, max) : '';
const tokenString = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\s\u0000-\u001f]/.test(value);
const identity = value => typeof value === 'string' && /^\d{1,32}$/.test(value);
const login = value => typeof value === 'string' && /^[a-z0-9_]{1,25}$/i.test(value);
const hash = value => createHash('sha256').update(value).digest();
const error = (code, statusCode = 400) => new QueueError(code, statusCode);
const safeError = cause => ({
  TWITCH_AUTH_REQUIRED: 'Collega Twitch per leggere la chat.',
  TWITCH_CLIENT_REQUIRED: 'Inserisci Client ID e Client Secret della tua applicazione Twitch.',
  TWITCH_AUTH_INVALID: 'Autorizzazione Twitch scaduta o revocata. Ricollega l’account.',
  TWITCH_SCOPE_REQUIRED: 'È richiesta l’autorizzazione di lettura chat di Twitch.',
  TWITCH_CHANNEL_INVALID: 'Il nome del canale Twitch non è valido.',
  TWITCH_CHANNEL_NOT_FOUND: 'Il canale Twitch non è stato trovato.',
  TWITCH_CHAT_FORBIDDEN: 'Twitch non consente di leggere questo canale con l’account collegato.',
  TWITCH_REVOKED: 'Twitch ha revocato la sottoscrizione della chat. Ricollega l’account.',
  TWITCH_SUBSCRIPTION_UNAVAILABLE: 'Una sottoscrizione della chat non è disponibile.',
  TWITCH_RATE_LIMIT: 'Limite Twitch raggiunto. La connessione verrà ritentata.',
  TWITCH_HEARTBEAT_TIMEOUT: 'Connessione Twitch interrotta. Riconnessione in corso.',
  TWITCH_CONNECTION_CLOSED: 'Connessione Twitch interrotta. Riconnessione in corso.',
  TWITCH_RECONNECT_INVALID: 'Twitch ha restituito un indirizzo di riconnessione non valido.',
}[cause?.code] || 'Connessione Twitch non disponibile. Verrà ritentata.');

function validateRedirect(value) {
  let url; try { url = new URL(value); } catch { throw error('TWITCH_REDIRECT_INVALID'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || url.username || url.password || url.hash || url.search) throw error('TWITCH_REDIRECT_INVALID');
  return url.toString();
}

function reconnectUrl(value) {
  let url; try { url = new URL(value); } catch { throw error('TWITCH_RECONNECT_INVALID'); }
  if (url.protocol !== 'wss:' || url.hostname !== 'eventsub.wss.twitch.tv' || url.username || url.password || url.hash || (url.port && url.port !== '443')) throw error('TWITCH_RECONNECT_INVALID');
  return value; // Twitch requires the supplied reconnection URL unchanged.
}

/** Read-only EventSub chat client. No chat-send endpoint or command execution. */
export function createTwitchChat({ getConfig, saveTokens, fetchImpl = fetch,
  WebSocketImpl = globalThis.WebSocket, now = Date.now,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  if (typeof getConfig !== 'function' || typeof saveTokens !== 'function') throw new TypeError('getConfig and saveTokens are required');
  const initialConfig = getConfig() || {};
  let desired = false, generation = 0, authEpoch = 0, signature = '', appIdentity = JSON.stringify([initialConfig.clientId, initialConfig.clientSecret]);
  let state = 'disabled', lastError = null, channel = '', reader = '', broadcasterId = '', readerId = '';
  let connectedAt = null, lastEventAt = null, reconnects = 0, attempts = 0;
  let current = null, handover = null, reconnectTimer = null, validationTimer = null, starting = null, refreshing = null;
  let messages = [], clearAllAt = -Infinity;
  const sockets = new Set(), pendingStates = new Map(), seen = new Map(), deleted = new Map(), clearedUsers = new Map();
  const timer = (fn, delay) => { const id = setTimeoutImpl(fn, delay); id?.unref?.(); return id; };
  const cancel = id => { if (id !== null) clearTimeoutImpl(id); };
  const isCurrent = ticket => desired && ticket === generation;
  const currentConfig = () => getConfig() || {};
  const publicState = () => ({ state, error: lastError, channel: channel || clean(currentConfig().channel, 25),
    login: reader || clean(currentConfig().login, 25), messages: messages.map(row => ({ ...row })),
    authorized: !!currentConfig().accessToken && state !== 'auth_required', connectedAt, lastEventAt, reconnects, readOnly: true });

  function resetMessages() { messages = []; seen.clear(); deleted.clear(); clearedUsers.clear(); clearAllAt = -Infinity; lastEventAt = null; }
  function boundedPut(map, key, value, limit = 4096) {
    map.set(key, value);
    while (map.size > limit) map.delete(map.keys().next().value);
  }
  function closeSocket(record) {
    if (!record || record.closed) return;
    record.closed = true; cancel(record.timer); sockets.delete(record);
    try { record.socket.close(1000, 'client stop'); } catch { /* Already closed. */ }
  }
  function closeConnections() {
    for (const record of [...sockets]) closeSocket(record);
    current = null; handover = null; connectedAt = null;
  }
  function stop() {
    desired = false; generation++; starting = null;
    cancel(reconnectTimer); reconnectTimer = null; cancel(validationTimer); validationTimer = null;
    closeConnections(); state = currentConfig().enabled ? 'stopped' : 'disabled'; lastError = null;
    return publicState();
  }
  function terminal(cause, ticket) {
    if (!isCurrent(ticket)) return;
    stop(); state = 'auth_required'; lastError = safeError(cause);
  }
  function fail(cause, ticket) {
    if (!isCurrent(ticket)) return;
    if (['TWITCH_AUTH_REQUIRED', 'TWITCH_CLIENT_REQUIRED', 'TWITCH_AUTH_INVALID', 'TWITCH_SCOPE_REQUIRED', 'TWITCH_CHAT_FORBIDDEN', 'TWITCH_REVOKED', 'TWITCH_CHANNEL_INVALID', 'TWITCH_CHANNEL_NOT_FOUND', 'TWITCH_SUBSCRIPTION_UNAVAILABLE'].includes(cause?.code)) {
      terminal(cause, ticket); return;
    }
    closeConnections(); cancel(validationTimer); validationTimer = null;
    lastError = safeError(cause); state = 'reconnecting'; reconnects++;
    if (reconnectTimer !== null) return;
    const wait = Math.max(Math.min(30_000, 1000 * 2 ** Math.min(attempts++, 5)), cause?.retryAfterMs || 0);
    reconnectTimer = timer(() => {
      reconnectTimer = null;
      if (isCurrent(ticket)) connectFresh(ticket).catch(cause => fail(cause, ticket));
    }, wait);
  }

  async function request(url, options = {}) {
    let response;
    try { response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(12_000) }); }
    catch { throw error('TWITCH_NETWORK_UNAVAILABLE', 502); }
    if (!response.ok) {
      const code = response.status === 401 ? 'TWITCH_AUTH_INVALID' : response.status === 403 ? 'TWITCH_CHAT_FORBIDDEN'
        : response.status === 429 ? 'TWITCH_RATE_LIMIT' : 'TWITCH_REQUEST_FAILED';
      const failure = error(code, response.status === 401 || response.status === 403 ? 401 : 502);
      failure.remoteStatus = response.status;
      if (response.status === 429) {
        const seconds = Number(response.headers?.get?.('Retry-After'));
        if (Number.isFinite(seconds) && seconds > 0) failure.retryAfterMs = Math.min(300_000, seconds * 1000);
      }
      throw failure; // Never expose Twitch's error body or token-bearing URLs.
    }
    let data; try { data = await response.json(); } catch { throw error('TWITCH_RESPONSE_INVALID', 502); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw error('TWITCH_RESPONSE_INVALID', 502);
    return data;
  }
  function credentials() {
    const cfg = currentConfig();
    if (!tokenString(cfg.clientId) || !tokenString(cfg.clientSecret)) throw error('TWITCH_CLIENT_REQUIRED');
    return cfg;
  }
  function validateIdentity(value, clientId) {
    if (value.client_id !== clientId || !identity(value.user_id) || !login(value.login)) throw error('TWITCH_AUTH_INVALID', 401);
    if (!Array.isArray(value.scopes) || !value.scopes.includes(SCOPE)) throw error('TWITCH_SCOPE_REQUIRED', 401);
    return value;
  }
  async function validate(accessToken, clientId) {
    return validateIdentity(await request(AUTH + 'validate', { headers: { Authorization: 'OAuth ' + accessToken } }), clientId);
  }
  function validatedPatch(value) {
    return { userId: value.user_id, login: value.login.toLowerCase(), scopes: value.scopes.filter(s => typeof s === 'string' && s.length <= 100),
      expiresAt: now() + Math.max(0, Math.min(365 * 86400, Number(value.expires_in) || 0)) * 1000 };
  }
  function persistenceGuard(cfg, revision, checkAccessToken = false) {
    // The settings store evaluates this INSIDE its serialized write queue,
    // immediately before validating/writing the patch. A pre-await check alone
    // cannot protect a queued token write from logout or client replacement.
    return currentSettings => {
      const current = currentSettings?.twitch;
      return revision === authEpoch && !!current && current.clientId === cfg.clientId && current.clientSecret === cfg.clientSecret
        && (!checkAccessToken || current.accessToken === cfg.accessToken);
    };
  }
  async function refreshAccess(expectedToken) {
    if (currentConfig().accessToken !== expectedToken) return;
    if (refreshing) return refreshing;
    const cfg = credentials(), revision = authEpoch;
    if (!tokenString(cfg.refreshToken)) throw error('TWITCH_AUTH_REQUIRED', 401);
    refreshing = (async () => {
      let grant;
      try { grant = await request(AUTH + 'token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: cfg.refreshToken }).toString() }); }
      catch (cause) { if ([400, 401].includes(cause.remoteStatus)) throw error('TWITCH_AUTH_INVALID', 401); throw cause; }
      if (!tokenString(grant.access_token) || !tokenString(grant.refresh_token)) throw error('TWITCH_AUTH_INVALID', 401);
      const validated = await validate(grant.access_token, cfg.clientId);
      if (cfg.userId && validated.user_id !== cfg.userId) throw error('TWITCH_AUTH_INVALID', 401);
      if (revision !== authEpoch || currentConfig().clientId !== cfg.clientId) throw error('TWITCH_AUTH_INVALID', 401);
      await saveTokens({ accessToken: grant.access_token, refreshToken: grant.refresh_token, ...validatedPatch(validated) },
        { guard: persistenceGuard(cfg, revision, true) });
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function ensureIdentity() {
    let cfg = credentials();
    if (!tokenString(cfg.accessToken)) throw error('TWITCH_AUTH_REQUIRED', 401);
    let validated;
    try { validated = await validate(cfg.accessToken, cfg.clientId); }
    catch (cause) {
      if (cause.remoteStatus !== 401) throw cause;
      await refreshAccess(cfg.accessToken); cfg = credentials(); validated = await validate(cfg.accessToken, cfg.clientId);
    }
    readerId = validated.user_id; reader = validated.login.toLowerCase();
    return validated;
  }
  async function helix(relative, options = {}, retry = true) {
    const cfg = credentials();
    try { return await request(API + relative, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers,
      Authorization: 'Bearer ' + cfg.accessToken, 'Client-Id': cfg.clientId } }); }
    catch (cause) {
      if (retry && cause.remoteStatus === 401) { await refreshAccess(cfg.accessToken); return helix(relative, options, false); }
      throw cause;
    }
  }
  function scheduleValidation(ticket) {
    cancel(validationTimer);
    validationTimer = timer(async () => {
      validationTimer = null;
      if (!isCurrent(ticket)) return;
      try { await ensureIdentity(); if (isCurrent(ticket)) scheduleValidation(ticket); }
      catch (cause) { fail(cause, ticket); }
    }, VALIDATION_INTERVAL);
  }

  function consumeNotification(frame) {
    const event = frame.payload?.event, sub = frame.payload?.subscription;
    if (!event || !sub || !EVENTS.includes(sub.type) || event.broadcaster_user_id !== broadcasterId || sub.condition?.user_id !== readerId) return;
    const eventId = clean(frame.metadata?.message_id, 200); if (!eventId || seen.has(eventId)) return;
    boundedPut(seen, eventId, now());
    const stamp = Date.parse(frame.metadata?.message_timestamp), createdAt = Number.isFinite(stamp) ? stamp : now();
    lastEventAt = now();
    if (sub.type === 'channel.chat.message') {
      const id = clean(event.message_id, 200), userId = clean(event.chatter_user_id, 32), text = clean(event.message?.text, 2000);
      if (!id || !identity(userId) || !text || deleted.has(id) || createdAt <= clearAllAt || createdAt <= (clearedUsers.get(userId) ?? -Infinity) || messages.some(m => m.id === id)) return;
      messages.push({ id, userId, userLogin: clean(event.chatter_user_login, 25), userName: clean(event.chatter_user_name, 100), text,
        color: /^#[0-9a-f]{6}$/i.test(event.color || '') ? event.color : '#d9e3f0', createdAt });
      if (messages.length > 200) messages.splice(0, messages.length - 200);
    } else if (sub.type === 'channel.chat.message_delete') {
      const id = clean(event.message_id, 200); boundedPut(deleted, id, createdAt); messages = messages.filter(row => row.id !== id);
    } else if (sub.type === 'channel.chat.clear_user_messages') {
      const id = clean(event.target_user_id, 32); boundedPut(clearedUsers, id, Math.max(createdAt, clearedUsers.get(id) || 0));
      messages = messages.filter(row => row.userId !== id || row.createdAt > createdAt);
    } else if (sub.type === 'channel.chat.clear') {
      clearAllAt = Math.max(clearAllAt, createdAt); messages = messages.filter(row => row.createdAt > createdAt);
    }
  }
  function armHeartbeat(record, seconds = record.keepalive) {
    cancel(record.timer); record.keepalive = Math.max(10, Math.min(600, Number(seconds) || 30));
    record.timer = timer(() => {
      if (!record.closed && isCurrent(record.generation)) fail(error('TWITCH_HEARTBEAT_TIMEOUT'), record.generation);
    }, record.keepalive * 1000 + 1000);
  }
  async function welcome(record, frame) {
    const session = frame.payload?.session;
    if (!session || typeof session.id !== 'string' || !session.id || session.id.length > 1024 || record.welcomed) return;
    record.welcomed = true; armHeartbeat(record, session.keepalive_timeout_seconds);
    if (record.previous) {
      // Twitch transfers subscriptions during handover. Resubscribing here
      // would duplicate events and can exceed per-account subscription limits.
      if (!isCurrent(record.generation) || handover !== record) return;
      current = record; handover = null; closeSocket(record.previous); record.previous = null;
    } else {
      await Promise.all(EVENTS.map(type => helix('eventsub/subscriptions', { method: 'POST', body: JSON.stringify({ type, version: '1',
        condition: { broadcaster_user_id: broadcasterId, user_id: readerId }, transport: { method: 'websocket', session_id: session.id } }) })));
      if (!isCurrent(record.generation) || record.closed) return;
      current = record;
    }
    state = 'connected'; lastError = null; attempts = 0; connectedAt ??= now();
  }
  async function onMessage(record, payload) {
    if (!isCurrent(record.generation) || record.closed) return;
    let text = payload;
    if (typeof text !== 'string') {
      if (text instanceof ArrayBuffer) text = Buffer.from(text).toString();
      else if (Buffer.isBuffer(text)) text = text.toString();
      else return;
    }
    if (Buffer.byteLength(text) > 128 * 1024) return;
    let frame; try { frame = JSON.parse(text); } catch { return; }
    if (!frame || typeof frame !== 'object' || !frame.metadata || !frame.payload) return;
    const type = frame.metadata.message_type;
    if (type === 'session_welcome') { await welcome(record, frame); return; }
    if (!record.welcomed) return;
    if (type === 'session_keepalive') { armHeartbeat(record); return; }
    if (type === 'notification') { armHeartbeat(record); consumeNotification(frame); return; }
    if (type === 'session_reconnect') {
      if (handover || current !== record) return;
      const url = reconnectUrl(frame.payload.session?.reconnect_url);
      state = 'reconnecting'; openSocket(url, record.generation, record); return;
    }
    if (type === 'revocation') {
      const reason = frame.payload.subscription?.status;
      if (reason === 'authorization_revoked' || reason === 'user_removed') throw error('TWITCH_REVOKED', 401);
      throw error('TWITCH_SUBSCRIPTION_UNAVAILABLE');
    }
  }
  function openSocket(url, ticket, previous = null) {
    if (!isCurrent(ticket)) return;
    if (typeof WebSocketImpl !== 'function') throw error('TWITCH_NETWORK_UNAVAILABLE', 502);
    const socket = new WebSocketImpl(url);
    const record = { socket, generation: ticket, previous, timer: null, closed: false, welcomed: false, keepalive: 30 };
    sockets.add(record); if (previous) handover = record; else current = record;
    record.timer = timer(() => { if (!record.closed) fail(error('TWITCH_HEARTBEAT_TIMEOUT'), ticket); }, 15_000);
    socket.addEventListener('message', event => { onMessage(record, event.data).catch(cause => { if (!record.closed) fail(cause, ticket); }); });
    socket.addEventListener('error', () => { if (!record.closed) fail(error('TWITCH_NETWORK_UNAVAILABLE'), ticket); });
    socket.addEventListener('close', () => {
      if (record.closed || !isCurrent(ticket)) return;
      record.closed = true; cancel(record.timer); sockets.delete(record);
      if (handover && current === record) { current = null; return; }
      fail(error('TWITCH_CONNECTION_CLOSED'), ticket);
    });
  }
  async function connectFresh(ticket) {
    if (!isCurrent(ticket)) return;
    const validated = await ensureIdentity(); if (!isCurrent(ticket)) return;
    const requested = (currentConfig().channel || validated.login).toLowerCase().replace(/^#/, '');
    if (!login(requested)) throw error('TWITCH_CHANNEL_INVALID');
    const result = await helix('users?login=' + encodeURIComponent(requested));
    if (!isCurrent(ticket)) return;
    const user = result.data?.find(item => item.login?.toLowerCase() === requested && identity(item.id));
    if (!user) throw error('TWITCH_CHANNEL_NOT_FOUND');
    if (channel !== requested || broadcasterId !== user.id) resetMessages();
    channel = requested; broadcasterId = user.id;
    scheduleValidation(ticket); openSocket(SOCKET, ticket);
  }

  function start() {
    if (!currentConfig().enabled) { stop(); return Promise.resolve(publicState()); }
    if (starting) return starting;
    if (desired && (current || handover || reconnectTimer !== null)) return Promise.resolve(publicState());
    desired = true; const ticket = ++generation; state = 'connecting'; lastError = null;
    starting = connectFresh(ticket).catch(cause => fail(cause, ticket)).then(() => publicState()).finally(() => { if (ticket === generation) starting = null; });
    return starting;
  }
  async function configure() {
    const cfg = currentConfig(), nextApp = JSON.stringify([cfg.clientId, cfg.clientSecret]);
    const next = JSON.stringify([cfg.enabled, cfg.clientId, cfg.clientSecret, cfg.channel]);
    if (next === signature) return publicState();
    if (nextApp !== appIdentity) { authEpoch++; pendingStates.clear(); appIdentity = nextApp; }
    signature = next; stop(); resetMessages(); channel = ''; reader = ''; readerId = ''; broadcasterId = '';
    return cfg.enabled ? start() : publicState();
  }
  function authorize({ redirectUri, sessionId } = {}) {
    const cfg = credentials(), redirect = validateRedirect(redirectUri);
    if (typeof sessionId !== 'string' || sessionId.length < 16 || sessionId.length > 4096) throw error('TWITCH_OPERATOR_SESSION_REQUIRED', 401);
    for (const [key, row] of pendingStates) if (now() >= row.expiresAt) pendingStates.delete(key);
    const state = randomBytes(32).toString('hex');
    boundedPut(pendingStates, state, { expiresAt: now() + STATE_TTL, sessionHash: hash(sessionId), redirectUri: redirect, clientId: cfg.clientId, epoch: authEpoch }, 100);
    const url = new URL(AUTH + 'authorize');
    url.search = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPE, state, force_verify: 'true' }).toString();
    return { url: url.toString() };
  }
  async function callback({ code, state: oauthState, redirectUri, sessionId } = {}) {
    const saved = pendingStates.get(oauthState);
    // Consume even an invalid callback, preventing replay of a partially used state.
    pendingStates.delete(oauthState);
    if (!saved || now() >= saved.expiresAt || saved.epoch !== authEpoch || typeof sessionId !== 'string' || sessionId.length > 4096 || !timingSafeEqual(saved.sessionHash, hash(sessionId))) throw error('TWITCH_OAUTH_STATE_INVALID', 401);
    const cfg = credentials();
    if (saved.redirectUri !== validateRedirect(redirectUri) || saved.clientId !== cfg.clientId || !tokenString(code)) throw error('TWITCH_OAUTH_STATE_INVALID', 401);
    const grant = await request(AUTH + 'token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, grant_type: 'authorization_code', redirect_uri: saved.redirectUri }).toString() });
    if (!tokenString(grant.access_token) || !tokenString(grant.refresh_token)) throw error('TWITCH_AUTH_INVALID', 401);
    const validated = await validate(grant.access_token, cfg.clientId);
    if (saved.epoch !== authEpoch || cfg.clientId !== currentConfig().clientId) throw error('TWITCH_OAUTH_STATE_INVALID', 401);
    await saveTokens({ accessToken: grant.access_token, refreshToken: grant.refresh_token, ...validatedPatch(validated) },
      { guard: persistenceGuard(cfg, saved.epoch) });
    if (saved.epoch !== authEpoch) throw error('TWITCH_OAUTH_STATE_INVALID', 401);
    stop(); resetMessages(); reader = validated.login.toLowerCase(); readerId = validated.user_id;
    if (currentConfig().enabled) await start();
    return publicState();
  }
  async function clearAuth() {
    authEpoch++; pendingStates.clear(); stop(); resetMessages(); reader = ''; readerId = ''; broadcasterId = '';
    await saveTokens({ accessToken: '', refreshToken: '', userId: '', login: '', scopes: [], expiresAt: 0 });
    state = currentConfig().enabled ? 'auth_required' : 'disabled';
    return publicState();
  }
  return { configure, start, stop, publicState, authorize, callback, clearAuth };
}
