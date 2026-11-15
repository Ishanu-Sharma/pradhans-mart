import { $, api, showAlert } from './common.js';

const token = new URLSearchParams(window.location.search).get('t');
const panel = $('#unsub-panel');
const alertBox = $('#unsub-alert');

if (!token) {
  panel.hidden = true;
  showAlert(alertBox, 'warn', 'This link is incomplete.', 'Use the unsubscribe link from the bottom of any offer email.');
} else {
  $('#unsub-button').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      await api('/api/unsubscribe', { method: 'POST', body: { token } });
      panel.hidden = true;
      showAlert(alertBox, 'success', 'You are unsubscribed.', 'We will not send you offer emails, and we have deleted your email address.');
    } catch (err) {
      e.currentTarget.disabled = false;
      showAlert(alertBox, 'error', 'Something went wrong.', err.message);
    }
  });
}
