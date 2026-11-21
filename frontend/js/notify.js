// Unified Notification (toast) & Confirmation Notification (Đồng ý / Không) system

let stackEl = null;

function ensureStack() {
  if (stackEl && document.body.contains(stackEl)) return stackEl;
  stackEl = document.createElement('div');
  stackEl.className = 'app-noti-stack';
  stackEl.setAttribute('aria-live', 'polite');
  document.body.appendChild(stackEl);
  return stackEl;
}

const ICONS = {
  success: '✓',
  error: '!',
  warn: '!',
  info: 'i',
  danger: '!',
};

/**
 * Show an informational toast notification (chỉ thông báo, tự đóng sau vài giây).
 */
export function notify(message, { type = 'info', title = '', duration = 3800 } = {}) {
  if (!message) return;
  const stack = ensureStack();
  const safeType = ['success', 'error', 'warn', 'info'].includes(type) ? type : 'info';

  const card = document.createElement('div');
  card.className = `app-noti tone-${safeType}`;
  card.setAttribute('role', safeType === 'error' ? 'alert' : 'status');

  const icon = document.createElement('span');
  icon.className = 'app-noti-icon';
  icon.textContent = ICONS[safeType];

  const body = document.createElement('div');
  body.className = 'app-noti-body';
  if (title) {
    const t = document.createElement('div');
    t.className = 'app-noti-title';
    t.textContent = title;
    body.appendChild(t);
  }
  const msg = document.createElement('div');
  msg.className = 'app-noti-msg';
  msg.textContent = String(message);
  body.appendChild(msg);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'app-noti-close';
  closeBtn.setAttribute('aria-label', 'Đóng thông báo');
  closeBtn.textContent = '✕';

  card.append(icon, body, closeBtn);
  stack.appendChild(card);

  // Keep at most 4 stacked toasts
  while (stack.children.length > 4) {
    stack.firstElementChild?.remove();
  }

  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    card.classList.add('is-leaving');
    setTimeout(() => card.remove(), 160);
  };

  closeBtn.addEventListener('click', dismiss);
  if (duration > 0) {
    timer = setTimeout(dismiss, duration);
    card.addEventListener('mouseenter', () => clearTimeout(timer));
    card.addEventListener('mouseleave', () => {
      timer = setTimeout(dismiss, 1600);
    });
  }
  return dismiss;
}

/**
 * Show an interactive confirmation notification requiring user choice (Đồng ý / Không).
 * Returns Promise<boolean>.
 */
export function confirmNoti({
  title = 'Xác nhận thao tác',
  message = '',
  items = [],
  tone = 'warn',
  confirmText = 'Đồng ý',
  cancelText = 'Không',
} = {}) {
  return new Promise((resolve) => {
    const safeTone = ['danger', 'warn', 'info'].includes(tone) ? tone : 'warn';

    const backdrop = document.createElement('div');
    backdrop.className = 'app-confirm-backdrop';

    const dialog = document.createElement('div');
    dialog.className = `app-confirm-card tone-${safeTone}`;
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');

    const head = document.createElement('div');
    head.className = 'app-confirm-head';
    const icon = document.createElement('span');
    icon.className = 'app-noti-icon';
    icon.textContent = ICONS[safeTone];
    const titleEl = document.createElement('h3');
    titleEl.textContent = title;
    head.append(icon, titleEl);

    const content = document.createElement('div');
    content.className = 'app-confirm-content';
    if (message) {
      const p = document.createElement('p');
      p.textContent = message;
      content.appendChild(p);
    }
    if (Array.isArray(items) && items.length > 0) {
      const ul = document.createElement('ul');
      ul.className = 'app-confirm-list';
      for (const item of items) {
        const li = document.createElement('li');
        li.textContent = String(item);
        ul.appendChild(li);
      }
      content.appendChild(ul);
    }

    const actions = document.createElement('div');
    actions.className = 'app-confirm-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn small';
    cancelBtn.textContent = cancelText;

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = `btn small ${safeTone === 'danger' ? 'danger-solid' : 'primary'}`;
    okBtn.textContent = confirmText;

    actions.append(cancelBtn, okBtn);
    dialog.append(head, content, actions);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(val);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      }
    };

    cancelBtn.addEventListener('click', () => finish(false));
    okBtn.addEventListener('click', () => finish(true));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish(false);
    });
    window.addEventListener('keydown', onKey, true);
    okBtn.focus();
  });
}
