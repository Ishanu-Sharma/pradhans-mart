// End-to-end check in a real headless Chrome, driven over the DevTools protocol (no extra packages).
// The browser plays one role at a time; the other roles act through the API at the same moment,
// so live updates between customer, store partner, delivery partner and admin are exercised.
// Run: node tests/e2e.mjs [path-to-chrome]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createApp } from '../server/server.js';

const CHROME = process.argv[2] || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmart-e2e-'));
const app = await createApp({ dataDir, env: { ADMIN_PASSWORD: 'e2e-admin-password', DEMO_MODE: '1' }, clock: () => new Date('2026-11-15T06:30:00Z') });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;

// API actors with their own cookie jars.
const jar = {};
const as = async (who, p, body) => {
  const res = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar[who] ? { Cookie: jar[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0];
  return res.json().catch(() => null);
};
const register = (who, role, phone, extra = {}) => as(who, '/api/auth/register', { role, name: extra.name || 'Test Person', phone, password: 'password-123', terms: true, age: true, ...extra });

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pmart-chrome-'));
const port = 9300 + Math.floor(Math.random() * 90);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
let version;
for (let i = 0; i < 50 && !version; i++) { try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(200); } }
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0; const pending = new Map(); const errors = [];
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error' && !/status of 4\d\d/.test(msg.params.entry.text)) errors.push(msg.params.entry.text);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const go = async (url) => { await send('Page.navigate', { url: base + url }); await sleep(900); };
const waitFor = async (expr, ms = 6000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { try { if (await evaluate(`return !!(${expr});`)) return true; } catch { /* page loading */ } await sleep(150); }
  return false;
};
const fill = (pairs) => evaluate(`for (const [id, v] of ${JSON.stringify(Object.entries(pairs))}) { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }`);
const click = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)}).click();`);
const signOut = async () => { await evaluate("await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });"); };
const signIn = async (role, phone) => {
  await go(`/login${role === 'customer' ? '' : `?role=${role}`}`);
  await fill({ 'si-phone': phone, 'si-password': 'password-123' });
  await evaluate("document.getElementById('signin-form').requestSubmit();");
};

try {
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
  await send('Browser.grantPermissions', { origin: base, permissions: ['geolocation'] });
  await send('Emulation.setGeolocationOverride', { latitude: 26.1406, longitude: 91.7898, accuracy: 20 });

  // Partners and admin set up through the API.
  await register('storeA', 'store', '9000000001', { name: 'Ankur Das', storeName: 'Zoo Road Store', storeStreet: 'Zoo Road, Tarun Nagar', storePincode: '781005' });
  await register('rider1', 'rider', '9100000001', { name: 'Bikash Kalita', vehicle: 'scooter' });
  await as('admin', '/api/admin/login', { password: 'e2e-admin-password' });
  for (const u of await as('admin', '/api/admin/users?role=pending')) await as('admin', `/api/admin/users/${u.id}/status`, { status: 'active' });
  await as('storeA', '/api/store/online', { online: true });
  await as('rider1', '/api/rider/online', { online: true });

  // ---------- login screen ----------
  await go('/');
  check('opening the site lands on sign in', await evaluate("return location.pathname === '/login';"));
  check('shop is not reachable without signing in', await evaluate("const r = await fetch('/shop', { redirect: 'manual' }); return r.type === 'opaqueredirect' || r.status === 302;"));
  check('split screen shows real product photos', await evaluate("return document.querySelectorAll('.auth-collage img').length >= 6 && [...document.querySelectorAll('.auth-collage img')].every(i => i.complete && i.naturalWidth > 0);"));
  check('cookie banner shows on first visit', await evaluate("return !document.getElementById('cookie-banner').hidden;"));
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  check('first Tab reaches the skip link', await evaluate("return document.activeElement.classList.contains('skip-link');"));
  await click('[data-consent="necessary"]');
  await evaluate("const t = document.getElementById('tab-customer'); t.focus(); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));");
  check('arrow keys move between role tabs', await evaluate("return document.activeElement.id === 'tab-rider' && document.getElementById('tab-rider').getAttribute('aria-selected') === 'true';"));
  await click('#tab-store'); await click('[data-mode="register"]');
  check('store sign-up shows store fields', await evaluate("return !document.querySelector('[data-for=\"store\"]').hidden && document.querySelector('[data-for=\"rider\"]').hidden;"));
  await click('#tab-customer');
  await evaluate("document.getElementById('register-form').requestSubmit();");
  check('empty sign-up shows inline errors with aria wiring', await evaluate("const i = document.getElementById('rg-phone'); return document.querySelectorAll('#register-form [aria-invalid=\"true\"]').length === 5 && i.getAttribute('aria-describedby').includes('rg-phone-error');"));
  await fill({ 'rg-name': 'Anjali Das', 'rg-phone': '9864012345', 'rg-password': 'password-123' });
  await click('#rg-terms'); await click('#rg-age');
  await evaluate("document.getElementById('register-form').requestSubmit();");
  check('customer sign-up lands in the shop', await waitFor("location.pathname === '/shop' && document.querySelectorAll('#products .product').length > 20"));

  // ---------- shop ----------
  check('every product card shows a loaded photo', await waitFor("[...document.querySelectorAll('#products img')].slice(0, 12).every(i => i.complete && i.naturalWidth > 0)"));
  check('category tiles have photos', await evaluate("return document.querySelectorAll('#categories img').length === 6;"));
  await click('[data-id="amul-butter-100g"] [data-action="add"]');
  await click('[data-id="amul-butter-100g"] [data-action="inc"]');
  await click('[data-id="tata-tea-gold-500g"] [data-action="add"]');
  check('cart button shows items and total', await waitFor("document.querySelector('[data-cart-summary]').textContent === '3 items, ₹424'"));
  check('focus stays on the stepper', await evaluate("return document.activeElement.dataset.action === 'inc';"));
  await fill({ q: 'parle' });
  check('header search filters live', await evaluate("return document.querySelectorAll('#products .product').length === 1;"));
  await fill({ q: '' });
  await waitFor("document.getElementById('live-state').dataset.state === 'live'");
  await as('storeA', '/api/store/stock', { stock: { 'parle-g-250g': 0 } });
  check('stock change from the store reaches the shop live', await waitFor("document.querySelector('[data-id=\"parle-g-250g\"] .badge-out')"));
  await as('storeA', '/api/store/stock', { stock: { 'parle-g-250g': 40 } });
  await click('[data-cart-link]');
  check('cart drawer shows photos and free delivery', await waitFor("document.getElementById('cart').open && document.querySelectorAll('#cart-lines img').length === 2 && document.getElementById('cart-summary').textContent.includes('Free')"));
  await evaluate("document.getElementById('cart').close();");

  // ---------- checkout ----------
  await go('/checkout');
  check('checkout fills the account name and number', await waitFor("document.getElementById('name').value === 'Anjali Das' && document.getElementById('phone').value === '9864012345'"));
  await evaluate("document.getElementById('step-1').requestSubmit();");
  check('missing address shows inline errors', await evaluate("return document.querySelectorAll('#step-1 [aria-invalid=\"true\"]').length === 3;"));
  await fill({ house: 'Flat 3B', street: 'GS Road, Christian Basti', pincode: '781005' });
  await click('#save-address');
  await evaluate("document.getElementById('step-1').requestSubmit();");
  check('step 2 opens with progress updated', await waitFor("!document.getElementById('step-2').hidden && document.querySelector('#steps li[data-step=\"1\"]').dataset.state === 'done'"));
  check('UPI is shown as not available in the demo', await evaluate("const u = document.querySelector('input[name=payment][value=upi_on_delivery]'); return u.disabled && u.closest('label').textContent.includes('Not available in this demo') && document.querySelector('input[name=payment][value=cod]').checked;"));
  await evaluate("document.querySelector('input[name=payment][value=cod]').checked = false;");
  await evaluate("document.getElementById('step-2').requestSubmit();");
  check('payment choice is required', await evaluate("return !document.getElementById('payment-error').hidden;"));
  await click('input[name=payment][value=cod]');
  await evaluate("document.getElementById('step-2').requestSubmit();");
  check('order is placed', await waitFor("!document.getElementById('step-3').hidden"));
  const trackHref = await evaluate("return document.querySelector('#confirmation a').getAttribute('href');");
  const orderId = trackHref.split('=')[1];

  // ---------- live tracking while the store and rider act ----------
  await go(trackHref);
  check('tracking shows the order waiting for the store', await waitFor("document.getElementById('status-text').textContent === 'Order placed' && document.getElementById('status-sub').textContent.includes('store')"));
  await waitFor("document.getElementById('live-state').dataset.state === 'live'");
  await as('storeA', `/api/store/orders/${orderId}/accept`, {});
  check('store acceptance appears live', await waitFor("document.getElementById('status-text').textContent === 'Accepted by the store' && document.getElementById('status-sub').textContent.includes('Zoo Road Store')"));
  await as('storeA', `/api/store/orders/${orderId}/packed`, {});
  await as('rider1', `/api/rider/orders/${orderId}/accept`, {});
  check('delivery partner assignment appears live', await waitFor("document.getElementById('status-text').textContent === 'Delivery partner assigned'"));
  await as('rider1', `/api/rider/orders/${orderId}/pickup`, {});
  await as('rider1', `/api/rider/orders/${orderId}/location`, { lat: 26.15, lng: 91.77, accuracy: 10 });
  check('rider location offers a distance check', await waitFor("document.getElementById('distance-btn')"));
  await click('#distance-btn');
  check('distance is computed on the device', await waitFor("/about [0-9.]+ km from you/.test(document.getElementById('rider-text').textContent)"));
  await as('rider1', `/api/rider/orders/${orderId}/delivered`, {});
  check('delivered arrives live', await waitFor("document.getElementById('status-card').dataset.status === 'delivered'"));
  await go('/shop');
  check('header shows the saved delivery area', await evaluate("return document.querySelector('.location-chip').textContent.includes('781005');"));
  await signOut();

  // ---------- store partner interface ----------
  await register('cust2', 'customer', '7002000001', { name: 'Rina Bora' });
  await signIn('store', '9000000001');
  check('store partner lands on the store app', await waitFor("location.pathname === '/store' && !document.getElementById('workspace').hidden"));
  check('store switch shows accepting orders', await evaluate("return document.getElementById('online-switch').getAttribute('aria-checked') === 'true';"));
  const two = await as('cust2', '/api/orders', { items: [{ id: 'tata-salt-1kg', qty: 2 }], customer: { name: 'Rina Bora', phone: '7002000001', house: 'H 12', street: 'Zoo Road', landmark: '', pincode: '781005' }, payment: 'cod', consents: {}, expectedTotal: 81 });
  check('new request appears live with a countdown', await waitFor(`document.querySelector('[data-order="${two.id}"] .countdown p')?.textContent.includes('seconds')`));
  check('request is announced for screen readers', await evaluate("return document.getElementById('announcer').textContent.includes('New order request');"));
  await click(`[data-order="${two.id}"] [data-act="accept"]`);
  check('accepted order moves to To pack', await waitFor(`document.querySelector('#list-pack [data-order="${two.id}"]')`));
  await click(`#list-pack [data-order="${two.id}"] [data-act="packed"]`);
  check('packed order waits for pickup', await waitFor(`document.querySelector('#list-hand [data-order="${two.id}"]')`));
  await click('#tab-stock');
  check('stock tab lists products with photos', await evaluate("return document.querySelectorAll('#stock-rows tr').length > 20 && document.querySelectorAll('#stock-rows img').length > 20;"));
  check('accepting took the stock', await evaluate("return document.getElementById('stock-tata-salt-1kg').value === '23';"));
  await signOut();

  // ---------- delivery partner interface ----------
  await signIn('rider', '9100000001');
  check('rider lands on the rider app with the request', await waitFor(`location.pathname === '/rider' && document.querySelector('[data-act="accept"][data-id="${two.id}"]')`));
  check('request shows pickup store and drop area only', await evaluate("const t = document.getElementById('rider-body').textContent; return t.includes('Zoo Road Store') && t.includes('781005') && !t.includes('H 12');"));
  await click(`[data-act="accept"][data-id="${two.id}"]`);
  check('accepted delivery shows the full address and call button', await waitFor("document.getElementById('rider-body').textContent.includes('H 12') && document.querySelector('a[href^=\"tel:\"]')"));
  check('cannot go offline mid-delivery', await evaluate("return document.getElementById('online-switch').disabled;"));
  await click('[data-act="pickup"]');
  check('pickup starts location sharing', await waitFor("/Sharing your location/.test(document.getElementById('share-status')?.textContent || '')"));
  await click('[data-act="delivered"]');
  check('delivered returns the rider to waiting', await waitFor("document.getElementById('rider-body').textContent.includes('Waiting for a delivery request')"));
  await signOut();

  // ---------- forgot password ----------
  await go('/login');
  await click('[data-mode="forgot"]');
  check('forgot password opens from sign in', await evaluate("return !document.getElementById('forgot-form').hidden && document.activeElement.id === 'fp-phone';"));
  await fill({ 'fp-phone': '9864012345' });
  await evaluate("document.getElementById('forgot-form').requestSubmit();");
  check('demo shows the reset code on screen', await waitFor("/^[0-9]{6}$/.test(document.querySelector('.code-box')?.textContent || '')"));
  const code = await evaluate("return document.querySelector('.code-box').textContent;");
  await fill({ 'fp-code': code, 'fp-password': 'brand-new-pass' });
  await evaluate("document.getElementById('forgot-form').requestSubmit();");
  check('reset signs the customer in', await waitFor("location.pathname === '/shop'"));
  await signOut();
  await go('/login');
  await fill({ 'si-phone': '9864012345', 'si-password': 'brand-new-pass' });
  await evaluate("document.getElementById('signin-form').requestSubmit();");
  check('new password works', await waitFor("location.pathname === '/shop'"));
  await signOut();

  // ---------- admin interface ----------
  await register('newRider', 'rider', '9100000002', { name: 'Pranjal Nath', vehicle: 'bicycle' });
  await go('/admin');
  check('admin sign-in explains how to reset its password', await evaluate("return document.querySelector('.forgot-admin').textContent.includes('ADMIN_PASSWORD');"));
  await fill({ password: 'e2e-admin-password' });
  await evaluate("document.getElementById('login').requestSubmit();");
  check('admin sees live stats', await waitFor("document.querySelectorAll('#stats .stat').length === 8"));
  check('admin sees the pending partner', await waitFor("document.getElementById('approvals-list').textContent.includes('Pranjal Nath')"));
  await click('#approvals-list [data-status="active"]');
  check('admin approves the partner', await waitFor("document.getElementById('approvals-alert').textContent.includes('approved')"));
  await click('#tab-orders');
  await fill({ 'order-filter': 'all' });
  check('admin sees every order with store and rider', await waitFor(`document.querySelector('[data-order="${orderId}"]')?.textContent.includes('Zoo Road Store')`));
  await click('#tab-stores');
  check('stores tab lists the store, offline after its owner signed out', await waitFor("document.getElementById('stores-table').textContent.includes('Zoo Road Store') && document.querySelector('#stores-table .tag-offline')"));
  await click('#tab-catalogue');
  check('catalogue lists products with photos', await waitFor("document.querySelectorAll('#product-rows img').length > 20"));

  // ---------- public pages ----------
  for (const p of ['/privacy', '/terms', '/refunds', '/cookies', '/contact', '/credits', '/data-request']) {
    await go(p);
    check(`${p} renders`, await evaluate("return !!document.querySelector('main h1');"));
  }
  await go('/credits');
  check('credits list every photo', await evaluate("return document.querySelectorAll('main tbody tr').length === 29;"));
  check('no JavaScript errors in the browser', errors.length === 0, errors.join(' | '));
} catch (err) {
  check('e2e run completed', false, err.stack || err.message);
} finally {
  ws.close();
  chrome.kill();
  await app.close();
  await sleep(500);
  fs.rmSync(dataDir, { recursive: true, force: true });
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may still hold files */ }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
