import { $, api, money, esc, setError, liveValidate, focusFirstError, showAlert, getConfig, formatTime, productImage } from './common.js';
import { rules } from './validators.js';

const alertBox = $('#acct-alert');
const addrForm = $('#addr-form');
const FIELDS = ['house', 'street', 'landmark', 'pincode'];
let config;

function renderOrders(orders) {
  $('#acct-orders').innerHTML = orders.length
    ? `<ul class="account-orders">${orders.map((o) => `<li>
        ${productImage({ image: o.image, category: 'staples' }, 48)}
        <div class="grow"><div><strong>${esc(o.id)}</strong> <span class="tag tag-${esc(o.status)}">${esc(o.statusLabel)}</span></div>
        <span class="small muted">${esc(formatTime(o.createdAt))}, ${o.itemCount} ${o.itemCount === 1 ? 'item' : 'items'}, ${money(o.total)}</span></div>
        <a class="btn btn-secondary btn-small" href="/order?id=${esc(o.id)}" aria-label="View order ${esc(o.id)}">View</a>
      </li>`).join('')}</ul>`
    : '<p class="muted">No orders yet. <a href="/shop">Start shopping</a>.</p>';
}

function render(me) {
  $('#acct-sub').textContent = `Signed in as ${me.name}, ${me.phone}.`;
  renderOrders(me.orders);
  for (const f of FIELDS) $(`#${f}`).value = me.address?.[f] || '';
  $('#remove-address').hidden = !me.address;
}

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
  await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
  window.location.href = '/login';
});

$('#delete-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('#del-password');
  if (!setError(pw, pw.value ? '' : 'Enter your password to confirm.')) { pw.focus(); return; }
  try {
    await api('/api/account/delete', { method: 'POST', body: { password: pw.value } });
    window.location.href = '/login';
  } catch (err) {
    if (err.data?.fields?.['del-password']) { setError(pw, err.data.fields['del-password']); pw.focus(); }
    else showAlert(alertBox, 'error', 'Your account was not deleted.', err.message);
  }
});

async function start() {
  let me;
  try {
    [me, config] = await Promise.all([api('/api/account/me'), getConfig()]);
  } catch (err) {
    showAlert(alertBox, 'error', 'Your account could not load.', err.message);
    return;
  }
  for (const f of FIELDS) liveValidate($(`#${f}`), (v) => (f === 'pincode' ? rules.pincode(v, config.serviceArea.pincodes) : rules[f](v)));
  render(me);
}
start();
