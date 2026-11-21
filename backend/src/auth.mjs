import crypto from 'node:crypto';
import { config } from './config.mjs';

const SESSION_COOKIE_NAME = 'admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Granular permissions for RBAC
export const ALL_PERMISSIONS = [
  { key: 'view_map', label: 'Chỉ xem bản đồ & địa giới' },
  { key: 'view_bcvh', label: 'Xem danh sách & xuất Excel BCVH' },
  { key: 'edit_bcvh', label: 'Thêm / sửa / xóa thông tin BCVH' },
  { key: 'view_routes', label: 'Xem khu vực phát & tuyến đường' },
  { key: 'edit_routes', label: 'Gộp / tạo / sửa / xóa khu vực phát' },
  { key: 'edit_admin_boundaries', label: 'Sửa địa giới xã/phường & huyện cũ' },
  { key: 'manage_users', label: 'Quản lý tài khoản & phân quyền' },
];

export const VALID_PERMISSION_SET = new Set(ALL_PERMISSIONS.map((p) => p.key));

export const ROLE_PRESETS = {
  super_admin: {
    label: 'Quản trị toàn quyền',
    permissions: ALL_PERMISSIONS.map((p) => p.key),
  },
  bcvh_manager: {
    label: 'Quản lý BCVH',
    permissions: ['view_map', 'view_bcvh', 'edit_bcvh', 'view_routes'],
  },
  route_manager: {
    label: 'Quản lý Khu vực phát',
    permissions: ['view_map', 'view_bcvh', 'view_routes', 'edit_routes'],
  },
  boundary_editor: {
    label: 'Biên tập địa giới',
    permissions: ['view_map', 'view_bcvh', 'view_routes', 'edit_admin_boundaries'],
  },
  viewer: {
    label: 'Chỉ xem',
    permissions: ['view_map', 'view_bcvh', 'view_routes'],
  },
  custom: {
    label: 'Tùy chỉnh quyền',
    permissions: ['view_map'],
  },
};

export function normalizePermissions(perms, role = 'viewer') {
  if (role === 'super_admin') return ALL_PERMISSIONS.map((p) => p.key);
  const raw = Array.isArray(perms) ? perms : ROLE_PRESETS[role]?.permissions || ['view_map'];
  const clean = [...new Set(raw.map(String).filter((k) => VALID_PERMISSION_SET.has(k)))];
  // Implied view permissions when edit permissions are granted
  if (clean.includes('edit_bcvh') && !clean.includes('view_bcvh')) clean.push('view_bcvh');
  if (clean.includes('edit_routes') && !clean.includes('view_routes')) clean.push('view_routes');
  if (!clean.includes('view_map')) clean.unshift('view_map');
  return clean;
}

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(plain || ''), salt, 32).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(plain, storedHash) {
  const parts = String(storedHash || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hex] = parts;
  if (!salt || !hex) return false;
  const derived = crypto.scryptSync(String(plain || ''), salt, 32);
  const expected = Buffer.from(hex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

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

export function createSession(userOrUsername) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const user =
    typeof userOrUsername === 'string'
      ? {
          id: 0,
          username: userOrUsername,
          fullName: userOrUsername,
          role: 'super_admin',
          permissions: ALL_PERMISSIONS.map((p) => p.key),
        }
      : {
          id: userOrUsername.id || 0,
          username: userOrUsername.username,
          fullName: userOrUsername.fullName || userOrUsername.username,
          role: userOrUsername.role || 'viewer',
          permissions: normalizePermissions(userOrUsername.permissions, userOrUsername.role),
        };
  sessions.set(token, { ...user, expiresAt });
  return { token, ...user, expiresAt };
}

export function hasPermission(session, perm) {
  if (!session) return false;
  if (session.role === 'super_admin') return true;
  if (!perm) return true;
  return Array.isArray(session.permissions) && session.permissions.includes(perm);
}

export function syncUserSessions(username, updatedUser) {
  const target = String(username || '').toLowerCase();
  for (const [token, sess] of sessions.entries()) {
    if (String(sess.username || '').toLowerCase() !== target) continue;
    if (!updatedUser || updatedUser.isActive === false) {
      sessions.delete(token);
    } else {
      sessions.set(token, {
        ...sess,
        fullName: updatedUser.fullName || updatedUser.username,
        role: updatedUser.role,
        permissions: normalizePermissions(updatedUser.permissions, updatedUser.role),
      });
    }
  }
}

export function revokeUserSessions(username) {
  syncUserSessions(username, null);
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
