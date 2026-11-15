import { $, $$, api, setError, liveValidate, focusFirstError, showAlert, deviceOrders } from './common.js';
import { rules } from './validators.js';

const form = $('#request-form');
const alertBox = $('#request-alert');
const orderId = $('#orderId');
const phone = $('#phone');
const confirmBox = $('#confirm');

liveValidate(orderId, (v) => rules.orderId(v));
liveValidate(phone, (v) => rules.phone(v));

const typeError = (msg) => {
  const el = $('#type-error');
  el.textContent = msg; el.hidden = !msg;
  for (const r of $$('input[name="type"]')) {
    if (msg) { r.setAttribute('aria-invalid', 'true'); r.setAttribute('aria-describedby', 'type-error'); }
    else { r.removeAttribute('aria-invalid'); r.removeAttribute('aria-describedby'); }
  }
};

form.addEventListener('change', (e) => {
  if (e.target.name === 'type') {
    typeError('');
    $('#delete-confirm').hidden = e.target.value !== 'delete';
  }
  if (e.target === confirmBox && confirmBox.checked) setError(confirmBox, '');
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  alertBox.innerHTML = '';
  setError(orderId, rules.orderId(orderId.value));
  setError(phone, rules.phone(phone.value));
  const type = $('input[name="type"]:checked')?.value;
  typeError(type ? '' : 'Choose what you want us to do.');
  if (type === 'delete') setError(confirmBox, confirmBox.checked ? '' : 'Tick the box to confirm you want your data deleted.');
  if (!focusFirstError(form)) return;

  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const id = orderId.value.trim().toUpperCase();
    const res = await api('/api/data-requests', { method: 'POST', body: { orderId: id, phone: phone.value, type, confirm: confirmBox.checked } });
    if (type === 'export') {
      const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `pradhans-mart-data-${id}.json`;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      showAlert(alertBox, 'success', 'Your data file has downloaded.', `It covers ${res.orders.length} ${res.orders.length === 1 ? 'order' : 'orders'} placed with this number.`);
    } else {
      for (const o of deviceOrders.list()) deviceOrders.remove(o.id);
      form.reset();
      $('#delete-confirm').hidden = true;
      showAlert(alertBox, 'success', 'Your personal data is deleted.', `We removed your details from ${res.deletedOrders} ${res.deletedOrders === 1 ? 'order' : 'orders'}${res.deletedSubscriptions ? ' and stopped offer emails' : ''}.`);
    }
    alertBox.scrollIntoView({ block: 'nearest' });
  } catch (err) {
    if (err.status === 422 && err.data.fields) {
      for (const [k, msg] of Object.entries(err.data.fields)) {
        if (k === 'type') typeError(msg); else if ($(`#${k}`)) setError($(`#${k}`), msg);
      }
      focusFirstError(form);
    } else {
      showAlert(alertBox, 'error', 'Your request was not completed.', err.message);
    }
  } finally {
    btn.disabled = false;
  }
});
