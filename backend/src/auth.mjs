import crypto from 'node:crypto';
import { config } from './config.mjs';

const SESSION_COOKIE_NAME = 'admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// shortcut: in-memory session store resets on server restart; move to SQL Server table if multi-instance
const sessions = new Map();

function sha256(str) {
  return crypto.createHash('sha256').update(String(str || ''), 'utf8').digest();
}

export function verifyCredentials(username, password) {
  const userOk = crypto.timingSafeEqual(sha256(username), sha256(config.admin.username));
  const passOk = crypto.timingSafeEqual(sha256(password), sha256(config.admin.password));
  return userOk && passOk;
}

export function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { username, expiresAt });
  return { token, username, expiresAt };
}

export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of String(cookieHeader).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function getSessionFromRequest(req) {
  const cookies = parseCookies(req?.headers?.cookie);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;

  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

export function destroySession(token) {
  if (token) sessions.delete(token);
}

export function buildSessionCookieHeader(token, clear = false) {
  if (clear) {
    return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  }
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
}
