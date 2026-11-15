import { $, $$, api, setError, liveValidate, focusFirstError, showAlert, getConfig } from './common.js';
import { rules } from './validators.js';

const alertBox = $('#login-alert');
const signin = $('#signin-form');
const register = $('#register-form');
const forgot = $('#forgot-form');
const tabs = $$('[role="tab"]', $('.role-tabs'));
const params = new URLSearchParams(window.location.search);

const ROLE_TEXT = {
  customer: { note: 'Order groceries for delivery in Guwahati.', newText: 'New to Pradhan’s Mart?', create: 'Create an account' },
  rider: { note: 'Deliver orders near you. You choose when you are online.', newText: 'Want to deliver with us?', create: 'Sign up as a delivery partner' },
  store: { note: 'Receive orders for your shop, pack them and hand them to delivery partners.', newText: 'Run a shop in Guwahati?', create: 'Register your store' }
};

// Only same-site paths are allowed as a destination after signing in.
const nextParam = params.get('next') || '';
const next = /^\/(?!\/)[\w\-/?=&.]*$/.test(nextParam) ? nextParam : '';

let role = ['rider', 'store'].includes(params.get('role')) ? params.get('role') : 'customer';
let mode = window.location.hash === '#register' ? 'register' : 'signin';
let resetStep = 1;

function clearErrors(form) { for (const el of $$('[aria-invalid="true"]', form)) setError(el, ''); }

function render() {
  for (const t of tabs) {
    const on = t.dataset.role === role;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  }
  $('#auth-panel').setAttribute('aria-labelledby', `tab-${role}`);
  const txt = ROLE_TEXT[role];
  $('#role-note').textContent = txt.note;
  $('#new-text').textContent = txt.newText;
  $('[data-mode="register"]').textContent = txt.create;
  $('#register-submit').textContent = role === 'customer' ? 'Create account' : role === 'rider' ? 'Sign up to deliver' : 'Register store';
  signin.hidden = mode !== 'signin';
  register.hidden = mode !== 'register';
  forgot.hidden = mode !== 'forgot';
  for (const el of $$('[data-for]', register)) {
    const want = el.dataset.for;
    el.hidden = !(want === role || (want === 'partner' && role !== 'customer'));
  }
  $('#auth-title').textContent = mode === 'signin' ? 'Sign in to continue' : mode === 'forgot' ? 'Reset your password' : (role === 'customer' ? 'Create your account' : role === 'rider' ? 'Become a delivery partner' : 'Register your store');
}

function selectRole(r, focus) {
  role = r;
  alertBox.innerHTML = '';
  clearErrors(signin); clearErrors(register); clearErrors(forgot);
  resetForgot();
  render();
  if (focus) tabs.find((t) => t.dataset.role === r).focus();
}
for (const t of tabs) {
  t.addEventListener('click', () => selectRole(t.dataset.role, false));
  t.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(t);
    const n = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length] : e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs.at(-1) : null;
    if (n) { e.preventDefault(); selectRole(n.dataset.role, true); }
  });
}
for (const b of $$('[data-mode]')) {
  b.addEventListener('click', () => {
    mode = b.dataset.mode;
    alertBox.innerHTML = '';
    if (mode === 'forgot') { resetForgot(); if ($('#si-phone').value) $('#fp-phone').value = $('#si-phone').value; }
    render();
    ({ signin: $('#si-phone'), register: $('#rg-name'), forgot: $('#fp-phone') })[mode].focus();
  });
}

const go = (home) => { window.location.href = next && role === 'customer' ? next : home; };

liveValidate($('#si-phone'), (v) => rules.phone(v));
signin.addEventListener('submit', async (e) => {
  e.preventDefault();
  alertBox.innerHTML = '';
  setError($('#si-phone'), rules.phone($('#si-phone').value));
  setError($('#si-password'), $('#si-password').value ? '' : 'Enter your password.');
  if (!focusFirstError(signin)) return;
  const btn = $('#signin-submit');
  btn.disabled = true;
  try {
    const res = await api('/api/auth/login', { method: 'POST', body: { role, phone: $('#si-phone').value, password: $('#si-password').value } });
    go(res.home);
  } catch (err) {
    btn.disabled = false;
    showAlert(alertBox, 'error', err.message, err.status === 401 ? 'Check the number and password, and that the right tab is selected above.' : '');
    $('#si-password').value = '';
    $('#si-password').focus();
  }
});

// ---------- forgot password ----------
function resetForgot() {
  resetStep = 1;
  $('#fp-step2').hidden = true;
  $('#fp-code-note').innerHTML = '';
  $('#fp-code').value = ''; $('#fp-password').value = '';
  $('#fp-phone').readOnly = false;
  $('#forgot-submit').textContent = 'Send code';
}
liveValidate($('#fp-phone'), (v) => rules.phone(v));
liveValidate($('#fp-password'), (v) => rules.password(v));
forgot.addEventListener('submit', async (e) => {
  e.preventDefault();
  alertBox.innerHTML = '';
  const btn = $('#forgot-submit');
  if (resetStep === 1) {
    if (!setError($('#fp-phone'), rules.phone($('#fp-phone').value))) { $('#fp-phone').focus(); return; }
    btn.disabled = true;
    try {
      const res = await api('/api/auth/forgot', { method: 'POST', body: { role, phone: $('#fp-phone').value } });
      resetStep = 2;
      $('#fp-phone').readOnly = true;
      $('#fp-step2').hidden = false;
      btn.textContent = 'Set new password';
      $('#fp-code-note').innerHTML = res.demoCode
        ? `<div class="notice notice-info"><strong>Demo: your code is</strong><p class="code-box">${res.demoCode}</p><p class="small">A live app would send this code to your phone by SMS. It works for 10 minutes.</p></div>`
        : `<div class="notice notice-info"><p>${res.message} Check that the right tab is selected above.</p></div>`;
      $('#fp-code').focus();
    } catch (err) {
      showAlert(alertBox, 'error', 'We could not send a code.', err.message);
    } finally { btn.disabled = false; }
    return;
  }
  setError($('#fp-code'), /^\d{6}$/.test($('#fp-code').value.trim()) ? '' : 'Enter the 6-digit code.');
  setError($('#fp-password'), rules.password($('#fp-password').value));
  if (!focusFirstError(forgot)) return;
  btn.disabled = true;
  try {
    const res = await api('/api/auth/reset', { method: 'POST', body: { role, phone: $('#fp-phone').value, code: $('#fp-code').value.trim(), password: $('#fp-password').value } });
    go(res.home);
  } catch (err) {
    btn.disabled = false;
    if (err.data?.fields) {
      for (const [k, msg] of Object.entries(err.data.fields)) { const el = $(`#fp-${k}`); if (el) setError(el, msg); }
      focusFirstError(forgot);
    } else showAlert(alertBox, 'error', 'Your password was not changed.', err.message);
  }
});

getConfig().then((config) => {
  const checks = {
    'rg-name': rules.name, 'rg-phone': rules.phone, 'rg-password': rules.password,
    'rg-vehicle': (v) => (v ? '' : 'Choose your vehicle.'),
    'rg-storeName': (v) => { const s = v.trim(); return s.length < 2 || s.length > 60 ? 'Enter the store name, 2 to 60 characters.' : ''; },
    'rg-storeStreet': rules.street,
    'rg-storePincode': (v) => rules.pincode(v, config.serviceArea.pincodes)
  };
  for (const [id, fn] of Object.entries(checks)) liveValidate($(`#${id}`), fn);
  for (const id of ['rg-terms', 'rg-age']) $(`#${id}`).addEventListener('change', (e) => { if (e.target.checked) setError(e.target, ''); });

  register.addEventListener('submit', async (e) => {
    e.preventDefault();
    alertBox.innerHTML = '';
    const visible = Object.keys(checks).filter((id) => !$(`#${id}`).closest('[hidden]'));
    for (const id of visible) setError($(`#${id}`), checks[id]($(`#${id}`).value));
    setError($('#rg-terms'), $('#rg-terms').checked ? '' : 'Accept the Terms of service and Privacy policy to continue.');
    setError($('#rg-age'), $('#rg-age').checked ? '' : 'You must be 18 or older.');
    if (!focusFirstError(register)) return;
    const btn = $('#register-submit');
    btn.disabled = true;
    const body = { role, name: $('#rg-name').value, phone: $('#rg-phone').value, password: $('#rg-password').value, terms: true, age: true };
    if (role === 'rider') body.vehicle = $('#rg-vehicle').value;
    if (role === 'store') Object.assign(body, { storeName: $('#rg-storeName').value, storeStreet: $('#rg-storeStreet').value, storePincode: $('#rg-storePincode').value });
    try {
      const res = await api('/api/auth/register', { method: 'POST', body });
      go(res.home);
    } catch (err) {
      btn.disabled = false;
      if (err.data?.fields) {
        for (const [k, msg] of Object.entries(err.data.fields)) { const el = $(`#rg-${k}`); if (el) setError(el, msg); }
        focusFirstError(register);
      } else showAlert(alertBox, 'error', 'Your account was not created.', err.message);
    }
  });
});

render();
