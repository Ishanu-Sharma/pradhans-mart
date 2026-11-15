import { $, $$, api, money, esc, setError, showAlert, liveStream, formatTime, productImage } from './common.js';

const login = $('#login');
const dash = $('#dashboard');
const logout = $('[data-logout]');
const announcer = $('#announcer');
const ACTIVE = ['placed', 'accepted', 'packed', 'rider_assigned', 'out_for_delivery'];
const orders = new Map();
let categories = [];

// ---------- tabs ----------
const tabs = $$('[role="tab"]', $('.tabs'));
const loaders = {};
function selectTab(tab, focus = true) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
  }
  if (focus) tab.focus();
  loaders[tab.id]?.();
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

// ---------- overview ----------
async function loadStats() {
  const s = await api('/api/admin/overview');
  const stat = (n, label, alert) => `<div class="stat${alert ? ' stat-alert' : ''}"><strong>${n}</strong><span>${label}</span></div>`;
  $('#stats').innerHTML = [
    stat(s.activeOrders, 'Orders in progress'),
    stat(s.waitingForStore, 'Waiting for a store', s.waitingForStore > 0),
    stat(s.waitingForRider, 'Waiting for a delivery partner', s.waitingForRider > 0),
    stat(`${s.stores.online} of ${s.stores.total}`, 'Stores accepting orders'),
    stat(`${s.riders.online} of ${s.riders.total}`, 'Delivery partners online'),
    stat(s.pending, 'Partners waiting for approval', s.pending > 0),
    stat(s.ordersToday, 'Orders today'),
    stat(s.customers, 'Customer accounts')
  ].join('');
  $('#pending-badge').hidden = s.pending === 0;
  $('#pending-badge').textContent = s.pending;
}
let statsTimer;
const statsSoon = () => { clearTimeout(statsTimer); statsTimer = setTimeout(() => loadStats().catch(() => {}), 400); };

// ---------- approvals and accounts ----------
const roleName = { rider: 'Delivery partner', store: 'Store partner', customer: 'Customer' };
async function loadApprovals() {
  const list = await api('/api/admin/users?role=pending');
  $('#approvals-list').innerHTML = list.length ? `<div class="board board-2">${list.map((u) => `<article class="job" data-user="${esc(u.id)}">
      <header><h3>${esc(u.storeName || u.name)}</h3><span class="tag tag-pending">${roleName[u.role]}</span></header>
      <p class="small">${u.role === 'store' ? `Owner ${esc(u.name)}. ${esc(u.storeStreet)}, Guwahati ${esc(u.storePincode)}.` : `Vehicle: ${esc(u.vehicle)}.`} Mobile ${esc(u.phone)}. Signed up ${esc(formatTime(u.createdAt))}.</p>
      <div class="actions">
        <button type="button" class="btn btn-secondary btn-small" data-status="rejected">Reject</button>
        <button type="button" class="btn btn-primary btn-small" data-status="active">Approve</button>
      </div></article>`).join('')}</div>`
    : '<div class="panel"><p class="empty-state">No partners are waiting for approval.</p></div>';
}
async function loadUsers(role, containerId) {
  const list = await api(`/api/admin/users?role=${role}`);
  const cols = role === 'store'
    ? ['Store', 'Owner and mobile', 'Area', 'Status', 'Orders']
    : role === 'rider' ? ['Name', 'Mobile', 'Vehicle', 'Status', 'Deliveries'] : ['Name', 'Mobile', 'Joined', 'Status', 'Orders'];
  const row = (u) => {
    const status = `<span class="tag tag-${esc(u.status)}">${esc(u.status)}</span>${u.role !== 'customer' && u.status === 'active' ? ` <span class="tag tag-${u.online ? 'online' : 'offline'}">${u.online ? 'online' : 'offline'}</span>` : ''}`;
    const action = u.status === 'active' ? `<button type="button" class="btn btn-danger btn-small" data-status="suspended" aria-label="Suspend ${esc(u.storeName || u.name)}">Suspend</button>`
      : (u.status === 'suspended' || u.status === 'rejected') ? `<button type="button" class="btn btn-secondary btn-small" data-status="active" aria-label="Reactivate ${esc(u.storeName || u.name)}">Reactivate</button>`
        : u.status === 'pending' ? '<span class="small muted">See Approvals</span>' : '';
    const cells = role === 'store' ? [esc(u.storeName), `${esc(u.name)}<br><span class="small muted">${esc(u.phone)}</span>`, `${esc(u.storeStreet)}, ${esc(u.storePincode)}`]
      : role === 'rider' ? [esc(u.name), esc(u.phone), esc(u.vehicle)] : [esc(u.name), esc(u.phone), esc(formatTime(u.createdAt))];
    return `<tr data-user="${esc(u.id)}">${cells.map((c, i) => (i === 0 ? `<th scope="row">${c}</th>` : `<td>${c}</td>`)).join('')}<td>${status}</td><td class="num">${u.orders}</td><td>${action}</td></tr>`;
  };
  $(`#${containerId}`).innerHTML = list.length
    ? `<table class="data-table"><thead><tr>${cols.map((c) => `<th scope="col">${c}</th>`).join('')}<th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead><tbody>${list.map(row).join('')}</tbody></table>`
    : '<div class="panel"><p class="empty-state">No accounts yet.</p></div>';
}
async function setUserStatus(btn, alertEl) {
  const id = btn.closest('[data-user]').dataset.user;
  if (btn.dataset.status === 'suspended' && !btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = 'Press again to suspend'; return; }
  btn.disabled = true;
  try {
    const u = await api(`/api/admin/users/${id}/status`, { method: 'POST', body: { status: btn.dataset.status } });
    const verb = { active: 'approved and active', rejected: 'rejected', suspended: 'suspended. They have been signed out' }[u.status];
    showAlert(alertEl, 'success', `${u.storeName || u.name} is ${verb}.`, '');
    loadStats();
    return true;
  } catch (err) {
    btn.disabled = false;
    showAlert(alertEl, 'error', 'That did not work.', err.message);
    return false;
  }
}
$('#approvals-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-status]');
  if (btn && await setUserStatus(btn, $('#approvals-alert'))) loadApprovals();
});
for (const [panel, role, alertId] of [['stores-table', 'store', 'stores-alert'], ['riders-table', 'rider', 'riders-alert'], ['customers-table', 'customer', 'customers-alert']]) {
  $(`#${panel}`).addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-status]');
    if (btn && await setUserStatus(btn, $(`#${alertId}`))) loadUsers(role, panel);
  });
}

// ---------- orders ----------
function orderCard(o) {
  const c = o.customer || {};
  const offer = o.offer ? `<p class="small"><strong>Offered to ${esc(o.offer.to)}</strong>, waiting for a reply.</p>` : (o.waiting ? `<p class="small">${esc(o.waiting)}</p>` : '');
  return `<article class="job" data-order="${esc(o.id)}">
    <header><h3>${esc(o.id)}</h3><span class="tag tag-${esc(o.status)}">${esc(o.statusLabel)}</span></header>
    <p class="small muted">Placed ${esc(formatTime(o.createdAt))}. ${((n) => `${n} ${n === 1 ? 'item' : 'items'}`)(o.items.reduce((n, i) => n + i.qty, 0))}, ${money(o.total)} (${esc(o.payment)}).</p>
    ${o.anonymized ? '<p class="small muted">Customer details deleted at the customer\'s request.</p>' : `<p class="small">${esc(c.name)}, ${esc(c.phone)}. ${c.street ? `${esc(c.street)}, ${esc(c.pincode)}` : 'Address deleted under the retention rule'}</p>`}
    <p class="small">Store: <strong>${esc(o.storeName || 'not yet')}</strong>. Delivery partner: <strong>${esc(o.riderName || 'not yet')}</strong>.</p>
    ${offer}
    ${o.cancelReason ? `<p class="small muted">${esc(o.cancelReason)}</p>` : ''}
    ${o.canCancel ? '<div class="actions"><button type="button" class="btn btn-danger btn-small" data-cancel>Cancel order</button></div>' : ''}
  </article>`;
}
function filtered() {
  const f = $('#order-filter').value;
  return [...orders.values()].filter((o) => f === 'all' || (f === 'active' ? ACTIVE.includes(o.status) : !ACTIVE.includes(o.status)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function renderOrders() {
  const list = filtered();
  $('#order-list').innerHTML = list.length ? `<div class="board board-2">${list.map(orderCard).join('')}</div>` : '<div class="panel"><p class="empty-state">No orders here.</p></div>';
}
function updateOrder(o) {
  const isNew = !orders.has(o.id);
  orders.set(o.id, o);
  if (isNew) announcer.textContent = `New order ${o.id}, ${money(o.total)}`;
  const el = $(`[data-order="${CSS.escape(o.id)}"]`);
  if (el && filtered().some((x) => x.id === o.id) && !el.contains(document.activeElement)) el.outerHTML = orderCard(o);
  else if (!el || !filtered().some((x) => x.id === o.id)) { if (!$('#order-list').contains(document.activeElement)) renderOrders(); }
  statsSoon();
}
$('#order-filter').addEventListener('change', renderOrders);
$('#order-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-cancel]');
  if (!btn) return;
  if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = 'Press again to cancel'; return; }
  const id = btn.closest('[data-order]').dataset.order;
  btn.disabled = true;
  try { const o = await api(`/api/admin/orders/${id}/cancel`, { method: 'POST', body: {} }); orders.set(o.id, o); renderOrders(); }
  catch (err) { btn.disabled = false; btn.textContent = err.message; }
});

// ---------- catalogue ----------
function productRow(p) {
  const cat = categories.find((c) => c.id === p.category)?.name || p.category;
  return `<tr data-product="${esc(p.id)}">
    <td>${productImage(p, 40)}</td>
    <th scope="row">${esc(p.name)}<br><span class="small muted">${esc(p.brand)}, ${esc(p.netQuantity)}, ${esc(cat)}</span></th>
    <td><label class="visually-hidden" for="mrp-${esc(p.id)}">MRP for ${esc(p.name)}</label><input class="input" type="number" min="0" step="0.01" id="mrp-${esc(p.id)}" data-field="mrp" value="${p.mrp}"></td>
    <td><label class="visually-hidden" for="price-${esc(p.id)}">Price for ${esc(p.name)}</label><input class="input" type="number" min="0" step="0.01" id="price-${esc(p.id)}" data-field="price" value="${p.price}"></td>
    <td><div class="check"><input type="checkbox" id="active-${esc(p.id)}" data-field="active"${p.active ? ' checked' : ''}><label for="active-${esc(p.id)}"><span class="visually-hidden">${esc(p.name)} </span>On sale</label></div></td>
    <td><button type="button" class="btn btn-secondary btn-small" data-save aria-label="Save ${esc(p.name)}">Save</button></td>
  </tr>`;
}
async function loadProducts() {
  const res = await api('/api/admin/products');
  categories = res.categories;
  $('#product-rows').innerHTML = res.products.map(productRow).join('');
  $('#ap-category').innerHTML = '<option value="">Choose a category</option>' + categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
}
$('#product-rows').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-save]');
  if (!btn) return;
  const row = btn.closest('tr');
  const payload = {};
  for (const input of $$('[data-field]', row)) payload[input.dataset.field] = input.type === 'checkbox' ? input.checked : Number(input.value);
  btn.disabled = true;
  try {
    const p = await api(`/api/admin/products/${row.dataset.product}`, { method: 'POST', body: payload });
    showAlert($('#products-alert'), 'success', `Saved ${p.name}.`, '');
  } catch (err) {
    showAlert($('#products-alert'), 'error', 'Not saved.', err.data?.fields ? Object.values(err.data.fields).join(' ') : err.message);
  } finally { btn.disabled = false; }
});
const addForm = $('#add-product');
addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fields = ['name', 'brand', 'brandOwner', 'category', 'netQuantity', 'mrp', 'price', 'packer'];
  const payload = Object.fromEntries(fields.map((f) => [f, $(`#ap-${f}`).value]));
  for (const k of ['mrp', 'price']) payload[k] = payload[k] === '' ? NaN : Number(payload[k]);
  payload.indianBrandConfirmed = $('#ap-indianBrandConfirmed').checked;
  for (const f of [...fields, 'indianBrandConfirmed']) setError($(`#ap-${f}`), '');
  try {
    const p = await api('/api/admin/products', { method: 'POST', body: payload });
    addForm.reset();
    await loadProducts();
    showAlert($('#products-alert'), 'success', `Added ${p.name}.`, 'Stores can now set stock for it.');
    $('#products-alert').scrollIntoView({ block: 'nearest' });
  } catch (err) {
    if (err.data?.fields) {
      for (const [k, msg] of Object.entries(err.data.fields)) { const el = $(`#ap-${k}`); if (el) setError(el, msg); }
      addForm.querySelector('[aria-invalid="true"]')?.focus();
    } else showAlert($('#products-alert'), 'error', 'Not added.', err.message);
  }
});

// ---------- data requests ----------
async function loadRequests() {
  const res = await api('/api/admin/requests');
  const rows = res.requests.map((r) => `<tr><td>${esc(formatTime(r.at))}</td><td>${esc(r.type)}</td><td class="num">${r.orders}</td><td>${esc(r.result)}</td></tr>`).join('');
  $('#requests-body').innerHTML = `<div class="panel">
    <p>Requests are handled automatically when the person proves the data is theirs. This log keeps no names or numbers.</p>
    <div class="stat-row"><div class="stat"><strong>${res.subscribers}</strong><span>Email subscribers</span></div><div class="stat"><strong>${res.outbox}</strong><span>Emails waiting in the outbox</span></div></div>
    <div class="table-scroll"><table class="data-table"><caption class="visually-hidden">Data requests, newest first</caption>
    <thead><tr><th scope="col">When</th><th scope="col">Request</th><th scope="col" class="num">Orders covered</th><th scope="col">Result</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4" class="muted">No requests yet.</td></tr>'}</tbody></table></div></div>`;
}

Object.assign(loaders, {
  'tab-approvals': () => loadApprovals().catch(() => {}),
  'tab-orders': () => renderOrders(),
  'tab-stores': () => loadUsers('store', 'stores-table').catch(() => {}),
  'tab-riders': () => loadUsers('rider', 'riders-table').catch(() => {}),
  'tab-customers': () => loadUsers('customer', 'customers-table').catch(() => {}),
  'tab-catalogue': () => loadProducts().catch(() => {}),
  'tab-requests': () => loadRequests().catch(() => {})
});

// ---------- start ----------
async function enter() {
  try { await api('/api/admin/me'); } catch { login.hidden = false; dash.hidden = true; $('#password').focus(); return; }
  login.hidden = true; dash.hidden = false; logout.hidden = false;
  $('[data-app-user]').textContent = 'Administrator';
  for (const o of await api('/api/admin/orders')) orders.set(o.id, o);
  await Promise.all([loadStats(), loadApprovals()]);
  liveStream('/api/admin/stream', {
    order: updateOrder,
    users: () => { statsSoon(); if (!$('#panel-approvals').hidden) loadApprovals().catch(() => {}); }
  }, $('#live-state'));
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

enter();
