import { $, api, money, esc, showAlert, liveStream, countdownHtml, tickCountdowns, icon } from './common.js';

const RIDER_OFFER_MS = 45_000;
const alertBox = $('#app-alert');
const sw = $('#online-switch');
const body = $('#rider-body');
let watchId = null;
let watchingOrder = null;
let lastOfferId = null;

function stopSharing() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null; watchingOrder = null;
}
function startSharing(orderId) {
  if (watchingOrder === orderId || !('geolocation' in navigator)) return;
  stopSharing();
  watchingOrder = orderId;
  watchId = navigator.geolocation.watchPosition((pos) => {
    api(`/api/rider/orders/${orderId}/location`, { method: 'POST', body: { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy } })
      .then(() => { const s = $('#share-status'); if (s) s.textContent = `Sharing your location. Last sent ${new Date().toLocaleTimeString('en-IN')}.`; })
      .catch((err) => { if (err.status === 409 || err.status === 404) stopSharing(); });
  }, (err) => {
    const s = $('#share-status');
    if (s) s.textContent = err.code === err.PERMISSION_DENIED ? 'Location permission is off. The customer will not see your distance.' : 'Location is not available right now.';
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}

function offerCard(o) {
  return `<section class="big-card job-offer" aria-labelledby="offer-title">
    <h2 id="offer-title">New delivery request</h2>
    <ol class="route">
      <li><span class="dot">${icon('store')}</span><div><span class="small muted">Pick up from</span><strong>${esc(o.store.name)}</strong>${esc(o.store.street)}, ${esc(o.store.pincode)}</div></li>
      <li><span class="dot drop">${icon('pin')}</span><div><span class="small muted">Deliver to</span><strong>${esc(o.drop.street)}</strong>Guwahati ${esc(o.drop.pincode)}</div></li>
    </ol>
    <p>${o.itemCount} ${o.itemCount === 1 ? "item" : "items"}. Collect <span class="amount">${money(o.total)}</span> by ${esc(o.payment.toLowerCase())}.</p>
    ${countdownHtml(o.expiresAt, RIDER_OFFER_MS)}
    <div class="offer-actions">
      <button type="button" class="btn btn-secondary" data-act="decline" data-id="${esc(o.id)}">Decline</button>
      <button type="button" class="btn btn-primary" data-act="accept" data-id="${esc(o.id)}">Accept delivery</button>
    </div>
  </section>`;
}

function activeCard(o) {
  const c = o.customer;
  const picked = o.status === 'out_for_delivery';
  return `<section class="big-card" aria-labelledby="active-title">
    <h2 id="active-title">${picked ? 'Deliver to the customer' : 'Go to the store'} <span class="tag tag-${esc(o.status)}">${esc(o.statusLabel)}</span></h2>
    <ol class="route">
      <li><span class="dot">${icon('store')}</span><div><span class="small muted">Pick up from</span><strong>${esc(o.store.name)}</strong>${esc(o.store.street)}, ${esc(o.store.pincode)}</div></li>
      <li><span class="dot drop">${icon('pin')}</span><div><span class="small muted">Deliver to</span><strong>${esc(c.name || '')}</strong>${esc(c.house || '')}, ${esc(c.street || '')}${c.landmark ? `, near ${esc(c.landmark)}` : ''}, Guwahati ${esc(c.pincode || '')}
        ${o.location ? `<br><span class="small">Customer pin: ${o.location.lat.toFixed(5)}, ${o.location.lng.toFixed(5)}</span>` : ''}</div></li>
    </ol>
    ${c.phone ? `<p><a class="btn btn-secondary btn-small" href="tel:+91${esc(c.phone)}">${icon('phone')}Call ${esc(c.name)}</a></p>` : ''}
    <details><summary>${o.itemCount} ${o.itemCount === 1 ? "item" : "items"}</summary><ul>${o.items.map((i) => `<li>${i.qty} &times; ${esc(i.name)}, ${esc(i.netQuantity)}</li>`).join('')}</ul></details>
    <p>Collect <span class="amount">${money(o.total)}</span> by ${esc(o.payment.toLowerCase())}.</p>
    ${picked
      ? `<button type="button" class="btn btn-success btn-block" data-act="delivered" data-id="${esc(o.id)}">Delivered, ${money(o.total)} collected</button><p class="small" id="share-status" role="status"></p>`
      : `<button type="button" class="btn btn-primary btn-block" data-act="pickup" data-id="${esc(o.id)}">I have picked up the order</button>`}
  </section>`;
}

function render(d) {
  const r = d.rider;
  $('[data-app-user]').textContent = r.name;
  if (r.status !== 'active') { $('#pending').hidden = false; $('#workspace').hidden = true; return; }
  $('#pending').hidden = true; $('#workspace').hidden = false;
  $('#rider-title').textContent = `Hello, ${r.name.split(/\s+/)[0]}`;
  $('#rider-sub').textContent = `${r.vehicle}. ${d.deliveredToday} ${d.deliveredToday === 1 ? 'delivery' : 'deliveries'} completed today.`;
  sw.setAttribute('aria-checked', String(r.online));
  $('#online-label').textContent = r.online ? 'Online' : 'Offline';

  const focused = document.activeElement?.dataset?.act;
  if (d.active) body.innerHTML = activeCard(d.active);
  else if (d.offer) body.innerHTML = offerCard(d.offer);
  else body.innerHTML = `<section class="big-card waiting-card"><svg class="icon" aria-hidden="true" focusable="false"><use href="/assets/icons.svg#${r.online ? 'scooter' : 'clock'}"></use></svg>
      <h2>${r.online ? 'Waiting for a delivery request' : 'You are offline'}</h2>
      <p class="muted">${r.online ? 'Requests go to the delivery partner who has been free the longest. Keep this page open.' : 'Go online to start receiving delivery requests.'}</p></section>`;
  if (d.offer && d.offer.id !== lastOfferId) $('#announcer').textContent = `New delivery request from ${d.offer.store.name}. You have 45 seconds to accept.`;
  lastOfferId = d.offer?.id || null;
  if (focused) $(`[data-act="${focused}"]`)?.focus();
  tickCountdowns();

  if (d.active?.status === 'out_for_delivery') startSharing(d.active.id); else stopSharing();
  sw.disabled = !!d.active;
}

async function refresh() {
  try { render(await api('/api/rider/dashboard')); }
  catch (err) { if (err.status === 401) window.location.href = '/login?role=rider'; else showAlert(alertBox, 'error', 'Could not load your deliveries.', err.message); }
}

body.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  btn.disabled = true;
  const { act, id } = btn.dataset;
  try {
    await api(`/api/rider/orders/${id}/${act}`, { method: 'POST', body: {} });
    const msg = { accept: 'Delivery accepted. Head to the store.', decline: 'Request declined. It goes to another partner.', pickup: 'Picked up. Your location is now shared with the customer.', delivered: 'Delivered. Location sharing stopped.' }[act];
    showAlert(alertBox, 'success', msg, '');
    if (act === 'delivered') stopSharing();
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
    await api('/api/rider/online', { method: 'POST', body: { online: want } });
    await refresh();
  } catch (err) { showAlert(alertBox, 'error', 'Could not change your status.', err.message); sw.disabled = false; }
});

window.addEventListener('pagehide', stopSharing);
setInterval(() => tickCountdowns(), 1000);
refresh().then(() => liveStream('/api/stream/me', { refresh, open: refresh }));
