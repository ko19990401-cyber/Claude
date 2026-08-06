export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') node.setAttribute('style', value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * replaceChildren / append は null を文字列 "null" に変換してしまうので、
 * 条件付きの子要素（`cond ? el(...) : null`）を安全に扱うためのラッパ。
 */
const cleanChildren = (children) =>
  children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== '');

export const setChildren = (node, ...children) => {
  node.replaceChildren(...cleanChildren(children));
  return node;
};

export const addChildren = (node, ...children) => {
  node.append(...cleanChildren(children));
  return node;
};

export const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 秒 → HH:MM:SS */
export function formatTime(sec) {
  const total = Math.max(0, Math.floor(sec || 0));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/** 秒 → 「1時間30分」形式 */
export function formatDuration(sec) {
  const total = Math.round(sec || 0);
  if (total < 60) return `${total}秒`;
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  return h ? `${h}時間${m ? `${m}分` : ''}` : `${m}分`;
}

export function formatBytes(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)}${units[i]}`;
}

export function formatDateTime(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "00:12:34" → 754 */
export function parseTimestamp(text) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  return (Number(m[1] || 0) * 3600) + (Number(m[2]) * 60) + Number(m[3]);
}

export function debounce(fn, ms = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export const SPEAKER_COLORS = ['var(--sp-1)', 'var(--sp-2)', 'var(--sp-3)', 'var(--sp-4)', 'var(--sp-5)', 'var(--sp-6)'];

/** FR-04：6色ローテーション、7人目以降はグレースケール */
export function speakerColor(speakerId, speakers) {
  const index = speakers.findIndex((s) => s.id === speakerId);
  if (index < 0) return 'var(--sp-x)';
  return index < SPEAKER_COLORS.length ? SPEAKER_COLORS[index] : 'var(--sp-x)';
}

export function toast(message, type = '') {
  const host = document.getElementById('toasts');
  const node = el('div', { class: `toast ${type}` }, message);
  host.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 260);
  }, type === 'error' ? 6500 : 3200);
}

/** 完了時のブラウザ通知（§10.1）。 */
export async function notify(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch { /* 拒否されても続行 */ }
  }
  if (Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    new Notification(title, { body, icon: '/favicon.ico' });
  }
}

export function confirmDialog(message, { danger = false, confirmLabel = 'OK' } = {}) {
  return new Promise((resolve) => {
    const close = (value) => { backdrop.remove(); resolve(value); };
    const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => e.target === backdrop && close(false) },
      el('div', { class: 'modal', style: 'max-width:420px' },
        el('div', { class: 'content' }, el('p', { style: 'margin:0;white-space:pre-wrap' }, message)),
        el('footer', {},
          el('button', { class: 'btn', onclick: () => close(false) }, 'キャンセル'),
          el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => close(true) }, confirmLabel))));
    document.body.append(backdrop);
  });
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('コピーしました', 'ok');
  } catch {
    const area = el('textarea', { value: text, style: 'position:fixed;opacity:0' });
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    toast('コピーしました', 'ok');
  }
}
