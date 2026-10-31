import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { QueueError } from './queue.mjs';

const digest = v => createHash('sha256').update(String(v)).digest();
export const bearerMatches = (req, token) => !!token && typeof req.headers.authorization === 'string' &&
  /^Bearer [^\s]+$/.test(req.headers.authorization) && timingSafeEqual(digest(req.headers.authorization.slice(7)), digest(token));
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const COOKIE = 'air3_operator';

export function createOperatorAuth(config, { now = Date.now } = {}) {
  const sessions = new Map(), attempts = new Map();
  function isAllowedOrigin(candOrigin) {
    if (!candOrigin || typeof candOrigin !== 'string') return false;
    let url; try { url = new URL(candOrigin); } catch { return false; }
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (/^(127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(url.host)) return true;
    if (config.publicOrigin) {
      try { if (new URL(config.publicOrigin).origin === url.origin) return true; } catch {}
    }
    if (config.controlOrigin) {
      try { if (new URL(config.controlOrigin).origin === url.origin) return true; } catch {}
    }
    if (/(?:^|\.)airewardrop\.xyz(?::\d{1,5})?$/i.test(url.host)) return true;
    return false;
  }
  function origin(req) {
    const originHeader = typeof req.headers?.origin === 'string' ? req.headers.origin : null;
    if (originHeader && isAllowedOrigin(originHeader)) return originHeader;
    const host = req.headers?.host;
    if (config.publicOrigin) {
      if (typeof host === 'string' && /(?:^|\.)airewardrop\.xyz(?::\d{1,5})?$/i.test(host)) {
        return `https://${host}`;
      }
      return config.publicOrigin;
    }
    if (typeof host !== 'string' || !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(host)) throw new QueueError('PUBLIC_ORIGIN_REQUIRED', 403);
    return `http://${host}`;
  }
  function sameOrigin(req) {
    const originHeader = req.headers?.origin;
    if (!originHeader) return false;
    if (req.headers['sec-fetch-site'] && !['same-origin', 'same-site'].includes(req.headers['sec-fetch-site'])) return false;
    if (isAllowedOrigin(originHeader)) {
      const host = req.headers?.host;
      if (typeof host === 'string') {
        let url; try { url = new URL(originHeader); } catch { return false; }
        if (url.host === host) return true;
        if (isAllowedOrigin(`http://${host}`) || isAllowedOrigin(`https://${host}`)) return true;
      }
    }
    let expected; try { expected = origin(req); } catch { return false; }
    return originHeader === expected;
  }
  function session(req) {
    const raw = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
    const id = raw?.slice(COOKIE.length + 1), row = sessions.get(id);
    if (row?.expiresAt > now()) return { id, ...row };
    if (id) sessions.delete(id);
    return null;
  }
  function requireOperator(req, { mutation = false } = {}) {
    const bearer = bearerMatches(req, config.operatorToken);
    const current = session(req);
    if (!bearer && !current) throw new QueueError('OPERATOR_UNAUTHORIZED', 401);
    if (mutation && ((!bearer || req.headers.origin) && !sameOrigin(req))) throw new QueueError('ORIGIN_NOT_ALLOWED', 403);
    return current || { id: 'bearer-operator' };
  }
  function login(req, res, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['token', 'local'].includes(k))) throw new QueueError('INVALID_LOGIN', 400);
    if (!sameOrigin(req)) throw new QueueError('ORIGIN_NOT_ALLOWED', 403);
    const ip = req.socket.remoteAddress || 'unknown';
    let attempt = attempts.get(ip);
    if (!attempt || now() - attempt.at > 60_000) attempt = { at: now(), count: 0 };
    if (++attempt.count > 10) throw new QueueError('LOGIN_RATE_LIMIT', 429);
    attempts.set(ip, attempt);
    for (const [key, row] of attempts) if (now() - row.at > 60_000) attempts.delete(key);
    if (attempts.size > 500) attempts.delete(attempts.keys().next().value);
    const local = input.local === true && config.localOperator !== false && LOOPBACK.has(ip) &&
      /^(127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(req.headers.host || '') &&
      /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(origin(req));
    const validToken = typeof input.token === 'string' && input.token.length < 256 && timingSafeEqual(digest(input.token), digest(config.operatorToken));
    if (!local && !validToken) throw new QueueError('OPERATOR_UNAUTHORIZED', 401);
    for (const [id, row] of sessions) if (row.expiresAt <= now()) sessions.delete(id);
    if (sessions.size >= 64) sessions.delete(sessions.keys().next().value);
    const id = randomBytes(32).toString('hex'); sessions.set(id, { expiresAt: now() + 12 * 3600_000 });
    attempts.delete(ip);
    res.setHeader('Set-Cookie', `${COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${origin(req).startsWith('https:') ? '; Secure' : ''}`);
    return { authenticated: true, local };
  }
  return { origin, sameOrigin, session, requireOperator, login,
    logout(req, res) { requireOperator(req, { mutation: true }); const s = session(req); if (s) sessions.delete(s.id);
      res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`); },
  };
}
