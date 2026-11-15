import { $, $$, getConfig, setError, liveValidate, storage, preferencesAllowed, esc } from './common.js';
import { rules, inServiceRadius } from './validators.js';

const form = $('#area-form');
const input = $('#pincode');
const result = $('#area-result');
const locBtn = $('#use-location');

function show(kind, title, text, withShopLink) {
  result.innerHTML = `<div class="notice notice-${kind}"><strong>${esc(title)}</strong>${text ? `<p>${esc(text)}</p>` : ''}${withShopLink ? '<p><a class="btn btn-secondary" href="/shop">Browse the shop</a></p>' : ''}</div>`;
}

getConfig().then((config) => {
  const pins = config.serviceArea.pincodes;
  const checkPin = (v) => rules.pincode(v, null);
  liveValidate(input, checkPin);

  const saved = preferencesAllowed() ? storage.get('pm_area', null) : null;
  if (saved?.pincode && !input.value) input.value = saved.pincode;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (!setError(input, checkPin(value))) { input.focus(); result.innerHTML = ''; return; }
    if (pins.includes(value)) {
      if (preferencesAllowed()) storage.set('pm_area', { pincode: value });
      show('success', `Yes, we deliver to ${value}.`, config.isOpen ? (config.hours.allDay ? 'We take orders 24 hours a day.' : `We are taking orders now, until ${config.hours.close}.`) : `We are closed right now. We take orders from ${config.hours.open} to ${config.hours.close}. You can still browse.`, true);
    } else {
      show('warn', `We do not deliver to ${value} yet.`, 'We deliver only within Guwahati, to the pincodes listed in the questions below.', false);
    }
  });

  if (!('geolocation' in navigator)) { locBtn.hidden = true; $('#location-note').hidden = true; return; }
  locBtn.addEventListener('click', () => {
    locBtn.disabled = true;
    result.innerHTML = '<p class="muted">Finding your location&hellip;</p>';
    navigator.geolocation.getCurrentPosition((pos) => {
      locBtn.disabled = false;
      const here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (inServiceRadius(here, config.serviceArea)) {
        show('success', 'You are inside our delivery area.', 'Enter your pincode at checkout so we can confirm the exact address.', true);
      } else {
        show('warn', 'You are outside our delivery area.', 'We deliver only within Guwahati. If you are ordering for an address in Guwahati, check its pincode instead.', false);
      }
    }, (err) => {
      locBtn.disabled = false;
      const msg = err.code === err.PERMISSION_DENIED
        ? 'Location permission was not given. Enter your pincode instead.'
        : 'We could not get your location. Enter your pincode instead.';
      show('warn', 'Location not available', msg, false);
    }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 });
  });
}).catch(() => {
  show('error', 'The area check is not available right now.', 'Refresh the page to try again.', false);
});

// Every "Check my area" link moves focus to the pincode field.
for (const link of $$('[data-cta]')) {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    $('#area-check').scrollIntoView({ block: 'center' });
    input.focus({ preventScroll: true });
  });
}

// Hide the sticky bar while the form itself is on screen.
const sticky = $('#sticky-cta');
if (sticky && 'IntersectionObserver' in window) {
  new IntersectionObserver(([entry]) => { sticky.hidden = entry.isIntersecting; }).observe($('#area-check'));
}
