import { $, $$, api, setError, liveValidate, focusFirstError, showAlert, esc } from './common.js';
import { rules } from './validators.js';

const alertBox = $('#login-alert');
const signin = $('#signin-form');
const register = $('#register-form');

// Only same-site paths are allowed as a destination after signing in.
const nextParam = new URLSearchParams(window.location.search).get('next') || '';
const next = /^\/(?!\/)[\w\-/]*$/.test(nextParam) ? nextParam : '/account';

function show(which) {
  signin.hidden = which !== 'signin';
  register.hidden = which !== 'register';
  alertBox.innerHTML = '';
  (which === 'signin' ? $('#si-phone') : $('#rg-name')).focus();
}
for (const b of $$('[data-show]')) b.addEventListener('click', () => show(b.dataset.show));
if (window.location.hash === '#register') { signin.hidden = true; register.hidden = false; }

function showFieldErrors(fields, prefix) {
  for (const [k, msg] of Object.entries(fields)) {
    const el = document.getElementById(`${prefix}-${k}`);
    if (el) setError(el, msg);
  }
}

liveValidate($('#si-phone'), (v) => rules.phone(v));
signin.addEventListener('submit', async (e) => {
  e.preventDefault();
  alertBox.innerHTML = '';
  setError($('#si-phone'), rules.phone($('#si-phone').value));
  setError($('#si-password'), $('#si-password').value ? '' : 'Enter your password.');
  if (!focusFirstError(signin)) return;
  const btn = signin.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    await api('/api/account/login', { method: 'POST', body: { phone: $('#si-phone').value, password: $('#si-password').value } });
    window.location.href = next;
  } catch (err) {
    btn.disabled = false;
    showAlert(alertBox, 'error', err.message, err.status === 401 ? 'Check the number and password, or create an account.' : '');
    $('#si-password').value = '';
    $('#si-password').focus();
  }
});

for (const [id, rule] of [['rg-name', rules.name], ['rg-phone', rules.phone], ['rg-password', rules.password]]) liveValidate($(`#${id}`), rule);
for (const id of ['rg-terms', 'rg-age']) $(`#${id}`).addEventListener('change', (e) => { if (e.target.checked) setError(e.target, ''); });

register.addEventListener('submit', async (e) => {
  e.preventDefault();
  alertBox.innerHTML = '';
  setError($('#rg-name'), rules.name($('#rg-name').value));
  setError($('#rg-phone'), rules.phone($('#rg-phone').value));
  setError($('#rg-password'), rules.password($('#rg-password').value));
  setError($('#rg-terms'), $('#rg-terms').checked ? '' : 'Accept the Terms of service and Privacy policy to create an account.');
  setError($('#rg-age'), $('#rg-age').checked ? '' : 'You must be 18 or older to create an account.');
  if (!focusFirstError(register)) return;
  const btn = register.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    await api('/api/account/register', {
      method: 'POST',
      body: { name: $('#rg-name').value, phone: $('#rg-phone').value, password: $('#rg-password').value, terms: $('#rg-terms').checked, age: $('#rg-age').checked }
    });
    window.location.href = next;
  } catch (err) {
    btn.disabled = false;
    if (err.data?.fields) { showFieldErrors(err.data.fields, 'rg'); focusFirstError(register); }
    else showAlert(alertBox, 'error', 'Your account was not created.', err.message);
  }
});

// Already signed in: say so instead of showing an empty form.
api('/api/account/me').then((me) => {
  alertBox.innerHTML = `<div class="notice notice-success"><strong>You are signed in as ${esc(me.name)}.</strong><p><a href="/account">Go to your account</a></p></div>`;
}).catch(() => {});
