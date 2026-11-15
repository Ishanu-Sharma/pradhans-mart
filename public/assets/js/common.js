// Shared browser code: storage, cart, cookie consent, form validation, API calls, live updates.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 });
export const money = (n) => inr.format(n);

export const icon = (name, cls = 'icon') => `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="/assets/icons.svg#${name}"></use></svg>`;
export const productImage = (p, size = 160) => (p.image
  ? `<img src="${esc(p.image)}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async">`
  : icon(`cat-${p.category}`, 'placeholder'));

// Storage can be unavailable (private windows, blocked site data). Never let that break the page.
export const storage = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } }
};

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    const err = new Error('We could not reach the server. Check your internet connection and try again.');
    err.status = 0; throw err;
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const err = new Error(data?.error || 'Something went wrong. Please try again.');
    err.status = res.status; err.data = data || {};
    throw err;
  }
  return data;
}

// ---------- consent ----------
export const consent = () => storage.get('pm_consent', null);
export const preferencesAllowed = () => consent()?.preferences === true;

function setConsent(preferences) {
  storage.set('pm_consent', { preferences, at: new Date().toISOString() });
  if (!preferences) storage.remove('pm_area');
}

function initCookieBanner() {
  const banner = document.getElementById('cookie-banner');
  if (!banner) return;
  if (!consent()) banner.hidden = false;
  banner.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-consent]');
    if (!btn) return;
    setConsent(btn.dataset.consent === 'all');
    banner.hidden = true;
    document.getElementById('main')?.focus({ preventScroll: true });
  });
  for (const opener of $$('[data-cookie-settings]')) {
    opener.addEventListener('click', () => {
      banner.hidden = false;
      const current = consent();
      const target = banner.querySelector(`[data-consent="${current?.preferences ? 'all' : 'necessary'}"]`);
      (target || banner.querySelector('button')).focus();
    });
  }
}

// ---------- cart ----------
const listeners = new Set();
export const cart = {
  items() {
    const v = storage.get('pm_cart', []);
    return Array.isArray(v) ? v.filter((i) => i && typeof i.id === 'string' && Number.isInteger(i.qty) && i.qty > 0) : [];
  },
  qty(id) { return this.items().find((i) => i.id === id)?.qty || 0; },
  set(id, qty) {
    let items = this.items();
    const existing = items.find((i) => i.id === id);
    if (qty <= 0) items = items.filter((i) => i.id !== id);
    else if (existing) existing.qty = qty;
    else items.push({ id, qty });
    storage.set('pm_cart', items);
    this.changed();
  },
  clear() { storage.set('pm_cart', []); this.changed(); },
  count() { return this.items().reduce((n, i) => n + i.qty, 0); },
  onChange(fn) { listeners.add(fn); },
  changed() { updateCartLink(); for (const fn of listeners) fn(); }
};

export function updateCartLink(totalText) {
  const n = cart.count();
  const count = `${n} ${n === 1 ? 'item' : 'items'}`;
  const words = n === 0 ? 'My cart' : `${count}${totalText ? `, ${totalText}` : ''}`;
  for (const el of $$('[data-cart-summary]')) {
    el.innerHTML = n === 0 ? 'My cart' : `${esc(count)}${totalText ? `<span class="cart-total">, ${esc(totalText)}</span>` : ''}`;
  }
  for (const link of $$('[data-cart-link]')) {
    link.setAttribute('aria-label', n === 0 ? 'Cart, empty' : `Cart, ${words}`);
    link.toggleAttribute('data-empty', n === 0);
  }
}
window.addEventListener('storage', (e) => { if (e.key === 'pm_cart') cart.changed(); });

// ---------- orders saved on this device (data-request page) ----------
export const deviceOrders = {
  list() { const v = storage.get('pm_orders', []); return Array.isArray(v) ? v : []; },
  remove(id) { storage.set('pm_orders', this.list().filter((o) => o.id !== id)); }
};

// ---------- forms ----------
// Shows or clears the inline error for one field, wiring aria-invalid and aria-describedby.
export function setError(input, message) {
  const errorEl = document.getElementById(`${input.id}-error`);
  const ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean).filter((x) => x !== errorEl?.id);
  if (message) {
    input.setAttribute('aria-invalid', 'true');
    if (errorEl) { errorEl.textContent = message; errorEl.hidden = false; ids.push(errorEl.id); }
  } else {
    input.removeAttribute('aria-invalid');
    if (errorEl) { errorEl.textContent = ''; errorEl.hidden = true; }
  }
  if (ids.length) input.setAttribute('aria-describedby', ids.join(' ')); else input.removeAttribute('aria-describedby');
  const field = input.closest('.field');
  if (field && input.matches('input:not([type=checkbox]):not([type=radio]), select, textarea')) {
    field.classList.toggle('is-valid', !message && String(input.value).trim() !== '');
  }
  return !message;
}

// Validate on blur, then live while the person corrects an error.
export function liveValidate(input, check) {
  let touched = false;
  input.addEventListener('blur', () => { if (String(input.value).trim() !== '' || touched) { touched = true; setError(input, check(input.value)); } });
  input.addEventListener('input', () => { if (touched || input.getAttribute('aria-invalid') === 'true') setError(input, check(input.value)); });
  input.addEventListener('change', () => { if (input.tagName === 'SELECT') { touched = true; setError(input, check(input.value)); } });
}

export function focusFirstError(form) {
  const bad = form.querySelector('[aria-invalid="true"]');
  if (bad) bad.focus();
  return !bad;
}

export function showAlert(el, kind, title, text) {
  el.innerHTML = `<div class="notice notice-${kind}">${title ? `<strong>${esc(title)}</strong>` : ''}${text ? `<p>${esc(text)}</p>` : ''}</div>`;
}

// ---------- live connection ----------
export function liveStream(url, handlers, stateEl) {
  const setState = (live) => {
    if (!stateEl) return;
    stateEl.hidden = false;
    stateEl.dataset.state = live ? 'live' : 'off';
    stateEl.textContent = live ? 'Live' : 'Reconnecting';
  };
  const es = new EventSource(url);
  es.onopen = () => { setState(true); handlers.open?.(); };
  es.onerror = () => setState(false);
  for (const [event, fn] of Object.entries(handlers)) {
    if (event === 'open') continue;
    es.addEventListener(event, (e) => { try { fn(JSON.parse(e.data)); } catch { /* ignore bad frame */ } });
  }
  return { close: () => es.close() };
}

export function formatTime(iso) {
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' });
}

// A shrinking bar and a seconds count for an offer that expires.
export function countdownHtml(expiresAt, totalMs) {
  return `<div class="countdown" data-expires="${esc(expiresAt)}" data-total="${totalMs}"><div class="countdown-bar"><span></span></div><p></p></div>`;
}
export function tickCountdowns(root = document) {
  for (const el of $$('.countdown', root)) {
    const left = Math.max(0, Date.parse(el.dataset.expires) - Date.now());
    const total = Number(el.dataset.total) || 60000;
    el.querySelector('span').style.width = `${Math.min(100, (left / total) * 100)}%`;
    el.querySelector('p').textContent = left > 0 ? `${Math.ceil(left / 1000)} seconds to respond` : 'Time is up. Passing to the next partner.';
  }
}

let configPromise;
export const getConfig = () => (configPromise ||= api('/api/config'));

// Sign-out buttons in partner and admin headers.
for (const btn of $$('[data-logout]')) {
  btn.addEventListener('click', async () => {
    const admin = window.location.pathname === '/admin';
    await api(admin ? '/api/admin/logout' : '/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    window.location.href = admin ? '/admin' : '/login';
  });
}

initCookieBanner();
updateCartLink();
