import { $, api, money, esc, showAlert, liveStream, formatTime, productImage } from './common.js';
import { haversineKm } from './validators.js';

const alertBox = $('#order-alert');
const view = $('#order-view');
const STEPS = [
  ['placed', 'Order placed'],
  ['accepted', 'Accepted by the store'],
  ['packed', 'Packed'],
  ['rider_assigned', 'Delivery partner assigned'],
  ['out_for_delivery', 'Out for delivery'],
  ['delivered', 'Delivered']
];
const orderId = (new URLSearchParams(window.location.search).get('id') || '').toUpperCase();
let current = null;
let myLocation = null; // read on this device only, never sent
let lastStatus = null;
const images = new Map();

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

function subline(o) {
  if (o.status === 'cancelled') return o.cancelReason || 'This order was cancelled. You have not been charged.';
  if (o.status === 'delivered') return 'Thank you for ordering from us.';
  if (o.waiting) return o.waiting;
  if (o.status === 'accepted') return `${o.store?.name || 'The store'} is packing your order.`;
  if (o.status === 'rider_assigned') return `${o.rider?.name || 'Your delivery partner'} is on the way to ${o.store?.name || 'the store'} to collect it.`;
  if (o.status === 'out_for_delivery') return `${o.rider?.name || 'Your delivery partner'} is on the way to you${o.rider?.vehicle ? ` by ${o.rider.vehicle.toLowerCase()}` : ''}.`;
  return '';
}

function riderText(o) {
  if (o.status !== 'out_for_delivery') return null;
  const loc = o.riderLocation;
  const name = o.rider?.name || 'Your delivery partner';
  if (!loc) return { text: `${name}'s distance appears here once their phone shares its location.`, button: false };
  const from = o.customerLocation || myLocation;
  const updated = new Date(loc.at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', second: '2-digit' });
  if (!from) return { text: `Location updated at ${updated}.`, button: true };
  const km = haversineKm(from, loc);
  const dist = km < 1 ? `${Math.max(50, Math.round((km * 1000) / 50) * 50)} m` : `${km.toFixed(1)} km`;
  return { text: `${name} is about ${dist} from ${o.customerLocation ? 'your delivery location' : 'you'} in a straight line. Updated at ${updated}.`, button: false };
}

function render(o) {
  current = o;
  view.hidden = false;
  $('#status-card').dataset.status = o.status;
  $('#order-id').textContent = `Order ${o.id}, placed ${formatTime(o.createdAt)}`;
  if (o.status !== lastStatus) { $('#status-text').textContent = o.statusLabel; lastStatus = o.status; }
  $('#status-sub').textContent = subline(o);
  $('#timeline').innerHTML = renderTimeline(o);

  const r = riderText(o);
  $('#rider-box').hidden = !r;
  if (r) {
    $('#rider-text').textContent = r.text;
    let btn = $('#distance-btn');
    if (r.button && !btn && 'geolocation' in navigator) {
      $('#rider-box').insertAdjacentHTML('beforeend', '<button type="button" class="btn btn-secondary btn-small" id="distance-btn">Show the distance from me</button><p class="hint small">Your location is used on this device only.</p>');
      btn = $('#distance-btn');
      btn.addEventListener('click', () => {
        btn.disabled = true;
        navigator.geolocation.getCurrentPosition((pos) => {
          myLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          btn.nextElementSibling?.remove(); btn.remove();
          render(current);
        }, () => { btn.disabled = false; $('#rider-text').textContent = 'We could not get your location, so we cannot show the distance.'; });
      });
    } else if (!r.button && btn) { btn.nextElementSibling?.remove(); btn.remove(); }
  }

  const cancelRow = $('#cancel-row');
  cancelRow.hidden = !o.canCancel;
  if (o.canCancel && !cancelRow.innerHTML.trim()) cancelRow.innerHTML = '<button type="button" class="btn btn-danger" data-cancel="ask">Cancel this order</button>';
  $('#order-lines').innerHTML = o.items.map((l) => `<li>${productImage({ image: images.get(l.id), category: 'staples' }, 40)}<span class="grow">${l.qty} &times; ${esc(l.name)} <span class="muted small">${esc(l.netQuantity)}</span></span><span>${money(l.price * l.qty)}</span></li>`).join('');
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

// Cancel uses an inline confirmation rather than a browser dialog.
$('#cancel-row').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-cancel]');
  if (!btn) return;
  const row = $('#cancel-row');
  const step = btn.dataset.cancel;
  if (step === 'ask') {
    row.innerHTML = `<p>Cancel order ${esc(current.id)}? You will not be charged.</p>
      <button type="button" class="btn btn-secondary" data-cancel="keep">Keep my order</button>
      <button type="button" class="btn btn-danger" data-cancel="confirm">Yes, cancel it</button>`;
    row.querySelector('[data-cancel="keep"]').focus();
  } else if (step === 'keep') {
    row.innerHTML = '<button type="button" class="btn btn-danger" data-cancel="ask">Cancel this order</button>';
    row.querySelector('[data-cancel]').focus();
  } else if (step === 'confirm') {
    btn.disabled = true;
    try {
      const o = await api(`/api/orders/${current.id}/cancel`, { method: 'POST', body: {} });
      row.innerHTML = '';
      render(o);
      showAlert(alertBox, 'success', 'Your order is cancelled.', 'You will not be charged.');
    } catch (err) {
      btn.disabled = false;
      showAlert(alertBox, 'error', 'The order was not cancelled.', err.message);
    }
  }
});

async function start() {
  if (!/^PM[A-Z0-9]{8}$/.test(orderId)) {
    alertBox.innerHTML = '<div class="notice notice-info"><strong>Choose an order to track.</strong><p>Your orders are listed on <a href="/account">your account page</a>.</p></div>';
    return;
  }
  try {
    const [o, catalogue] = await Promise.all([api(`/api/orders/${orderId}`), api('/api/products').catch(() => ({ products: [] }))]);
    for (const p of catalogue.products) images.set(p.id, p.image);
    render(o);
    liveStream('/api/stream/me', { order: (u) => { if (u.id === orderId) render(u); } }, $('#live-state'));
  } catch (err) {
    showAlert(alertBox, 'error', 'We could not open that order.', err.message);
  }
}
start();
