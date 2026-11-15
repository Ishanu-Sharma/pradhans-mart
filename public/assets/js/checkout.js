import { $, $$, api, cart, money, esc, getConfig, setError, liveValidate, focusFirstError, showAlert, storage, preferencesAllowed, productImage } from './common.js';
import { rules } from './validators.js';

const alertBox = $('#checkout-alert');
const step1 = $('#step-1');
const step2 = $('#step-2');
const placeBtn = $('#place-order');

let config;
let products = new Map();
let sharedLocation = null;
let totals = null;

const fields1 = ['name', 'phone', 'house', 'street', 'landmark', 'pincode'];
const check = (id, v) => (id === 'pincode' ? rules.pincode(v, config.serviceArea.pincodes) : rules[id](v));

function computeTotals() {
  const lines = [];
  let subtotal = 0;
  const problems = [];
  for (const i of cart.items()) {
    const p = products.get(i.id);
    if (!p) { problems.push('An item in your cart is no longer sold. Remove it in the shop.'); continue; }
    if (p.available < i.qty) problems.push(p.available === 0 ? `${p.name} is out of stock right now.` : `Only ${p.available} of ${p.name} available.`);
    lines.push({ ...i, p });
    subtotal += p.price * i.qty;
  }
  const deliveryFee = subtotal >= config.fees.freeDeliveryFrom ? 0 : config.fees.deliveryFee;
  return { lines, subtotal, deliveryFee, total: subtotal + deliveryFee, problems };
}

function renderSummary() {
  totals = computeTotals();
  $('#summary-lines').innerHTML = totals.lines.map((l) => `<li>${productImage(l.p, 40)}<span class="grow">${l.qty} &times; ${esc(l.p.name)} <span class="muted small">${esc(l.p.netQuantity)}</span></span><span>${money(l.p.price * l.qty)}</span></li>`).join('');
  $('#summary-totals').innerHTML = `
    <div><dt>Items</dt><dd>${money(totals.subtotal)}</dd></div>
    <div><dt>Delivery fee</dt><dd>${totals.deliveryFee === 0 ? 'Free' : money(totals.deliveryFee)}</dd></div>
    <div class="total"><dt>Total to pay on delivery</dt><dd>${money(totals.total)}</dd></div>`;
  placeBtn.textContent = `Place order, pay ${money(totals.total)} on delivery`;
}

function setStep(n) {
  for (const li of $$('#steps li')) {
    const s = Number(li.dataset.step);
    if (s < n) { li.dataset.state = 'done'; li.removeAttribute('aria-current'); }
    else if (s === n) { delete li.dataset.state; li.setAttribute('aria-current', 'step'); }
    else { delete li.dataset.state; li.removeAttribute('aria-current'); }
  }
  step1.hidden = n !== 1; step2.hidden = n !== 2; $('#step-3').hidden = n !== 3;
  const heading = $(`#s${n}-title`);
  heading.focus();
  heading.scrollIntoView({ block: 'nearest' });
}

const values1 = () => Object.fromEntries(fields1.map((f) => [f, $(`#${f}`).value.trim()]));

function validateStep1() {
  for (const f of fields1) setError($(`#${f}`), check(f, $(`#${f}`).value));
  const share = $('#share-location');
  if (share.checked && !sharedLocation) setError(share, 'Wait for your location, or untick the box.');
  return focusFirstError(step1);
}

function renderAddressReview() {
  const v = values1();
  $('#review-address').innerHTML = `<strong>Delivering to ${esc(v.name)}, ${esc(v.phone)}</strong>
    <p>${esc(v.house)}, ${esc(v.street)}${v.landmark ? `, near ${esc(v.landmark)}` : ''}, Guwahati ${esc(v.pincode)}${sharedLocation ? '. Your location will be shared with the delivery partner.' : ''}</p>`;
}

function setGroupError(message) {
  const err = $('#payment-error');
  err.textContent = message; err.hidden = !message;
  for (const r of $$('input[name="payment"]')) {
    if (message) { r.setAttribute('aria-invalid', 'true'); r.setAttribute('aria-describedby', 'payment-error'); }
    else { r.removeAttribute('aria-invalid'); r.removeAttribute('aria-describedby'); }
  }
  return !message;
}

function validateStep2() {
  setGroupError($('input[name="payment"]:checked') ? '' : 'Choose how you will pay.');
  setError($('#email'), $('#marketing').checked ? rules.email($('#email').value) : '');
  return focusFirstError(step2);
}

async function placeOrder() {
  placeBtn.disabled = true;
  const old = placeBtn.textContent;
  placeBtn.textContent = 'Placing your order…';
  alertBox.innerHTML = '';
  const v = values1();
  try {
    const res = await api('/api/orders', {
      method: 'POST',
      body: {
        items: cart.items(), customer: v, shareLocation: !!sharedLocation, location: sharedLocation,
        payment: $('input[name="payment"]:checked').value,
        consents: { marketing: $('#marketing').checked, email: $('#marketing').checked ? $('#email').value.trim() : undefined },
        expectedTotal: totals.total, saveAddress: $('#save-address').checked
      }
    });
    if (preferencesAllowed()) storage.set('pm_area', { pincode: v.pincode });
    cart.clear();
    $('#confirmation').innerHTML = `
      <div class="notice notice-success"><strong>Order ${esc(res.id)} is placed.</strong><p>We are finding a store to pack it. Pay ${money(res.total)} to the delivery partner in cash or by UPI when it arrives.</p></div>
      <p><a class="btn btn-primary" href="/order?id=${esc(res.id)}">Track this order</a></p>`;
    $('#summary-lines').closest('aside').hidden = true;
    setStep(3);
  } catch (err) {
    placeBtn.disabled = false;
    placeBtn.textContent = old;
    if (err.status === 422 && err.data.fields) {
      const f = err.data.fields;
      for (const k of Object.keys(f)) {
        if (k === 'payment') setGroupError(f[k]);
        else { const el = k === 'location' ? $('#share-location') : $(`#${k}`); if (el) setError(el, f[k]); }
      }
      showAlert(alertBox, 'error', f.items ? 'There is a problem with your cart.' : 'Check the highlighted details.', f.items || '');
      if (Object.keys(f).some((k) => fields1.includes(k) || k === 'location')) { setStep(1); focusFirstError(step1); } else focusFirstError(step2);
      return;
    }
    if (err.status === 409 && err.data.code === 'total_changed') {
      await reloadProducts();
      showAlert(alertBox, 'warn', 'A price changed while you were checking out.', `The new total is ${money(totals.total)}. Check the summary, then place the order again.`);
    } else {
      showAlert(alertBox, 'error', 'Your order was not placed.', err.message);
    }
    alertBox.scrollIntoView({ block: 'nearest' });
  }
}

async function reloadProducts() {
  const res = await api('/api/products');
  products = new Map(res.products.map((p) => [p.id, p]));
  renderSummary();
}

async function start() {
  let me;
  try {
    config = await getConfig();
    [me] = await Promise.all([api('/api/account/me'), reloadProducts()]);
  } catch (err) {
    showAlert(alertBox, 'error', 'Checkout could not load.', err.message);
    step1.hidden = true;
    return;
  }
  if (cart.items().length === 0) {
    alertBox.innerHTML = '<div class="notice notice-info"><strong>Your cart is empty.</strong><p><a href="/shop">Go to the shop</a> to add items.</p></div>';
    step1.hidden = true;
    $('#summary-lines').closest('aside').hidden = true;
    return;
  }
  if (totals.problems.length) {
    alertBox.innerHTML = `<div class="notice notice-error"><strong>Your cart needs a change before checkout.</strong><p>${totals.problems.map(esc).join(' ')}</p><p><a href="/shop#cart">Open your cart</a></p></div>`;
    step1.hidden = true;
    return;
  }
  if (!config.isOpen) {
    showAlert(alertBox, 'warn', 'Orders are closed right now.', `We take orders from ${config.hours.open} to ${config.hours.close}.`);
    placeBtn.disabled = true;
  }

  const fill = { name: me.name, phone: me.phone, ...(me.address || {}) };
  if (!me.address && preferencesAllowed()) fill.pincode = storage.get('pm_area', null)?.pincode || '';
  for (const [k, v] of Object.entries(fill)) { const el = $(`#${k}`); if (el && v) el.value = v; }
  for (const f of fields1) liveValidate($(`#${f}`), (v) => check(f, v));

  $('#payment-options').innerHTML = config.paymentMethods.map((m) => `<label class="radio-card"><input type="radio" name="payment" value="${esc(m.id)}"> ${esc(m.label)}</label>`).join('');
  $('#payment-options').addEventListener('change', () => setGroupError(''));
  $('#marketing').addEventListener('change', (e) => {
    $('#email-field').hidden = !e.target.checked;
    if (e.target.checked) $('#email').focus(); else setError($('#email'), '');
  });
  liveValidate($('#email'), (v) => rules.email(v));

  const share = $('#share-location');
  const locStatus = $('#location-status');
  if (!('geolocation' in navigator)) share.closest('.check').hidden = true;
  share.addEventListener('change', () => {
    setError(share, '');
    sharedLocation = null;
    locStatus.textContent = '';
    if (!share.checked) return;
    locStatus.textContent = 'Getting your location…';
    navigator.geolocation.getCurrentPosition((pos) => {
      if (!share.checked) return;
      sharedLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      locStatus.textContent = 'Location added.';
    }, (err) => {
      share.checked = false;
      locStatus.textContent = '';
      setError(share, err.code === err.PERMISSION_DENIED ? 'Location permission was not given. Your address is enough for delivery.' : 'We could not get your location. Your address is enough for delivery.');
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  });

  step1.addEventListener('submit', (e) => {
    e.preventDefault();
    alertBox.innerHTML = '';
    if (!validateStep1()) return;
    renderAddressReview();
    setStep(2);
  });
  $('#back-1').addEventListener('click', () => setStep(1));
  step2.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!config.isOpen) return;
    if (!validateStep2()) return;
    placeOrder();
  });
}
start();
