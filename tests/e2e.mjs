// End-to-end check in a real headless Chrome, driven over the DevTools protocol (no extra packages).
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
const app = createApp({ dataDir, env: { ADMIN_PASSWORD: 'e2e-admin-password' }, clock: () => new Date('2026-11-15T06:30:00Z') });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;

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
const waitFor = async (expr, ms = 5000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await evaluate(`return !!(${expr});`)) return true; await sleep(150); }
  return false;
};

try {
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
  await send('Browser.grantPermissions', { origin: base, permissions: ['geolocation'] });
  await send('Emulation.setGeolocationOverride', { latitude: 26.1406, longitude: 91.7898, accuracy: 20 }); // Dispur, Guwahati

  // Home: banner, keyboard, area check.
  await go('/');
  check('cookie banner shows on first visit', await evaluate(`return !document.getElementById('cookie-banner').hidden;`));
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  check('first Tab reaches the skip link', await evaluate(`return document.activeElement.classList.contains('skip-link');`));
  await evaluate(`document.querySelector('[data-consent="necessary"]').click();`);
  check('banner closes and choice is stored', await evaluate(`return document.getElementById('cookie-banner').hidden && JSON.parse(localStorage.pm_consent).preferences === false;`));

  await evaluate(`const i=document.getElementById('pincode'); i.value='12'; document.getElementById('area-form').requestSubmit();`);
  check('invalid pincode shows inline error with aria wiring', await evaluate(`const i=document.getElementById('pincode'); return i.getAttribute('aria-invalid')==='true' && i.getAttribute('aria-describedby').includes('pincode-error') && !document.getElementById('pincode-error').hidden;`));
  await evaluate(`const i=document.getElementById('pincode'); i.value='781005'; i.dispatchEvent(new Event('input')); document.getElementById('area-form').requestSubmit();`);
  check('Guwahati pincode is accepted', await waitFor(`document.getElementById('area-result').textContent.includes('we deliver to 781005')`));
  await evaluate(`const i=document.getElementById('pincode'); i.value='110001'; document.getElementById('area-form').requestSubmit();`);
  check('Delhi pincode is refused', await waitFor(`document.getElementById('area-result').textContent.includes('do not deliver to 110001')`));
  await evaluate(`document.getElementById('use-location').click();`);
  check('device location inside Guwahati is recognised', await waitFor(`document.getElementById('area-result').textContent.includes('inside our delivery area')`));
  check('CTA labels are identical', await evaluate(`return [...document.querySelectorAll('.btn-primary')].every(b => b.textContent.trim()==='Check my area');`));

  // Shop: add items, live stock.
  await go('/shop');
  check('products render', await waitFor(`document.querySelectorAll('#products .product').length > 20`));
  await evaluate(`const add=id=>document.querySelector('[data-id="'+id+'"] [data-action="add"]').click(); add('amul-butter-100g'); document.querySelector('[data-id="amul-butter-100g"] [data-action="inc"]').click(); add('tata-tea-gold-500g');`);
  check('cart count updates and is announced in the link label', await evaluate(`return document.querySelector('[data-cart-count]').textContent==='3' && document.querySelector('[data-cart-link]').getAttribute('aria-label')==='Cart, 3 items';`));
  check('focus stays on the stepper after adding', await evaluate(`return document.activeElement.dataset.action==='inc';`));
  await evaluate(`document.querySelector('[data-cart-link]').click();`);
  check('cart drawer opens with free delivery over the threshold', await waitFor(`document.getElementById('cart').open && document.getElementById('cart-summary').textContent.includes('Free') && document.getElementById('cart-summary').textContent.includes('424')`));
  await evaluate(`document.getElementById('cart').close();`);
  check('search filters products', await evaluate(`const s=document.getElementById('search'); s.value='parle'; s.dispatchEvent(new Event('input')); return document.querySelectorAll('#products .product').length===1;`));

  // Live stock: change stock from the admin API while the shop is open.
  await waitFor(`document.getElementById('live-state').dataset.state==='live'`);
  const login = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'e2e-admin-password' }) });
  const adminCookie = login.headers.get('set-cookie').split(';')[0];
  const adminPost = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify(body) }).then((r) => r.json());
  await adminPost('/api/admin/products/parle-g-250g', { stock: 0 });
  check('stock change reaches the open shop page live', await waitFor(`document.querySelector('[data-id="parle-g-250g"] .stock-out')`));
  await adminPost('/api/admin/products/parle-g-250g', { stock: 70 });

  // Checkout.
  await go('/checkout');
  await waitFor(`document.getElementById('summary-totals').textContent.includes('424')`);
  await evaluate(`document.getElementById('step-1').requestSubmit();`);
  check('empty address shows five inline errors and focuses the first', await evaluate(`return document.querySelectorAll('#step-1 [aria-invalid="true"]').length===5 && document.activeElement.id==='name';`), 'landmark is optional');
  await evaluate(`const set=(id,v)=>{const e=document.getElementById(id); e.value=v; e.dispatchEvent(new Event('input'));};
    set('name','Anjali Das'); set('phone','9864012345'); set('house','Flat 3B'); set('street','GS Road, Christian Basti'); set('pincode','781005');
    document.getElementById('step-1').requestSubmit();`);
  check('step 2 opens and step 1 is marked done', await waitFor(`!document.getElementById('step-2').hidden && document.querySelector('#steps li[data-step="1"]').dataset.state==='done' && document.querySelector('#steps li[data-step="2"]').getAttribute('aria-current')==='step'`));
  check('consent boxes start unticked', await evaluate(`return !document.getElementById('terms').checked && !document.getElementById('age').checked && !document.getElementById('marketing').checked && !document.querySelector('input[name=payment]:checked');`));
  await evaluate(`document.getElementById('step-2').requestSubmit();`);
  check('terms, age and payment are required', await evaluate(`return !document.getElementById('terms-error').hidden && !document.getElementById('age-error').hidden && !document.getElementById('payment-error').hidden;`));
  check('place order button states the full amount', await evaluate(`return document.getElementById('place-order').textContent.includes('424');`));
  await evaluate(`document.querySelector('input[name=payment][value=upi_on_delivery]').click(); document.getElementById('terms').click(); document.getElementById('age').click(); document.getElementById('step-2').requestSubmit();`);
  check('order is placed and confirmation shows', await waitFor(`!document.getElementById('step-3').hidden && document.getElementById('confirmation').textContent.includes('is placed')`));
  const trackHref = await evaluate(`return document.querySelector('#confirmation a').getAttribute('href');`);
  check('cart is cleared after ordering', await evaluate(`return JSON.parse(localStorage.pm_cart).length===0;`));
  const orderId = trackHref.match(/PM[A-Z0-9]{8}/)[0];

  // Tracking page with live updates.
  await go(trackHref);
  check('tracking page shows the order', await waitFor(`document.getElementById('status-text').textContent==='Order placed'`));
  await waitFor(`document.getElementById('live-state').dataset.state==='live'`);
  await adminPost(`/api/admin/orders/${orderId}/status`, { status: 'accepted' });
  check('status updates live without reload', await waitFor(`document.getElementById('status-text').textContent==='Accepted by the store'`));
  const rider = await adminPost('/api/admin/riders', { name: 'Bikash Kalita' });
  await adminPost(`/api/admin/orders/${orderId}/status`, { status: 'packed' });
  await adminPost(`/api/admin/orders/${orderId}/rider`, { riderId: rider.id });
  const rl = await fetch(`${base}/api/rider/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: rider.code }) });
  const riderCookie = rl.headers.get('set-cookie').split(';')[0];
  const riderPost = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: riderCookie }, body: JSON.stringify(body) });
  await riderPost(`/api/rider/orders/${orderId}/start`, {});
  await riderPost(`/api/rider/orders/${orderId}/location`, { lat: 26.1500, lng: 91.7700, accuracy: 10 });
  check('rider location appears with a show-distance button', await waitFor(`document.getElementById('rider-text').textContent.includes('Bikash') && document.getElementById('distance-btn')`));
  await evaluate(`document.getElementById('distance-btn').click();`);
  check('distance computed on device', await waitFor(`/about [0-9.]+ km from you/.test(document.getElementById('rider-text').textContent)`), await evaluate(`return document.getElementById('rider-text').textContent;`));
  await riderPost(`/api/rider/orders/${orderId}/delivered`, {});
  check('delivered status arrives live', await waitFor(`document.getElementById('status-text').textContent==='Delivered' && document.getElementById('rider-box').hidden`));

  // Customer account: sign-in page, register, header, checkout prefill, account page.
  await go('/');
  check('header has a Sign in link', await evaluate(`return !!document.querySelector('.nav-list a[href="/login"]');`));
  await go('/login');
  check('sign-in page offers customer, admin and rider', await evaluate(`return !!document.getElementById('signin-form') && !!document.querySelector('a[href="/admin"]') && !!document.querySelector('a[href="/rider"]');`));
  await evaluate(`document.querySelector('[data-show="register"]').click();`);
  check('create-account form opens and takes focus', await evaluate(`return !document.getElementById('register-form').hidden && document.activeElement.id==='rg-name';`));
  await evaluate(`document.getElementById('register-form').requestSubmit();`);
  check('empty sign-up shows five inline errors', await evaluate(`return document.querySelectorAll('#register-form [aria-invalid="true"]').length===5;`));
  await evaluate(`const s=(id,v)=>{const e=document.getElementById(id); e.value=v; e.dispatchEvent(new Event('input'));};
    s('rg-name','Rina Bora'); s('rg-phone','7896000002'); s('rg-password','good-password-1');
    document.getElementById('rg-terms').click(); document.getElementById('rg-age').click();
    document.getElementById('register-form').requestSubmit();`);
  check('sign-up lands on the account page', await waitFor(`location.pathname==='/account' && document.getElementById('acct-sub').textContent.includes('Rina Bora')`));
  check('header now shows Account', await evaluate(`return !!document.querySelector('.nav-list a[href="/account"]');`));
  await evaluate(`const s=(id,v)=>{document.getElementById(id).value=v;}; s('house','House 12'); s('street','Zoo Road, Tarun Nagar'); s('pincode','781005'); document.getElementById('addr-form').requestSubmit();`);
  check('address saves from the account page', await waitFor(`document.getElementById('acct-alert').textContent.includes('Address saved')`));
  await go('/shop');
  await waitFor(`document.querySelectorAll('#products .product').length > 20`);
  await evaluate(`document.querySelector('[data-id="tata-salt-1kg"] [data-action="add"]').click();`);
  await go('/checkout');
  check('checkout fills in the signed-in customer', await waitFor(`document.getElementById('name').value==='Rina Bora' && document.getElementById('phone').value==='7896000002' && document.getElementById('street').value==='Zoo Road, Tarun Nagar' && !document.getElementById('save-address-row').hidden`));
  await go('/account');
  await waitFor(`document.getElementById('acct-sub').textContent.includes('Rina')`);
  await evaluate(`document.getElementById('signout').click();`);
  check('sign out returns home with Sign in link', await waitFor(`location.pathname==='/' && document.querySelector('.nav-list a[href="/login"]')`));
  await go('/login');
  await evaluate(`document.getElementById('si-phone').value='7896000002'; document.getElementById('si-password').value='wrong-password'; document.getElementById('signin-form').requestSubmit();`);
  check('wrong password shows an error', await waitFor(`document.getElementById('login-alert').textContent.includes('do not match')`));
  await evaluate(`document.getElementById('si-password').value='good-password-1'; document.getElementById('signin-form').requestSubmit();`);
  check('sign in with the right password works', await waitFor(`location.pathname==='/account'`));
  await evaluate(`await fetch('/api/account/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}); localStorage.pm_cart='[]';`);

  // Staff interfaces render.
  await go('/admin');
  await waitFor(`!document.getElementById('login').hidden`);
  await evaluate(`document.getElementById('password').value='e2e-admin-password'; document.getElementById('login').requestSubmit();`);
  check('admin dashboard signs in and loads products', await waitFor(`!document.getElementById('dashboard').hidden && document.querySelectorAll('#product-rows tr').length > 20`));
  await evaluate(`document.getElementById('order-filter').value='all'; document.getElementById('order-filter').dispatchEvent(new Event('change'));`);
  check('admin sees the delivered order', await waitFor(`document.querySelector('[data-order="${orderId}"]')`));
  check('arrow keys move between dashboard tabs', await evaluate(`const t=document.getElementById('tab-orders'); t.focus(); t.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})); return document.activeElement.id==='tab-products' && !document.getElementById('panel-products').hidden;`));

  // Data rights.
  await go('/data-request');
  await evaluate(`document.getElementById('orderId').value='${orderId}'; document.getElementById('phone').value='9864012345'; document.querySelector('input[name=type][value=delete]').click(); document.getElementById('confirm').click(); document.getElementById('request-form').requestSubmit();`);
  check('data deletion completes from the page', await waitFor(`document.getElementById('request-alert').textContent.includes('personal data is deleted')`));

  // Policy pages.
  for (const p of ['/privacy', '/terms', '/refunds', '/cookies', '/contact']) {
    await go(p);
    check(`${p} renders an h1`, await evaluate(`return !!document.querySelector('main h1');`));
  }
  await go('/cookies');
  await evaluate(`document.querySelector('main [data-cookie-settings]').click();`);
  check('cookie settings reopen from the cookie policy', await evaluate(`return !document.getElementById('cookie-banner').hidden && document.activeElement.dataset.consent==='necessary';`));

  check('no JavaScript errors in the browser', errors.length === 0, errors.join(' | '));
} catch (err) {
  check('e2e run completed', false, err.message);
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
