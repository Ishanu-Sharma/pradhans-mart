import { $, $$, api, money, esc, showAlert, liveStream, formatTime, countdownHtml, tickCountdowns, productImage } from './common.js';

const STORE_OFFER_MS = 60_000;
const alertBox = $('#app-alert');
const sw = $('#online-switch');
const images = new Map();
let state = null;
let seenOffers = new Set();
let stockDirty = false;

// ---------- tabs ----------
const tabs = $$('[role="tab"]', $('.tabs'));
function selectTab(tab, focus = true) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
  }
  if (focus) tab.focus();
}
for (const t of tabs) {
  t.addEventListener('click', () => selectTab(t));
  t.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(t);
    const n = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length] : null;
    if (n) { e.preventDefault(); selectTab(n); }
  });
}

// ---------- rendering ----------
const items = (o) => `<ul class="item-list">${o.items.map((i) => `<li>${productImage({ image: images.get(i.id), category: 'staples' }, 36)}<span class="qty">${i.qty} &times;</span><span>${esc(i.name)}, ${esc(i.netQuantity)}</span></li>`).join('')}</ul>`;
const head = (o) => `<header><h3>${esc(o.id)}</h3><span class="tag tag-${esc(o.status)}">${esc(o.statusLabel)}</span></header>
  <p class="small muted">${esc(formatTime(o.createdAt))}. ${o.itemCount} ${o.itemCount === 1 ? "item" : "items"}, ${money(o.total)} (${esc(o.payment)}). Delivery to ${esc(o.pincode || '')}.</p>`;

function offerCard(o) {
  return `<article class="job job-offer" data-order="${esc(o.id)}">${head(o)}${items(o)}
    ${countdownHtml(o.offerExpiresAt, STORE_OFFER_MS)}
    <div class="actions">
      <button type="button" class="btn btn-secondary btn-small" data-act="decline">Decline</button>
      <button type="button" class="btn btn-primary btn-small" data-act="accept">Accept order</button>
    </div></article>`;
}
function packCard(o) {
  return `<article class="job" data-order="${esc(o.id)}">${head(o)}${items(o)}
    <div class="actions"><button type="button" class="btn btn-success btn-small" data-act="packed">Mark packed</button></div></article>`;
}
function handCard(o) {
  const who = o.rider ? `${esc(o.rider.name)} (${esc(o.rider.vehicle)}) is coming to collect it.` : esc(o.waiting || 'Finding a delivery partner.');
  return `<article class="job" data-order="${esc(o.id)}">${head(o)}<p class="small">${who}</p></article>`;
}
function doneCard(o) {
  return `<article class="job" data-order="${esc(o.id)}">${head(o)}</article>`;
}
function fill(listId, countId, list, fn, emptyText) {
  $(`#${countId}`).textContent = list.length;
  $(`#${listId}`).innerHTML = list.length ? list.map(fn).join('') : `<p class="empty-state small">${emptyText}</p>`;
}

function render(d) {
  state = d;
  for (const p of d.stock) images.set(p.id, p.image);
  const s = d.store;
  $('[data-app-user]').textContent = s.name;
  if (s.status !== 'active') { $('#pending').hidden = false; $('#workspace').hidden = true; return; }
  $('#pending').hidden = true; $('#workspace').hidden = false;
  $('#store-title').textContent = s.storeName;
  $('#store-sub').textContent = `${s.storeStreet}, Guwahati ${s.storePincode}`;
  sw.setAttribute('aria-checked', String(s.online));
  $('#online-label').textContent = s.online ? 'Accepting orders' : 'Not accepting orders';

  const keep = document.activeElement?.closest('[data-order]') ? { id: document.activeElement.closest('[data-order]').dataset.order, act: document.activeElement.dataset.act } : null;
  fill('list-new', 'count-new', d.offers, offerCard, s.online ? 'New orders appear here. Each request waits 60 seconds for you.' : 'Turn on "Accepting orders" to receive requests.');
  fill('list-pack', 'count-pack', d.toPack, packCard, 'Nothing to pack.');
  fill('list-hand', 'count-hand', d.handover, handCard, 'No orders waiting for pickup.');
  fill('list-done', 'count-done', d.done, doneCard, 'Nothing handed over yet today.');
  $('#offer-badge').hidden = d.offers.length === 0;
  $('#offer-badge').textContent = d.offers.length;
  const fresh = d.offers.filter((o) => !seenOffers.has(o.id));
  if (fresh.length) $('#announcer').textContent = `New order request ${fresh[0].id}, ${fresh[0].itemCount} items. You have 60 seconds to accept.`;
  seenOffers = new Set(d.offers.map((o) => o.id));
  if (keep) $(`[data-order="${CSS.escape(keep.id)}"] [data-act="${keep.act}"]`)?.focus();
  tickCountdowns();

  if (!stockDirty) {
    $('#stock-rows').innerHTML = d.stock.map((p) => `<tr>
      <td>${productImage(p, 40)}</td>
      <th scope="row">${esc(p.name)}<br><span class="small muted">${esc(p.brand)}, ${esc(p.netQuantity)}</span></th>
      <td class="num"><label class="visually-hidden" for="stock-${esc(p.id)}">Stock for ${esc(p.name)}</label><input class="input" type="number" min="0" step="1" id="stock-${esc(p.id)}" data-id="${esc(p.id)}" value="${p.stock}"></td>
    </tr>`).join('');
  }
}

async function refresh() {
  try { render(await api('/api/store/dashboard')); }
  catch (err) { if (err.status === 401) window.location.href = '/login?role=store'; else showAlert(alertBox, 'error', 'Could not load your orders.', err.message); }
}

// ---------- actions ----------
$('#panel-orders').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('[data-order]').dataset.order;
  btn.disabled = true;
  try {
    await api(`/api/store/orders/${id}/${btn.dataset.act}`, { method: 'POST', body: {} });
    const msg = { accept: `Order ${id} accepted. Pack it now.`, decline: `Order ${id} declined. It goes to another store.`, packed: `Order ${id} packed. We are finding a delivery partner.` }[btn.dataset.act];
    showAlert(alertBox, 'success', msg, '');
    await refresh();
  } catch (err) {
    btn.disabled = false;
    showAlert(alertBox, 'error', 'That did not work.', err.message);
    refresh();
  }
});

sw.addEventListener('click', async () => {
  const want = sw.getAttribute('aria-checked') !== 'true';
  sw.disabled = true;
  try {
    await api('/api/store/online', { method: 'POST', body: { online: want } });
    showAlert(alertBox, 'success', want ? 'You are accepting orders.' : 'You have stopped accepting new orders.', want ? 'New requests will appear under New requests.' : 'Orders you already accepted stay on your board.');
    await refresh();
  } catch (err) { showAlert(alertBox, 'error', 'Could not change your status.', err.message); }
  finally { sw.disabled = false; }
});

$('#stock-rows').addEventListener('input', () => { stockDirty = true; });
$('#stock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const stock = {};
  for (const input of $$('#stock-rows input')) {
    const n = Number(input.value);
    if (!Number.isInteger(n) || n < 0) { input.setAttribute('aria-invalid', 'true'); input.focus(); showAlert($('#stock-alert'), 'error', 'Stock must be a whole number of 0 or more.', ''); return; }
    input.removeAttribute('aria-invalid');
    stock[input.dataset.id] = n;
  }
  try {
    await api('/api/store/stock', { method: 'POST', body: { stock } });
    stockDirty = false;
    showAlert($('#stock-alert'), 'success', 'Stock saved.', 'Customers see the new availability straight away.');
    await refresh();
  } catch (err) { showAlert($('#stock-alert'), 'error', 'Stock not saved.', err.message); }
});

setInterval(() => tickCountdowns(), 1000);
refresh().then(() => liveStream('/api/stream/me', { refresh, open: refresh }));
