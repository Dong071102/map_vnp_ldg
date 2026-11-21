import { fetchAuthMe, logoutAdmin } from './api.js';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const FALLBACK_PERMISSIONS = [
  { key: 'view_map', label: 'Chỉ xem bản đồ & địa giới' },
  { key: 'view_bcvh', label: 'Xem danh sách & xuất Excel BCVH' },
  { key: 'edit_bcvh', label: 'Thêm / sửa / xóa thông tin BCVH' },
  { key: 'view_routes', label: 'Xem khu vực phát & tuyến đường' },
  { key: 'edit_routes', label: 'Gộp / tạo / sửa / xóa khu vực phát' },
  { key: 'edit_admin_boundaries', label: 'Sửa địa giới xã/phường & huyện cũ' },
  { key: 'manage_users', label: 'Quản lý tài khoản & phân quyền' },
];

export function hasAuthPerm(auth, perm) {
  if (!auth) return false;
  if (auth.role === 'super_admin') return true;
  return Array.isArray(auth.permissions) && auth.permissions.includes(perm);
}

/**
 * Mounts a unified Role & Permissions menu into a topbar container across /, /streets, /admin.
 * Shows clear visual distinction between Guest (Chỉ xem) and Authenticated roles, with a popover
 * listing exact allowed (✓) and restricted (✕) capabilities.
 */
export function createAuthMenu(container, { showAdminLink = true, onLogout } = {}) {
  if (!container) return { update: () => {}, load: async () => null };

  const wrap = document.createElement('div');
  wrap.className = 'auth-menu-wrap';

  const triggerBtn = document.createElement('button');
  triggerBtn.type = 'button';
  triggerBtn.className = 'role-pill-btn role-guest';
  triggerBtn.setAttribute('aria-expanded', 'false');
  triggerBtn.setAttribute('aria-haspopup', 'true');
  triggerBtn.title = 'Xem chi tiết vai trò và các chức năng được phép';

  const loginLink = document.createElement('a');
  loginLink.className = 'btn small primary auth-login-link';
  loginLink.href = '/admin';
  loginLink.textContent = 'Đăng nhập';
  loginLink.hidden = true;

  const popover = document.createElement('div');
  popover.className = 'role-popover';
  popover.hidden = true;

  wrap.append(triggerBtn, loginLink, popover);
  container.appendChild(wrap);

  let currentAuth = null;

  function closePopover() {
    popover.hidden = true;
    triggerBtn.setAttribute('aria-expanded', 'false');
  }

  function render(auth) {
    currentAuth = auth || {
      authenticated: false,
      isGuest: true,
      username: null,
      fullName: 'Khách truy cập',
      role: 'guest',
      roleLabel: 'Khách (Chỉ xem)',
      roleDescription: 'Xem bản đồ địa giới, tra cứu BCVH và khu vực phát; cần đăng nhập để chỉnh sửa.',
      permissions: ['view_map', 'view_bcvh', 'view_routes'],
      allPermissions: FALLBACK_PERMISSIONS,
    };

    const isAuthed = Boolean(currentAuth.authenticated);
    const roleKey = currentAuth.role || (isAuthed ? 'viewer' : 'guest');
    const roleLabel = currentAuth.roleLabel || (isAuthed ? roleKey : 'Khách (Chỉ xem)');
    const allPerms =
      Array.isArray(currentAuth.allPermissions) && currentAuth.allPermissions.length
        ? currentAuth.allPermissions
        : FALLBACK_PERMISSIONS;
    const allowedCount = allPerms.filter((p) => hasAuthPerm(currentAuth, p.key)).length;

    triggerBtn.className = `role-pill-btn role-${roleKey}`;
    triggerBtn.innerHTML = isAuthed
      ? `<span class="role-dot"></span><span class="role-pill-user">${escapeHtml(currentAuth.username)}</span><span class="role-pill-sep">·</span><span class="role-pill-name">${escapeHtml(roleLabel)}</span><span class="role-pill-caret">▾</span>`
      : `<span class="role-dot"></span><span class="role-pill-name">${escapeHtml(roleLabel)}</span><span class="role-pill-caret">▾</span>`;

    // Show quick login button right next to Guest pill on / and /streets
    loginLink.hidden = isAuthed || !showAdminLink;

    const rowsHtml = allPerms
      .map((p) => {
        const ok = hasAuthPerm(currentAuth, p.key);
        return `
          <li class="role-perm-row ${ok ? 'is-allowed' : 'is-denied'}">
            <span class="role-perm-mark" aria-hidden="true">${ok ? '✓' : '✕'}</span>
            <span>${escapeHtml(p.label)}</span>
          </li>
        `;
      })
      .join('');

    const footerHtml = isAuthed
      ? `<div class="role-popover-footer">
           ${showAdminLink ? '<a class="btn small" href="/admin">Trang Quản trị</a>' : '<span></span>'}
           <button type="button" class="btn small danger-ghost auth-popover-logout">Đăng xuất</button>
         </div>`
      : `<div class="role-popover-footer">
           <span class="role-guest-note">Chưa đăng nhập</span>
           <a class="btn small primary" href="/admin">Đăng nhập tài khoản</a>
         </div>`;

    popover.innerHTML = `
      <div class="role-popover-head">
        <div class="role-popover-title-row">
          <strong>${escapeHtml(isAuthed ? currentAuth.fullName || currentAuth.username : 'Chế độ Khách')}</strong>
          <span class="role-badge role-${escapeHtml(roleKey)}">${escapeHtml(roleLabel)}</span>
        </div>
        ${isAuthed ? `<div class="role-popover-sub">Tài khoản: <code>${escapeHtml(currentAuth.username)}</code></div>` : ''}
        ${currentAuth.roleDescription ? `<p class="role-popover-desc">${escapeHtml(currentAuth.roleDescription)}</p>` : ''}
      </div>
      <div class="role-popover-section">
        <div class="role-popover-section-head">
          <span>Quyền hạn chức năng</span>
          <span class="tab-count">${allowedCount}/${allPerms.length}</span>
        </div>
        <ul class="role-perm-list">${rowsHtml}</ul>
      </div>
      ${footerHtml}
    `;

    popover.querySelector('.auth-popover-logout')?.addEventListener('click', async () => {
      closePopover();
      try {
        await logoutAdmin();
      } finally {
        if (onLogout) {
          onLogout();
        } else {
          window.location.reload();
        }
      }
    });
  }

  triggerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const nextOpen = popover.hidden;
    popover.hidden = !nextOpen;
    triggerBtn.setAttribute('aria-expanded', String(nextOpen));
  });

  document.addEventListener('click', (e) => {
    if (!popover.hidden && !wrap.contains(e.target)) closePopover();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !popover.hidden) closePopover();
  });

  return {
    update: (auth) => render(auth),
    load: async () => {
      try {
        const me = await fetchAuthMe();
        render(me);
        return me;
      } catch {
        render(null);
        return null;
      }
    },
    getAuth: () => currentAuth,
  };
}
