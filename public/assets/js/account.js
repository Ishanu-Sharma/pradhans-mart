import { $, api, money, esc, setError, liveValidate, focusFirstError, showAlert, getConfig, formatTime, deviceOrders } from './common.js';
import { rules } from './validators.js';

const alertBox = $('#acct-alert');
const addrForm = $('#addr-form');
const FIELDS = ['house', 'street', 'landmark', 'pincode'];
let config;

function renderOrders(orders) {
  $('#acct-orders').innerHTML = orders.length
    ? `<ul class="account-orders">${orders.map((o) => `<li>
        <div><strong>${esc(o.id)}</strong> <span class="tag tag-${esc(o.status)}">${esc(o.statusLabel)}</span>
        <span class="small muted">${esc(formatTime(o.createdAt))}, ${o.itemCount} ${o.itemCount === 1 ? 'item' : 'items'}, ${money(o.total)}</span></div>
        <button type="button" class="btn btn-secondary btn-small" data-track="${esc(o.id)}" aria-label="Track order ${esc(o.id)}">Track</button>
      </li>`).join('')}</ul>`
    : '<p class="muted">No orders yet. <a href="/shop">Start shopping</a>.</p>';
}

function render(me) {
  $('#acct-sub').textContent = `Signed in as ${me.name}, ${me.phone}.`;
  renderOrders(me.orders);
  for (const f of FIELDS) $(`#${f}`).value = me.address?.[f] || '';
  $('#remove-address').hidden = !me.address;
}

$('#acct-orders').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-track]');
  if (!btn) return;
  btn.disabled = true;
  try {
    const { id, token } = await api(`/api/account/orders/${btn.dataset.track}/track`, { method: 'POST', body: {} });
    deviceOrders.add(id, token);
    window.location.href = `/order#${id}.${token}`;
  } catch (err) {
    btn.disabled = false;
    showAlert(alertBox, 'error', 'That order could not be opened.', err.message);
  }
});

addrForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  for (const f of FIELDS) setError($(`#${f}`), f === 'pincode' ? rules.pincode($('#pincode').value, config.serviceArea.pincodes) : rules[f]($(`#${f}`).value));
  if (!focusFirstError(addrForm)) return;
  try {
    const me = await api('/api/account/address', { method: 'POST', body: Object.fromEntries(FIELDS.map((f) => [f, $(`#${f}`).value])) });
    render(me);
    showAlert(alertBox, 'success', 'Address saved.', 'Checkout will fill it in for you.');
  } catch (err) {
    if (err.data?.fields) { for (const [k, m] of Object.entries(err.data.fields)) if ($(`#${k}`)) setError($(`#${k}`), m); focusFirstError(addrForm); }
    else showAlert(alertBox, 'error', 'Address not saved.', err.message);
  }
});

$('#remove-address').addEventListener('click', async () => {
  try {
    const me = await api('/api/account/address', { method: 'POST', body: { remove: true } });
    render(me);
    for (const f of FIELDS) setError($(`#${f}`), '');
    showAlert(alertBox, 'success', 'Saved address removed.', '');
    $('#house').focus();
  } catch (err) { showAlert(alertBox, 'error', 'Address not removed.', err.message); }
});

$('#signout').addEventListener('click', async () => {
  await api('/api/account/logout', { method: 'POST', body: {} }).catch(() => {});
  window.location.href = '/';
});

$('#delete-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('#del-password');
  if (!setError(pw, pw.value ? '' : 'Enter your password to confirm.')) { pw.focus(); return; }
  try {
    await api('/api/account/delete', { method: 'POST', body: { password: pw.value } });
    for (const o of deviceOrders.list()) deviceOrders.remove(o.id);
    document.querySelector('.account-grid').innerHTML = '<div class="notice notice-success"><strong>Your account is deleted.</strong><p>We removed your details. <a href="/">Go to the home page</a>.</p></div>';
    $('#acct-sub').textContent = 'You are signed out.';
  } catch (err) {
    if (err.data?.fields?.['del-password']) { setError(pw, err.data.fields['del-password']); pw.focus(); }
    else showAlert(alertBox, 'error', 'Your account was not deleted.', err.message);
  }
});

async function start() {
  let me;
  try { me = await api('/api/account/me'); } catch (err) {
    if (err.status === 401) { window.location.replace('/login?next=/account'); return; }
    showAlert(alertBox, 'error', 'Your account could not load.', err.message);
    return;
  }
  config = await getConfig();
  for (const f of FIELDS) liveValidate($(`#${f}`), (v) => (f === 'pincode' ? rules.pincode(v, config.serviceArea.pincodes) : rules[f](v)));
  render(me);
}
start();
