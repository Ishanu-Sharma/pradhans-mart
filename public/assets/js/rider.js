import { $, api, money, esc, setError, showAlert, liveStream } from './common.js';

const login = $('#login');
const main = $('#deliveries');
const list = $('#rider-orders');
const alertBox = $('#rider-alert');
const logout = $('[data-logout]');
const watchers = new Map(); // orderId -> geolocation watch id
let stream;

function stopSharing(id) {
  if (watchers.has(id)) { navigator.geolocation.clearWatch(watchers.get(id)); watchers.delete(id); }
}

function startSharing(id) {
  if (watchers.has(id) || !('geolocation' in navigator)) return;
  const watch = navigator.geolocation.watchPosition((pos) => {
    api(`/api/rider/orders/${id}/location`, { method: 'POST', body: { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy } })
      .then(() => { const s = document.getElementById(`share-${id}`); if (s) s.textContent = `Sharing location. Last sent ${new Date().toLocaleTimeString('en-IN')}.`; })
      .catch((err) => { if (err.status === 409 || err.status === 404) stopSharing(id); });
  }, (err) => {
    const s = document.getElementById(`share-${id}`);
    if (s) s.textContent = err.code === err.PERMISSION_DENIED ? 'Location permission is off. The customer will not see your distance.' : 'Location is not available right now.';
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  watchers.set(id, watch);
}

function card(o) {
  const c = o.customer;
  const tel = c.phone ? `<a href="tel:+91${esc(c.phone)}">Call ${esc(c.name)}</a>` : '';
  const pin = o.location ? `<p class="small">Customer shared a pin: ${o.location.lat.toFixed(5)}, ${o.location.lng.toFixed(5)}</p>` : '';
  const action = o.status === 'packed'
    ? `<button type="button" class="btn btn-primary" data-start="${esc(o.id)}">Start delivery</button>`
    : o.status === 'out_for_delivery'
      ? `<button type="button" class="btn btn-primary" data-delivered="${esc(o.id)}">Mark delivered, ${money(o.total)} collected</button><p class="small" id="share-${esc(o.id)}" role="status"></p>`
      : '<p class="muted small">Waiting for the store to finish packing.</p>';
  return `<article class="order-card">
    <header><h2>${esc(o.id)}</h2><span class="tag tag-${esc(o.status)}">${esc(o.statusLabel)}</span></header>
    <p><strong>${esc(c.name)}</strong><br>${esc(c.house)}, ${esc(c.street)}${c.landmark ? `<br>Near ${esc(c.landmark)}` : ''}<br>Guwahati ${esc(c.pincode)}</p>
    ${pin}
    <p>${tel}</p>
    <p>${o.itemCount} items. Collect <strong>${money(o.total)}</strong> by ${esc(o.payment.toLowerCase())}.</p>
    <details><summary>Items</summary><ul>${o.items.map((i) => `<li>${i.qty} &times; ${esc(i.name)}, ${esc(i.netQuantity)}</li>`).join('')}</ul></details>
    <div class="actions">${action}</div>
  </article>`;
}

async function refresh() {
  const orders = await api('/api/rider/orders');
  list.innerHTML = orders.length ? orders.map(card).join('') : '<p class="empty-state">No deliveries assigned to you right now. New ones appear here automatically.</p>';
  const active = new Set(orders.filter((o) => o.status === 'out_for_delivery').map((o) => o.id));
  for (const id of [...watchers.keys()]) if (!active.has(id)) stopSharing(id);
  for (const id of active) startSharing(id);
}

list.addEventListener('click', async (e) => {
  const start = e.target.closest('[data-start]');
  const done = e.target.closest('[data-delivered]');
  const btn = start || done;
  if (!btn) return;
  btn.disabled = true;
  try {
    if (start) await api(`/api/rider/orders/${start.dataset.start}/start`, { method: 'POST', body: {} });
    if (done) { await api(`/api/rider/orders/${done.dataset.delivered}/delivered`, { method: 'POST', body: {} }); stopSharing(done.dataset.delivered); }
    showAlert(alertBox, 'success', start ? 'Delivery started. Your location is now shared with the customer.' : 'Marked as delivered. Location sharing stopped.', '');
    await refresh();
  } catch (err) {
    btn.disabled = false;
    showAlert(alertBox, 'error', 'That did not work.', err.message);
  }
});

async function enter() {
  try {
    const me = await api('/api/rider/me');
    login.hidden = true; main.hidden = false; logout.hidden = false;
    $('#rider-hello').textContent = `Deliveries for ${me.name}`;
    await refresh();
    stream = liveStream('/api/rider/stream', { orders: () => refresh().catch(() => {}) }, $('#live-state'));
  } catch {
    login.hidden = false; main.hidden = true;
    $('#code').focus();
  }
}

login.addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('#code');
  if (!setError(code, code.value.trim() ? '' : 'Enter your rider code.')) { code.focus(); return; }
  try {
    await api('/api/rider/login', { method: 'POST', body: { code: code.value } });
    $('#login-alert').innerHTML = '';
    enter();
  } catch (err) {
    showAlert($('#login-alert'), 'error', err.message, '');
    code.focus();
  }
});

logout.addEventListener('click', async () => {
  for (const id of [...watchers.keys()]) stopSharing(id);
  stream?.close();
  await api('/api/rider/logout', { method: 'POST', body: {} }).catch(() => {});
  window.location.reload();
});

window.addEventListener('pagehide', () => { for (const id of [...watchers.keys()]) stopSharing(id); });
enter();
