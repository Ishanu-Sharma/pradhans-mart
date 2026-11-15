import { $, $$, api, money, esc, setError, showAlert, liveStream, formatTime } from './common.js';
import { rules } from './validators.js';

const login = $('#login');
const dash = $('#dashboard');
const logout = $('[data-logout]');
const announcer = $('#announcer');
const ACTION_LABEL = { accepted: 'Accept order', packed: 'Mark packed', out_for_delivery: 'Send out with rider', delivered: 'Mark delivered', cancelled: 'Cancel order' };
const ACTIVE = ['placed', 'accepted', 'packed', 'out_for_delivery'];

const orders = new Map();
let riders = [];
let products = [];
let categories = [];
const seenNew = new Set();

// ---------- tabs ----------
const tabs = $$('[role="tab"]');
function selectTab(tab, focus = true) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
  }
  if (focus) tab.focus();
  if (tab.id === 'tab-requests') loadRequests();
}
for (const t of tabs) {
  t.addEventListener('click', () => selectTab(t));
  t.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(t);
    let next = null;
    if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
    if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
    if (e.key === 'Home') next = tabs[0];
    if (e.key === 'End') next = tabs.at(-1);
    if (next) { e.preventDefault(); selectTab(next); }
  });
}

// ---------- orders ----------
function orderCard(o) {
  const c = o.customer || {};
  const riderOptions = ['<option value="">No rider</option>', ...riders.map((r) => `<option value="${esc(r.id)}"${r.id === o.riderId ? ' selected' : ''}>${esc(r.name)}</option>`)].join('');
  const canAssign = ACTIVE.includes(o.status);
  const loc = o.riderLocation ? `<p class="small muted">Rider location updated ${esc(formatTime(o.riderLocation.at))}</p>` : '';
  const actions = o.next.map((s) => `<button type="button" class="btn ${s === 'cancelled' ? 'btn-danger' : 'btn-primary'} btn-small" data-status="${s}">${ACTION_LABEL[s]}</button>`).join('');
  return `<article class="order-card" data-order="${esc(o.id)}"${o.status === 'placed' && seenNew.has(o.id) ? ' data-new' : ''}>
    <header><h3>${esc(o.id)}</h3><span class="tag tag-${esc(o.status)}">${esc(o.statusLabel)}</span></header>
    <p class="small muted">Placed ${esc(formatTime(o.createdAt))}</p>
    ${o.anonymized ? '<p class="muted">Customer details deleted at the customer\'s request.</p>' : `
    <p><strong>${esc(c.name)}</strong>, <a href="tel:+91${esc(c.phone)}">${esc(c.phone)}</a><br>
    ${c.house ? `${esc(c.house)}, ${esc(c.street)}${c.landmark ? `, near ${esc(c.landmark)}` : ''}, ${esc(c.pincode)}` : '<span class="muted">Address deleted under the retention rule</span>'}</p>`}
    <details><summary>${o.items.reduce((n, i) => n + i.qty, 0)} items, ${money(o.total)} (${esc(o.payment)})</summary>
      <ul>${o.items.map((i) => `<li>${i.qty} &times; ${esc(i.name)}, ${esc(i.netQuantity)}, ${money(i.price)} each</li>`).join('')}</ul>
      <p class="small">Items ${money(o.subtotal)}, delivery ${o.deliveryFee ? money(o.deliveryFee) : 'free'}.</p>
    </details>
    ${loc}
    <div class="actions">
      ${canAssign ? `<label class="visually-hidden" for="rider-${esc(o.id)}">Rider for ${esc(o.id)}</label><select class="input" id="rider-${esc(o.id)}" data-rider>${riderOptions}</select>` : (o.riderName ? `<span>Rider: ${esc(o.riderName)}</span>` : '')}
      ${actions}
    </div>
    <p class="error" id="err-${esc(o.id)}" hidden></p>
  </article>`;
}

function counts() {
  const all = [...orders.values()];
  const n = (s) => all.filter((o) => o.status === s).length;
  $('#order-counts').innerHTML = `
    <div><strong>${n('placed')}</strong> new</div>
    <div><strong>${n('accepted') + n('packed')}</strong> being packed</div>
    <div><strong>${n('out_for_delivery')}</strong> out for delivery</div>`;
}

function filtered() {
  const f = $('#order-filter').value;
  return [...orders.values()]
    .filter((o) => f === 'all' || (f === 'active' ? ACTIVE.includes(o.status) : !ACTIVE.includes(o.status)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function renderOrders() {
  const list = filtered();
  $('#order-list').innerHTML = list.length ? list.map(orderCard).join('') : '<p class="empty-state">No orders here.</p>';
  counts();
}

// Replace one card without moving keyboard focus.
function updateOrder(o) {
  const isNew = !orders.has(o.id);
  orders.set(o.id, o);
  if (isNew && o.status === 'placed') { seenNew.add(o.id); announcer.textContent = `New order ${o.id}, ${money(o.total)}`; }
  const el = $(`[data-order="${CSS.escape(o.id)}"]`);
  const shouldShow = filtered().some((x) => x.id === o.id);
  if (!el || !shouldShow) { const keep = document.activeElement?.closest('[data-order]') ? null : document.activeElement; renderOrders(); keep?.focus?.(); return; }
  const active = document.activeElement;
  const focusKey = el.contains(active) ? (active.dataset.status ? `[data-status="${active.dataset.status}"]` : active.matches('[data-rider]') ? '[data-rider]' : null) : null;
  el.outerHTML = orderCard(o);
  if (focusKey) $(`[data-order="${CSS.escape(o.id)}"] ${focusKey}`)?.focus();
  counts();
}

$('#order-filter').addEventListener('change', renderOrders);

$('#order-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-status]');
  if (!btn) return;
  const card = btn.closest('[data-order]');
  const id = card.dataset.order;
  if (btn.dataset.status === 'cancelled' && !btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = 'Press again to cancel';
    return;
  }
  btn.disabled = true;
  try {
    const o = await api(`/api/admin/orders/${id}/status`, { method: 'POST', body: { status: btn.dataset.status } });
    seenNew.delete(id);
    updateOrder(o);
  } catch (err) {
    btn.disabled = false;
    const errEl = $(`#err-${CSS.escape(id)}`);
    errEl.textContent = err.message; errEl.hidden = false;
  }
});

$('#order-list').addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-rider]');
  if (!sel) return;
  const id = sel.closest('[data-order]').dataset.order;
  try {
    const o = await api(`/api/admin/orders/${id}/rider`, { method: 'POST', body: { riderId: sel.value || null } });
    updateOrder(o);
    announcer.textContent = sel.value ? `Rider assigned to ${id}` : `Rider removed from ${id}`;
  } catch (err) {
    const errEl = $(`#err-${CSS.escape(id)}`);
    errEl.textContent = err.message; errEl.hidden = false;
  }
});

// ---------- products ----------
function productRow(p) {
  const cat = categories.find((c) => c.id === p.category)?.name || p.category;
  return `<tr data-product="${esc(p.id)}">
    <th scope="row">${esc(p.name)}<br><span class="small muted">${esc(p.brand)}, ${esc(p.netQuantity)}, ${esc(cat)}</span></th>
    <td><label class="visually-hidden" for="mrp-${esc(p.id)}">MRP for ${esc(p.name)}</label><input class="input" type="number" min="0" step="0.01" id="mrp-${esc(p.id)}" data-field="mrp" value="${p.mrp}"></td>
    <td><label class="visually-hidden" for="price-${esc(p.id)}">Price for ${esc(p.name)}</label><input class="input" type="number" min="0" step="0.01" id="price-${esc(p.id)}" data-field="price" value="${p.price}"></td>
    <td><label class="visually-hidden" for="stock-${esc(p.id)}">Stock for ${esc(p.name)}</label><input class="input" type="number" min="0" step="1" id="stock-${esc(p.id)}" data-field="stock" value="${p.stock}"></td>
    <td><div class="check"><input type="checkbox" id="active-${esc(p.id)}" data-field="active"${p.active ? ' checked' : ''}><label for="active-${esc(p.id)}"><span class="visually-hidden">${esc(p.name)} </span>On sale</label></div></td>
    <td><button type="button" class="btn btn-secondary btn-small" data-save aria-label="Save ${esc(p.name)}">Save</button></td>
  </tr>`;
}

async function loadProducts() {
  const res = await api('/api/admin/products');
  products = res.products; categories = res.categories;
  $('#product-rows').innerHTML = products.map(productRow).join('');
  $('#ap-category').innerHTML = '<option value="">Choose a category</option>' + categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
}

$('#product-rows').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-save]');
  if (!btn) return;
  const row = btn.closest('tr');
  const id = row.dataset.product;
  const body = {};
  for (const input of $$('[data-field]', row)) body[input.dataset.field] = input.type === 'checkbox' ? input.checked : Number(input.value);
  btn.disabled = true;
  try {
    const p = await api(`/api/admin/products/${id}`, { method: 'POST', body });
    Object.assign(products.find((x) => x.id === id), p);
    showAlert($('#products-alert'), 'success', `Saved ${p.name}.`, '');
  } catch (err) {
    const msg = err.data?.fields ? Object.values(err.data.fields).join(' ') : err.message;
    showAlert($('#products-alert'), 'error', 'Not saved.', msg);
  } finally { btn.disabled = false; }
});

const addForm = $('#add-product');
addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fields = ['name', 'brand', 'brandOwner', 'category', 'netQuantity', 'stock', 'mrp', 'price', 'packer'];
  const body = Object.fromEntries(fields.map((f) => [f, $(`#ap-${f}`).value]));
  for (const k of ['stock', 'mrp', 'price']) body[k] = body[k] === '' ? NaN : Number(body[k]);
  body.indianBrandConfirmed = $('#ap-indianBrandConfirmed').checked;
  for (const f of [...fields, 'indianBrandConfirmed']) setError($(`#ap-${f}`), '');
  try {
    const p = await api('/api/admin/products', { method: 'POST', body });
    addForm.reset();
    await loadProducts();
    showAlert($('#products-alert'), 'success', `Added ${p.name}. It is on sale now.`, '');
    $('#products-alert').scrollIntoView({ block: 'nearest' });
  } catch (err) {
    if (err.data?.fields) {
      for (const [k, msg] of Object.entries(err.data.fields)) { const el = $(`#ap-${k}`); if (el) setError(el, msg); }
      addForm.querySelector('[aria-invalid="true"]')?.focus();
    } else showAlert($('#products-alert'), 'error', 'Not added.', err.message);
  }
});

// ---------- riders ----------
async function loadRiders() {
  riders = await api('/api/admin/riders');
  $('#rider-list').innerHTML = riders.length
    ? riders.map((r) => `<li><span>${esc(r.name)}</span><button type="button" class="btn btn-danger btn-small" data-remove-rider="${esc(r.id)}" aria-label="Remove rider ${esc(r.name)}">Remove</button></li>`).join('')
    : '<li><span class="muted">No riders yet. Add one below.</span></li>';
}

$('#rider-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-remove-rider]');
  if (!btn) return;
  if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = 'Press again to remove'; return; }
  try {
    await api(`/api/admin/riders/${btn.dataset.removeRider}/remove`, { method: 'POST', body: {} });
    await loadRiders(); renderOrders();
    showAlert($('#riders-alert'), 'success', 'Rider removed. Their code no longer works.', '');
  } catch (err) { showAlert($('#riders-alert'), 'error', 'Not removed.', err.message); }
});

$('#add-rider').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#ar-name');
  if (!setError(name, rules.name(name.value))) { name.focus(); return; }
  try {
    const r = await api('/api/admin/riders', { method: 'POST', body: { name: name.value } });
    name.value = '';
    await loadRiders(); renderOrders();
    $('#riders-alert').innerHTML = `<div class="notice notice-success"><strong>Rider code for ${esc(r.name)}</strong><p class="code-reveal">${esc(r.code)}</p><p>This code is shown only once. Give it to the rider in person. If it is lost, remove the rider and add them again.</p></div>`;
  } catch (err) { showAlert($('#riders-alert'), 'error', 'Not added.', err.message); }
});

// ---------- data requests ----------
async function loadRequests() {
  try {
    const res = await api('/api/admin/requests');
    const rows = res.requests.map((r) => `<tr><td>${esc(formatTime(r.at))}</td><td>${r.type === 'delete' ? 'Delete' : 'Download'}</td><td class="num">${r.orders}</td><td>${esc(r.result)}</td></tr>`).join('');
    $('#requests-body').innerHTML = `
      <p>Requests are handled automatically when the customer proves the data is theirs. This log keeps no names or numbers.</p>
      <div class="kpis"><div><strong>${res.subscribers}</strong> email subscribers</div><div><strong>${res.outbox}</strong> emails waiting in the outbox</div></div>
      <div class="table-scroll"><table class="data-table"><caption class="visually-hidden">Data requests, newest first</caption>
      <thead><tr><th scope="col">When</th><th scope="col">Request</th><th scope="col" class="num">Orders covered</th><th scope="col">Result</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="muted">No requests yet.</td></tr>'}</tbody></table></div>`;
  } catch (err) { showAlert($('#requests-body'), 'error', 'Could not load requests.', err.message); }
}

// ---------- start ----------
async function enter() {
  try { await api('/api/admin/me'); } catch { login.hidden = false; dash.hidden = true; $('#password').focus(); return; }
  login.hidden = true; dash.hidden = false; logout.hidden = false;
  await loadRiders();
  const list = await api('/api/admin/orders');
  for (const o of list) orders.set(o.id, o);
  renderOrders();
  await loadProducts();
  liveStream('/api/admin/stream', { order: updateOrder }, $('#live-state'));
}

login.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('#password');
  if (!setError(pw, pw.value ? '' : 'Enter the admin password.')) { pw.focus(); return; }
  try {
    await api('/api/admin/login', { method: 'POST', body: { password: pw.value } });
    pw.value = '';
    $('#login-alert').innerHTML = '';
    enter();
  } catch (err) { showAlert($('#login-alert'), 'error', err.message, ''); pw.focus(); }
});

logout.addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST', body: {} }).catch(() => {});
  window.location.reload();
});

enter();
