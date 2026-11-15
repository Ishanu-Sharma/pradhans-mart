import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/server.js';
import { isOpen } from '../server/util.js';

const NOON_IST = () => new Date('2026-11-15T06:30:00Z'); // 12:00 in Guwahati
const MIDNIGHT_IST = () => new Date('2026-11-15T18:45:00Z'); // 00:15 in Guwahati
let app; let base; let dir;
let clock = NOON_IST;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmart-test-'));
  app = createApp({ dataDir: dir, env: { ADMIN_PASSWORD: 'test-password-123', PORT: '0' }, clock: () => clock(), rateScale: 100 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = async (p, { method = 'GET', body, cookie } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text, headers: res.headers };
};

const customer = { name: 'Anjali Das', phone: '98640 12345', house: 'Flat 3B, Green Residency', street: 'GS Road, Christian Basti', landmark: 'Near the petrol pump', pincode: '781005' };
const orderBody = (over = {}) => ({
  items: [{ id: 'amul-butter-100g', qty: 2 }, { id: 'tata-salt-1kg', qty: 1 }],
  customer, payment: 'cod', consents: { terms: true, age: true }, expectedTotal: 62 * 2 + 28 + 25, ...over
});

test('every page renders with security headers and no dashes or third-party sources', async () => {
  for (const p of ['/', '/shop', '/checkout', '/order', '/data-request', '/unsubscribe', '/privacy', '/terms', '/refunds', '/cookies', '/contact', '/admin', '/rider']) {
    const r = await call(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    assert.ok(!/[—–]/.test(r.text), `dash on ${p}`);
    assert.ok(!/src="https?:/.test(r.text) && !/href="https?:\/\/(?!localhost)/.test(r.text.replace(/<link rel="canonical"[^>]*>/, '')), `external resource on ${p}`);
    assert.match(r.text, /<title>[^<]+<\/title>/);
    assert.match(r.text, /class="skip-link"/);
  }
  assert.equal((await call('/nope')).status, 404);
});

test('static files are served and path traversal is blocked', async () => {
  assert.equal((await call('/favicon.ico')).status, 200);
  assert.equal((await call('/assets/css/site.css')).status, 200);
  assert.equal((await call('/..%2fconfig%2fbusiness.json')).status, 404);
  assert.equal((await call('/assets/../../config/business.json')).status, 404);
});

test('config and products are public, staff APIs are not', async () => {
  const c = await call('/api/config');
  assert.equal(c.json.city, 'Guwahati');
  assert.equal(c.json.isOpen, true);
  const p = await call('/api/products');
  assert.ok(p.json.length > 20);
  assert.ok(p.json.every((x) => x.countryOfOrigin === 'India' && x.price <= x.mrp));
  assert.equal((await call('/api/admin/orders')).status, 401);
  assert.equal((await call('/api/rider/orders')).status, 401);
});

test('order validation: consent, age, area, payment and totals are enforced by the server', async () => {
  let r = await call('/api/orders', { method: 'POST', body: orderBody({ consents: { terms: false, age: false } }) });
  assert.equal(r.status, 422);
  assert.ok(r.json.fields.terms && r.json.fields.age);
  r = await call('/api/orders', { method: 'POST', body: orderBody({ customer: { ...customer, pincode: '110001' } }) });
  assert.equal(r.status, 422); assert.ok(r.json.fields.pincode);
  r = await call('/api/orders', { method: 'POST', body: orderBody({ customer: { ...customer, phone: '12345' } }) });
  assert.equal(r.status, 422); assert.ok(r.json.fields.phone);
  r = await call('/api/orders', { method: 'POST', body: orderBody({ payment: 'card' }) });
  assert.equal(r.status, 422); assert.ok(r.json.fields.payment);
  r = await call('/api/orders', { method: 'POST', body: orderBody({ shareLocation: true, location: { lat: 28.61, lng: 77.2 } }) });
  assert.equal(r.status, 422); assert.ok(r.json.fields.location, 'Delhi location rejected');
  r = await call('/api/orders', { method: 'POST', body: orderBody({ expectedTotal: 1 }) });
  assert.equal(r.status, 409); assert.equal(r.json.code, 'total_changed'); assert.equal(r.json.totals.total, 177);
  r = await call('/api/orders', { method: 'POST', body: orderBody({ items: [{ id: 'amul-butter-100g', qty: 999 }], expectedTotal: 0 }) });
  assert.equal(r.status, 422);
});

test('orders are refused when the store is closed', async () => {
  clock = MIDNIGHT_IST;
  try {
    const r = await call('/api/orders', { method: 'POST', body: orderBody() });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /closed/);
  } finally { clock = NOON_IST; }
  assert.equal(isOpen({ open: '07:00', close: '23:00', timeZone: 'Asia/Kolkata' }, NOON_IST()), true);
});

test('full order flow: place, track, admin, rider, live location, delivery', async () => {
  const stockBefore = (await call('/api/products')).json.find((p) => p.id === 'amul-butter-100g').stock;
  const placed = await call('/api/orders', { method: 'POST', body: orderBody({ shareLocation: true, location: { lat: 26.1406, lng: 91.7898 } }) });
  assert.equal(placed.status, 201);
  const { id, token } = placed.json;
  assert.match(id, /^PM[A-Z0-9]{8}$/);
  assert.equal(placed.json.total, 177);
  const stockAfter = (await call('/api/products')).json.find((p) => p.id === 'amul-butter-100g').stock;
  assert.equal(stockAfter, stockBefore - 2);

  assert.equal((await call(`/api/orders/${id}?t=wrong`)).status, 404);
  const view = await call(`/api/orders/${id}?t=${token}`);
  assert.equal(view.json.status, 'placed');
  assert.equal(view.json.canCancel, true);
  assert.equal(view.json.address.pincode, '781005');

  // Lookup by order ID and phone issues a new token.
  const look = await call('/api/orders/lookup', { method: 'POST', body: { orderId: id.toLowerCase(), phone: '+91 9864012345' } });
  assert.equal(look.status, 200);
  assert.equal((await call('/api/orders/lookup', { method: 'POST', body: { orderId: id, phone: '9999999999' } })).status, 404);

  // Admin signs in.
  assert.equal((await call('/api/admin/login', { method: 'POST', body: { password: 'nope' } })).status, 401);
  const login = await call('/api/admin/login', { method: 'POST', body: { password: 'test-password-123' } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);

  // Rider created and assigned.
  const rider = await call('/api/admin/riders', { method: 'POST', body: { name: 'Bikash Kalita' }, cookie });
  assert.equal(rider.status, 201);
  assert.match(rider.json.code, /^[A-Z2-9]{10}$/);
  assert.equal((await call(`/api/admin/orders/${id}/status`, { method: 'POST', body: { status: 'delivered' }, cookie })).status, 409, 'cannot skip steps');
  assert.equal((await call(`/api/admin/orders/${id}/status`, { method: 'POST', body: { status: 'accepted' }, cookie })).status, 200);
  assert.equal((await call(`/api/admin/orders/${id}/status`, { method: 'POST', body: { status: 'packed' }, cookie })).status, 200);
  assert.equal((await call(`/api/orders/${id}/cancel`, { method: 'POST', body: { token } })).status, 409, 'customer cannot cancel once packed');
  assert.equal((await call(`/api/admin/orders/${id}/rider`, { method: 'POST', body: { riderId: rider.json.id }, cookie })).status, 200);

  // Rider signs in, starts, shares location, delivers.
  const rl = await call('/api/rider/login', { method: 'POST', body: { code: rider.json.code.toLowerCase() } });
  assert.equal(rl.status, 200);
  const rcookie = rl.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/api/admin/orders', { cookie: rcookie })).status, 401, 'rider cannot use admin API');
  const mine = await call('/api/rider/orders', { cookie: rcookie });
  assert.equal(mine.json.length, 1);
  assert.equal(mine.json[0].customer.phone, '9864012345');
  assert.equal((await call(`/api/rider/orders/${id}/location`, { method: 'POST', body: { lat: 26.15, lng: 91.77 }, cookie: rcookie })).status, 409, 'no location before start');
  assert.equal((await call(`/api/rider/orders/${id}/start`, { method: 'POST', body: {}, cookie: rcookie })).status, 200);

  // Customer listens on the live stream while the rider moves.
  const ctrl = new AbortController();
  const streamRes = await fetch(`${base}/api/orders/${id}/stream?t=${token}`, { signal: ctrl.signal });
  assert.equal(streamRes.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = streamRes.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const waitFor = async (pred) => {
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      const { value } = await reader.read();
      buf += dec.decode(value);
      const frames = buf.split('\n\n').filter((f) => f.startsWith('event: order')).map((f) => JSON.parse(f.split('\ndata: ')[1]));
      const hit = frames.find(pred);
      if (hit) return hit;
    }
    throw new Error('no matching event');
  };
  await waitFor((o) => o.status === 'out_for_delivery');
  assert.equal((await call(`/api/rider/orders/${id}/location`, { method: 'POST', body: { lat: 26.1500, lng: 91.7700, accuracy: 12 }, cookie: rcookie })).status, 200);
  const live = await waitFor((o) => o.riderLocation && o.riderLocation.lat === 26.15);
  assert.equal(live.rider.name, 'Bikash');
  assert.equal(live.customerLocation.lat, 26.1406);

  assert.equal((await call(`/api/rider/orders/${id}/delivered`, { method: 'POST', body: {}, cookie: rcookie })).status, 200);
  const done = await waitFor((o) => o.status === 'delivered');
  assert.equal(done.riderLocation, null, 'rider location dropped on delivery');
  ctrl.abort();

  // Rider location never reaches disk.
  const disk = fs.readFileSync(path.join(dir, 'db.json'), 'utf8');
  assert.ok(!disk.includes('91.77,') && !disk.includes('"accuracy"'));
});

test('customer cancel restores stock', async () => {
  const before = (await call('/api/products')).json.find((p) => p.id === 'tata-salt-1kg').stock;
  const r = await call('/api/orders', { method: 'POST', body: orderBody({ items: [{ id: 'tata-salt-1kg', qty: 3 }], expectedTotal: 28 * 3 + 25 }) });
  assert.equal(r.status, 201);
  assert.equal((await call('/api/products')).json.find((p) => p.id === 'tata-salt-1kg').stock, before - 3);
  const c = await call(`/api/orders/${r.json.id}/cancel`, { method: 'POST', body: { token: r.json.token } });
  assert.equal(c.json.status, 'cancelled');
  assert.equal((await call('/api/products')).json.find((p) => p.id === 'tata-salt-1kg').stock, before);
});

test('free delivery applies at the threshold', async () => {
  const r = await call('/api/orders', { method: 'POST', body: orderBody({ items: [{ id: 'tata-tea-gold-500g', qty: 1 }], expectedTotal: 300 }) });
  assert.equal(r.status, 201);
  const v = await call(`/api/orders/${r.json.id}?t=${r.json.token}`);
  assert.equal(v.json.deliveryFee, 0);
  await call(`/api/orders/${r.json.id}/cancel`, { method: 'POST', body: { token: r.json.token } });
});

test('marketing email: opt-in only, email in outbox has unsubscribe link, one-click unsubscribe deletes it', async () => {
  const r = await call('/api/orders', { method: 'POST', body: orderBody({ customer: { ...customer, phone: '7002000001' }, consents: { terms: true, age: true, marketing: true, email: 'buyer@example.in' } }) });
  assert.equal(r.status, 201);
  const db = app.db.data;
  const sub = db.subscribers.find((s) => s.email === 'buyer@example.in');
  assert.ok(sub);
  const mail = db.outbox.at(-1);
  assert.match(mail.text, /\/unsubscribe\?t=/);
  assert.match(mail.headers['List-Unsubscribe'], /^<http.*unsubscribe\?t=/);
  assert.equal(mail.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  const one = await fetch(`${base}/unsubscribe?t=${sub.unsubscribeToken}`, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(one.status, 200);
  assert.ok(!app.db.data.subscribers.some((s) => s.email === 'buyer@example.in'));
  await call(`/api/orders/${r.json.id}/cancel`, { method: 'POST', body: { token: r.json.token } });
});

test('data export and deletion', async () => {
  const phone = '6000000009';
  const r = await call('/api/orders', { method: 'POST', body: orderBody({ customer: { ...customer, phone }, consents: { terms: true, age: true, marketing: true, email: 'del@example.in' } }) });
  const { id, token } = r.json;
  let d = await call('/api/data-requests', { method: 'POST', body: { orderId: id, phone, type: 'delete', confirm: true } });
  assert.equal(d.status, 409, 'refused while order is active');
  d = await call('/api/data-requests', { method: 'POST', body: { orderId: id, phone, type: 'delete' } });
  assert.equal(d.status, 422, 'needs confirmation');
  const exp = await call('/api/data-requests', { method: 'POST', body: { orderId: id, phone, type: 'export' } });
  assert.equal(exp.status, 200);
  assert.equal(exp.json.orders[0].phone, phone);
  assert.equal(exp.json.marketingEmails[0].email, 'del@example.in');
  await call(`/api/orders/${id}/cancel`, { method: 'POST', body: { token } });
  d = await call('/api/data-requests', { method: 'POST', body: { orderId: id, phone, type: 'delete', confirm: true } });
  assert.equal(d.status, 200);
  assert.equal(d.json.deletedSubscriptions, 1);
  const o = app.db.order(id);
  assert.equal(o.customer.phone, null);
  assert.equal(o.customer.name, null);
  assert.equal(o.total, 177, 'amounts kept for GST');
  assert.equal((await call(`/api/orders/${id}?t=${token}`)).status, 404, 'old link stops working');
  assert.ok(!JSON.stringify(app.db.data).includes(phone));
});

test('order rate limit applies per connection', async () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pmart-rl-'));
  const app2 = createApp({ dataDir: d2, env: { ADMIN_PASSWORD: 'test-password-123' }, clock: NOON_IST });
  await new Promise((r) => app2.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app2.server.address().port}/api/orders`;
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
  await app2.close(); fs.rmSync(d2, { recursive: true, force: true });
  assert.equal(codes.at(-1), 429);
  assert.ok(codes.slice(0, 10).every((c) => c === 422));
});

test('cross-site POSTs are blocked', async () => {
  const res = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('admin cannot list a product priced above MRP or without the Indian brand check', async () => {
  const login = await call('/api/admin/login', { method: 'POST', body: { password: 'test-password-123' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  let r = await call('/api/admin/products', { method: 'POST', cookie, body: { name: 'Test Ghee', brand: 'Test', brandOwner: 'Test Ltd', category: 'staples', netQuantity: '500 ml', mrp: 100, price: 120, stock: 5, indianBrandConfirmed: true } });
  assert.equal(r.status, 422); assert.ok(r.json.fields.price);
  r = await call('/api/admin/products', { method: 'POST', cookie, body: { name: 'Test Ghee', brand: 'Test', brandOwner: 'Test Ltd', category: 'staples', netQuantity: '500 ml', mrp: 100, price: 90, stock: 5 } });
  assert.equal(r.status, 422); assert.ok(r.json.fields.indianBrandConfirmed);
});

test('demo mode: banner, honest business details, open all day, hidden from search', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pmart-demo-'));
  const demo = createApp({ dataDir: d, env: { ADMIN_PASSWORD: 'demo-password-123', DEMO_MODE: '1', NODE_ENV: 'production' }, clock: MIDNIGHT_IST });
  await new Promise((r) => demo.server.listen(0, '127.0.0.1', r));
  const u = `http://127.0.0.1:${demo.server.address().port}`;
  try {
    const home = await fetch(u + '/');
    const html = await home.text();
    assert.equal(home.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.match(html, /class="demo-banner"/);
    assert.match(html, /24 hours a day/);
    assert.ok(!html.includes('Not yet published'));
    assert.ok(!/delivers only within/.test(html));
    const privacy = await (await fetch(u + '/privacy')).text();
    assert.match(privacy, /demo project, not a registered business/);
    assert.equal(await (await fetch(u + '/robots.txt')).text(), 'User-agent: *\nDisallow: /\n');
    const cfg = await (await fetch(u + '/api/config')).json();
    assert.equal(cfg.isOpen, true, 'open at midnight in demo');
    assert.equal(cfg.demo, true);
  } finally { await demo.close(); fs.rmSync(d, { recursive: true, force: true }); }
});

test('production without demo mode refuses to start until launch checks pass', () => {
  assert.throws(() => createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pmart-prod-')), env: { NODE_ENV: 'production' } }), /Launch checks failed/);
});

test('customer accounts: register, sign in, linked orders, saved address, track, delete', async () => {
  const phone = '7896000001';
  const reg = (body) => call('/api/account/register', { method: 'POST', body });
  let r = await reg({ name: 'Rina Bora', phone, password: 'short', terms: true, age: true });
  assert.equal(r.status, 422); assert.ok(r.json.fields.password);
  r = await reg({ name: 'Rina Bora', phone, password: 'good-password-1' });
  assert.equal(r.status, 422); assert.ok(r.json.fields.terms && r.json.fields.age);
  r = await reg({ name: 'Rina Bora', phone, password: 'good-password-1', terms: true, age: true });
  assert.equal(r.status, 201);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=2592000/);
  assert.equal((await reg({ name: 'X Y', phone: '+91 ' + phone, password: 'another-pass', terms: true, age: true })).status, 409);
  const stored = app.db.data.customers.find((c) => c.phone === phone);
  assert.ok(!JSON.stringify(stored).includes('good-password-1'), 'password is hashed');

  assert.equal((await call('/api/account/login', { method: 'POST', body: { phone, password: 'wrong-password' } })).status, 401);
  assert.equal((await call('/api/account/login', { method: 'POST', body: { phone: '9000000000', password: 'whatever1' } })).status, 401);
  const li = await call('/api/account/login', { method: 'POST', body: { phone, password: 'good-password-1' } });
  assert.equal(li.status, 200);
  assert.equal((await call('/api/account/me')).status, 401, 'needs a session');

  // Header switches to "Account" when signed in.
  assert.match((await call('/', { cookie })).text, /href="\/account"/);
  assert.match((await call('/')).text, /href="\/login"/);

  // Order while signed in is linked, and the address is saved only when asked.
  const o = await call('/api/orders', { method: 'POST', cookie, body: orderBody({ customer: { ...customer, phone }, saveAddress: true }) });
  assert.equal(o.status, 201);
  const me = await call('/api/account/me', { cookie });
  assert.equal(me.json.orders.length, 1);
  assert.equal(me.json.orders[0].id, o.json.id);
  assert.equal(me.json.address.pincode, '781005');
  const tr = await call(`/api/account/orders/${o.json.id}/track`, { method: 'POST', cookie, body: {} });
  assert.equal((await call(`/api/orders/${o.json.id}?t=${tr.json.token}`)).status, 200);

  // A guest order with the same number is NOT linked (no proof of ownership).
  const g = await call('/api/orders', { method: 'POST', body: orderBody({ customer: { ...customer, phone } }) });
  assert.equal((await call('/api/account/me', { cookie })).json.orders.length, 1);

  assert.equal((await call('/api/account/address', { method: 'POST', cookie, body: { house: 'A', street: 'Zoo Road', pincode: '110001' } })).status, 422);
  assert.equal((await call('/api/account/address', { method: 'POST', cookie, body: { remove: true } })).json.address, null);

  // Delete is refused while an order is active, needs the password, then removes everything.
  assert.equal((await call('/api/account/delete', { method: 'POST', cookie, body: { password: 'good-password-1' } })).status, 409);
  await call(`/api/orders/${o.json.id}/cancel`, { method: 'POST', body: { token: o.json.token } });
  await call(`/api/orders/${g.json.id}/cancel`, { method: 'POST', body: { token: g.json.token } });
  assert.equal((await call('/api/account/delete', { method: 'POST', cookie, body: { password: 'nope-nope' } })).status, 422);
  const del = await call('/api/account/delete', { method: 'POST', cookie, body: { password: 'good-password-1' } });
  assert.equal(del.status, 200);
  assert.ok(!app.db.data.customers.some((c) => c.phone === phone));
  assert.equal(app.db.order(o.json.id).customer.name, null);
  assert.equal((await call('/api/account/me', { cookie })).status, 401, 'session ended');
});

test('sign-in page offers all three roles', async () => {
  const r = await call('/login');
  assert.equal(r.status, 200);
  for (const s of ['signin-form', 'register-form', 'href="/admin"', 'href="/rider"']) assert.ok(r.text.includes(s), s);
});
