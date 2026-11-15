import { $, api, money, esc, setError, liveValidate, focusFirstError, showAlert, deviceOrders, liveStream, formatTime } from './common.js';
import { rules, haversineKm } from './validators.js';

const alertBox = $('#order-alert');
const view = $('#order-view');
const lookup = $('#lookup');
const STEPS = [
  ['placed', 'Order placed'],
  ['accepted', 'Accepted by the store'],
  ['packed', 'Packed'],
  ['out_for_delivery', 'Out for delivery'],
  ['delivered', 'Delivered']
];

let current = null; // { id, token }
let stream = null;
let myLocation = null; // read on this device only, never sent
let lastStatus = null;

function renderTimeline(o) {
  const reached = new Map(o.history.map((h) => [h.status, h.at]));
  if (o.status === 'cancelled') {
    return o.history.map((h) => `<li data-state="${h.status === 'cancelled' ? 'cancelled' : 'done'}"${h.status === 'cancelled' ? ' aria-current="step"' : ''}>${esc(h.label)}<time datetime="${esc(h.at)}">${esc(formatTime(h.at))}</time></li>`).join('');
  }
  const idx = STEPS.findIndex(([s]) => s === o.status);
  return STEPS.map(([s, label], i) => {
    const state = i < idx || o.status === 'delivered' ? 'done' : i === idx ? 'current' : 'todo';
    const at = reached.get(s);
    return `<li${state === 'done' ? ' data-state="done"' : ''}${state === 'current' ? ' aria-current="step"' : ''}>${esc(label)}${at ? `<time datetime="${esc(at)}">${esc(formatTime(at))}</time>` : '<span class="visually-hidden">, not yet</span>'}</li>`;
  }).join('');
}

function riderText(o) {
  if (o.status !== 'out_for_delivery') return null;
  const name = o.rider?.name || 'Your rider';
  const loc = o.riderLocation;
  if (!loc) return { text: `${name} is on the way. Their distance appears here once their phone shares its location.`, button: false };
  const from = o.customerLocation || myLocation;
  const updated = new Date(loc.at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', second: '2-digit' });
  if (!from) return { text: `${name} is on the way. Location updated at ${updated}.`, button: true };
  const km = haversineKm(from, loc);
  const dist = km < 1 ? `${Math.max(50, Math.round(km * 1000 / 50) * 50)} m` : `${km.toFixed(1)} km`;
  return { text: `${name} is about ${dist} from ${o.customerLocation ? 'your delivery location' : 'you'} in a straight line. Updated at ${updated}.`, button: false };
}

function render(o) {
  view.hidden = false; lookup.hidden = true;
  $('#order-id').textContent = `Order ${o.id}, placed ${formatTime(o.createdAt)}`;
  if (o.status !== lastStatus) { $('#status-text').textContent = o.statusLabel; lastStatus = o.status; }
  $('#timeline').innerHTML = renderTimeline(o);

  const r = riderText(o);
  $('#rider-box').hidden = !r;
  if (r) {
    $('#rider-text').textContent = r.text;
    let btn = $('#distance-btn');
    if (r.button && !btn) {
      $('#rider-box').insertAdjacentHTML('beforeend', '<button type="button" class="btn btn-secondary btn-small" id="distance-btn">Show the rider\'s distance from me</button><p class="hint small">Your location is used on this device only.</p>');
      btn = $('#distance-btn');
      btn.addEventListener('click', () => {
        btn.disabled = true;
        navigator.geolocation.getCurrentPosition((pos) => {
          myLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          btn.nextElementSibling?.remove(); btn.remove();
          render(o);
        }, () => { btn.disabled = false; $('#rider-text').textContent = 'We could not get your location, so we cannot show the distance.'; });
      });
    } else if (!r.button && btn) { btn.nextElementSibling?.remove(); btn.remove(); }
  }

  $('#cancel-row').hidden = !o.canCancel;
  $('#order-lines').innerHTML = o.items.map((l) => `<li><span>${l.qty} &times; ${esc(l.name)} <span class="muted small">${esc(l.netQuantity)}</span></span><span>${money(l.price * l.qty)}</span></li>`).join('');
  $('#order-totals').innerHTML = `
    <div><dt>Items</dt><dd>${money(o.subtotal)}</dd></div>
    <div><dt>Delivery fee</dt><dd>${o.deliveryFee === 0 ? 'Free' : money(o.deliveryFee)}</dd></div>
    <div class="total"><dt>${o.status === 'cancelled' ? 'Total (not payable)' : 'Total to pay on delivery'}</dt><dd>${money(o.total)}</dd></div>
    <div><dt>Payment</dt><dd>${esc(o.payment)}</dd></div>`;
  const a = o.address;
  $('#order-address').innerHTML = a
    ? `<h3>Delivery address</h3><p>${esc(a.name)}<br>${esc(a.house)}, ${esc(a.street)}${a.landmark ? `<br>Near ${esc(a.landmark)}` : ''}<br>Guwahati ${esc(a.pincode)}</p>`
    : '<p class="muted small">The delivery address for this order has been deleted under our retention rule.</p>';
}

async function load(id, token) {
  current = { id, token };
  alertBox.innerHTML = '';
  try {
    const o = await api(`/api/orders/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`);
    deviceOrders.add(id, token);
    render(o);
    stream?.close();
    stream = liveStream(`/api/orders/${encodeURIComponent(id)}/stream?t=${encodeURIComponent(token)}`, { order: render }, $('#live-state'));
  } catch (err) {
    if (err.status === 404) deviceOrders.remove(id);
    showAlert(alertBox, 'error', 'We could not open that order.', err.message);
    showLookup();
  }
}

function showLookup() {
  view.hidden = true; lookup.hidden = false;
  const saved = deviceOrders.list();
  $('#device-orders').innerHTML = saved.length
    ? `<h3>Orders placed on this device</h3><ul>${saved.map((o) => `<li><a href="/order#${esc(o.id)}.${esc(o.token)}">${esc(o.id)}</a>, ${esc(formatTime(o.at))}</li>`).join('')}</ul><p class="or-row">or</p>`
    : '';
}

// Cancel uses an inline confirmation rather than a browser dialog.
const cancelRow = $('#cancel-row');
const cancelIdle = '<button type="button" class="btn btn-danger" data-cancel="ask">Cancel this order</button>';
cancelRow.innerHTML = cancelIdle;
cancelRow.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-cancel]');
  if (!btn) return;
  const step = btn.dataset.cancel;
  if (step === 'ask') {
    cancelRow.innerHTML = `<p>Cancel order ${esc(current.id)}? You will not be charged.</p>
      <button type="button" class="btn btn-secondary" data-cancel="keep">Keep my order</button>
      <button type="button" class="btn btn-danger" data-cancel="confirm">Yes, cancel it</button>`;
    cancelRow.querySelector('[data-cancel="keep"]').focus();
  } else if (step === 'keep') {
    cancelRow.innerHTML = cancelIdle;
    cancelRow.querySelector('[data-cancel]').focus();
  } else if (step === 'confirm') {
    btn.disabled = true;
    try {
      const o = await api(`/api/orders/${current.id}/cancel`, { method: 'POST', body: { token: current.token } });
      cancelRow.innerHTML = cancelIdle;
      render(o);
      showAlert(alertBox, 'success', 'Your order is cancelled.', 'You will not be charged.');
    } catch (err) {
      btn.disabled = false;
      showAlert(alertBox, 'error', 'The order was not cancelled.', err.message);
    }
  }
});

const lookupForm = $('#lookup-form');
liveValidate($('#orderId'), (v) => rules.orderId(v));
liveValidate($('#phone'), (v) => rules.phone(v));
lookupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  setError($('#orderId'), rules.orderId($('#orderId').value));
  setError($('#phone'), rules.phone($('#phone').value));
  if (!focusFirstError(lookupForm)) return;
  try {
    const res = await api('/api/orders/lookup', { method: 'POST', body: { orderId: $('#orderId').value.trim().toUpperCase(), phone: $('#phone').value } });
    history.replaceState(null, '', `/order#${res.id}.${res.token}`);
    load(res.id, res.token);
  } catch (err) {
    showAlert(alertBox, 'error', 'Order not found.', err.message);
  }
});

function fromHash() {
  const m = window.location.hash.match(/^#(PM[A-Z0-9]{8})\.([A-Za-z0-9_-]+)$/);
  if (m) load(m[1], m[2]);
  else showLookup();
}
window.addEventListener('hashchange', fromHash);
fromHash();
