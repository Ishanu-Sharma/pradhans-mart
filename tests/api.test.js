import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/server.js';
import { isOpen } from '../server/util.js';

const NOON_IST = () => new Date('2026-11-15T06:30:00Z'); // 12:00 in Guwahati
const MIDNIGHT_IST = () => new Date('2026-11-15T18:45:00Z'); // 00:15 in Guwahati
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Starts an isolated app. Offers expire fast so dispatch can be tested.
async function start(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmart-test-'));
  const app = createApp({ dataDir: dir, env: { ADMIN_PASSWORD: 'test-password-123', ...(opts.env || {}) }, clock: opts.clock || NOON_IST, rateScale: opts.rateScale ?? 100, offerMs: { store: 600, rider: 600 }, sweepMs: 200, noStoreCancelMs: opts.noStoreCancelMs ?? 60_000 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const jar = {};
  const call = async (who, p, { method, body, headers } = {}) => {
    const res = await fetch(base + p, {
      method: method || (body ? 'POST' : 'GET'), redirect: 'manual',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar[who] ? { Cookie: jar[who] } : {}), ...(headers || {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const sc = res.headers.get('set-cookie');
    if (sc && who) jar[who] = sc.split(';')[0];
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const stop = async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { app, base, call, stop, dir };
}

const reg = (call, who, role, extra = {}) => call(who, '/api/auth/register', {
  body: { role, name: extra.name || 'Test Person', phone: extra.phone, password: 'password-123', terms: true, age: true, ...extra }
});
const address = { name: 'Anjali Das', phone: '9864012345', house: 'Flat 3B', street: 'GS Road, Christian Basti', landmark: '', pincode: '781005' };
const orderBody = (over = {}) => ({ items: [{ id: 'amul-butter-100g', qty: 2 }], customer: address, payment: 'cod', consents: {}, expectedTotal: 62 * 2 + 25, ...over });

// Customer, two approved stores (one in 781005), two approved riders, all online.
async function world(t) {
  const { call } = t;
  await reg(call, 'cust', 'customer', { phone: '9864012345', name: 'Anjali Das' });
  await reg(call, 'storeA', 'store', { phone: '9000000001', name: 'Ankur Das', storeName: 'Zoo Road Store', storeStreet: 'Zoo Road, Tarun Nagar', storePincode: '781005' });
  await reg(call, 'storeB', 'store', { phone: '9000000002', name: 'Mridul Saikia', storeName: 'Beltola Store', storeStreet: 'Beltola Road', storePincode: '781028' });
  await reg(call, 'r1', 'rider', { phone: '9100000001', name: 'Bikash Kalita', vehicle: 'scooter' });
  await reg(call, 'r2', 'rider', { phone: '9100000002', name: 'Pranjal Nath', vehicle: 'bicycle' });
  await call('admin', '/api/admin/login', { body: { password: 'test-password-123' } });
  for (const u of (await call('admin', '/api/admin/users?role=pending')).json) await call('admin', `/api/admin/users/${u.id}/status`, { body: { status: 'active' } });
  for (const s of ['storeA', 'storeB']) await call(s, '/api/store/online', { body: { online: true } });
  await call('r1', '/api/rider/online', { body: { online: true } });
  await sleep(5);
  await call('r2', '/api/rider/online', { body: { online: true } });
}
const offersFor = async (call, who) => (await call(who, '/api/store/dashboard')).json.offers.map((o) => o.id);

test('pages: login first, role guards, security headers, no dashes, no third-party resources', async () => {
  const t = await start();
  try {
    assert.equal((await t.call(null, '/')).headers.get('location'), '/login');
    assert.match((await t.call(null, '/shop')).headers.get('location'), /^\/login\?next=%2Fshop/);
    assert.match((await t.call(null, '/rider')).headers.get('location'), /^\/login\?role=rider/);
    for (const p of ['/login', '/privacy', '/terms', '/refunds', '/cookies', '/contact', '/credits', '/data-request', '/unsubscribe', '/admin']) {
      const r = await t.call(null, p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
      assert.ok(!/[—–]/.test(r.text), `dash on ${p}`);
      assert.ok(!/(src|href)="https?:\/\/(?!creativecommons\.org|world\.open)/.test(r.text.replace(/<link rel="canonical"[^>]*>/, '')), `external resource on ${p}`);
      assert.match(r.text, /class="skip-link"/);
    }
    const login = await t.call(null, '/login');
    for (const s of ['tab-customer', 'tab-rider', 'tab-store', 'href="/admin"', '/assets/products/']) assert.ok(login.text.includes(s), s);
    await reg(t.call, 'c', 'customer', { phone: '9864012345' });
    assert.equal((await t.call('c', '/')).headers.get('location'), '/shop');
    assert.equal((await t.call('c', '/login')).headers.get('location'), '/shop');
    assert.equal((await t.call('c', '/store')).headers.get('location'), '/shop');
    const shop = await t.call('c', '/shop');
    assert.equal(shop.status, 200);
    assert.match(shop.text, /class="cart-button"/);
    assert.equal((await t.call(null, '/nope')).status, 404);
    assert.equal((await t.call(null, '/favicon.ico')).status, 200);
    assert.equal((await t.call(null, '/assets/products/amul-butter-100g.jpg')).headers.get('content-type'), 'image/jpeg');
    assert.equal((await t.call(null, '/assets/fonts/figtree-latin-400.woff2')).headers.get('content-type'), 'font/woff2');
    assert.equal((await t.call(null, '/assets/../../config/business.json')).status, 404);
  } finally { await t.stop(); }
});

test('sign up and sign in: validation, roles, approval, suspension', async () => {
  const t = await start();
  const { call } = t;
  try {
    let r = await reg(call, 'x', 'customer', { phone: '123', password: 'short', terms: false });
    assert.equal(r.status, 422);
    assert.ok(r.json.fields.phone && r.json.fields.password && r.json.fields.terms);
    r = await reg(call, 'x', 'rider', { phone: '9100000009' });
    assert.ok(r.json.fields.vehicle, 'rider needs a vehicle');
    r = await reg(call, 'x', 'store', { phone: '9000000009', storePincode: '110001' });
    assert.ok(r.json.fields.storeName && r.json.fields.storePincode, 'store needs name and Guwahati pincode');
    assert.equal((await reg(call, 'c', 'customer', { phone: '9864012345' })).status, 201);
    assert.equal((await reg(call, 'c2', 'customer', { phone: '+91 98640 12345' })).status, 409, 'one customer account per number');
    const rr = await reg(call, 'r', 'rider', { phone: '9864012345', vehicle: 'scooter' });
    assert.equal(rr.json.status, 'pending', 'same number can be a rider, pending approval');
    assert.equal((await call('r', '/api/rider/online', { body: { online: true } })).status, 403);
    assert.equal((await call('r', '/api/rider/dashboard')).json.rider.status, 'pending');
    assert.equal((await call('x', '/api/auth/login', { body: { role: 'customer', phone: '9864012345', password: 'wrong-pass' } })).status, 401);
    assert.equal((await call('x', '/api/auth/login', { body: { role: 'rider', phone: '9864012345', password: 'password-123' } })).json.home, '/rider');
    const stored = JSON.stringify(t.app.db.data.users);
    assert.ok(!stored.includes('password-123'), 'passwords are hashed');

    await call('admin', '/api/admin/login', { body: { password: 'test-password-123' } });
    const pending = (await call('admin', '/api/admin/users?role=pending')).json;
    assert.equal(pending.length, 1);
    await call('admin', `/api/admin/users/${pending[0].id}/status`, { body: { status: 'active' } });
    assert.equal((await call('r', '/api/rider/online', { body: { online: true } })).status, 200);
    await call('r', '/api/rider/online', { body: { online: false } });
    const sus = await call('admin', `/api/admin/users/${pending[0].id}/status`, { body: { status: 'suspended' } });
    assert.equal(sus.json.status, 'suspended');
    assert.equal((await call('r', '/api/rider/dashboard')).status, 401, 'suspension signs them out');
    assert.equal((await call('y', '/api/auth/login', { body: { role: 'rider', phone: '9864012345', password: 'password-123' } })).status, 403);
    assert.equal((await call('c', '/api/rider/dashboard')).status, 401, 'customer cannot use rider API');
    assert.equal((await call('c', '/api/store/dashboard')).status, 401, 'customer cannot use store API');
    assert.equal((await call('c', '/api/admin/overview')).status, 401, 'customer cannot use admin API');
  } finally { await t.stop(); }
});

test('dispatch: pincode store first, decline and timeout move on, stock taken on accept, longest-free rider, live location', async () => {
  const t = await start();
  const { call } = t;
  try {
    await world(t);
    const avail = (await call('cust', '/api/products')).json.products.find((p) => p.id === 'amul-butter-100g').available;
    assert.equal(avail, 25, 'opening stock after approval');
    assert.equal((await call('r1', '/api/orders', { body: orderBody() })).status, 401, 'riders cannot order');
    const placed = await call('cust', '/api/orders', { body: orderBody() });
    assert.equal(placed.status, 201);
    const id = placed.json.id;
    assert.deepEqual(await offersFor(call, 'storeA'), [id], 'store in the same pincode first');
    assert.deepEqual(await offersFor(call, 'storeB'), []);
    assert.equal((await call('storeB', `/api/store/orders/${id}/accept`, { body: {} })).status, 409, 'cannot accept an offer made to another store');
    await call('storeA', `/api/store/orders/${id}/decline`, { body: {} });
    assert.deepEqual(await offersFor(call, 'storeB'), [id], 'decline passes it on');
    await sleep(800);
    assert.deepEqual(await offersFor(call, 'storeB'), [], 'timeout takes it away');
    assert.deepEqual(await offersFor(call, 'storeA'), [id], 'after everyone had a turn, the round starts again');
    assert.equal((await call('storeA', `/api/store/orders/${id}/accept`, { body: {} })).status, 200);
    const stockA = (await call('storeA', '/api/store/dashboard')).json.stock.find((p) => p.id === 'amul-butter-100g').stock;
    assert.equal(stockA, 23);
    let view = (await call('cust', `/api/orders/${id}`)).json;
    assert.equal(view.status, 'accepted');
    assert.equal(view.store.name, 'Zoo Road Store');
    assert.equal(view.canCancel, true);
    await call('storeA', `/api/store/orders/${id}/packed`, { body: {} });
    const o1 = (await call('r1', '/api/rider/dashboard')).json.offer;
    assert.equal(o1.id, id, 'rider free the longest gets it');
    assert.equal(o1.drop.pincode, '781005');
    assert.equal(o1.drop.house, undefined, 'no house number before accepting');
    assert.equal((await call('r2', '/api/rider/dashboard')).json.offer, null);
    await call('r1', `/api/rider/orders/${id}/accept`, { body: {} });
    const active = (await call('r1', '/api/rider/dashboard')).json.active;
    assert.equal(active.customer.house, 'Flat 3B', 'full address after accepting');
    assert.equal((await call('r1', '/api/rider/online', { body: { online: false } })).status, 409, 'cannot go offline mid-delivery');
    assert.equal((await call('cust', `/api/orders/${id}/cancel`, { body: {} })).status, 409, 'too late to cancel');
    assert.equal((await call('r1', `/api/rider/orders/${id}/location`, { body: { lat: 26.15, lng: 91.77 } })).status, 409, 'no location before pickup');
    await call('r1', `/api/rider/orders/${id}/pickup`, { body: {} });

    assert.equal((await call('r1', `/api/rider/orders/${id}/location`, { body: { lat: 26.15, lng: 91.77, accuracy: 9 } })).status, 200);
    view = (await call('cust', `/api/orders/${id}`)).json;
    assert.equal(view.rider.name, 'Bikash');
    assert.equal(view.riderLocation.lat, 26.15);
    await call('r1', `/api/rider/orders/${id}/delivered`, { body: {} });
    view = (await call('cust', `/api/orders/${id}`)).json;
    assert.equal(view.status, 'delivered');
    assert.equal(view.riderLocation, null);
    assert.ok(!fs.readFileSync(path.join(t.dir, 'db.json'), 'utf8').includes('"accuracy"'), 'location never saved');

    // Next packed order goes to r2, who has now been free longer than r1.
    const two = (await call('cust', '/api/orders', { body: orderBody() })).json.id;
    await call('storeA', `/api/store/orders/${two}/accept`, { body: {} });
    await call('storeA', `/api/store/orders/${two}/packed`, { body: {} });
    assert.equal((await call('r2', '/api/rider/dashboard')).json.offer?.id, two);
  } finally { await t.stop(); }
});

test('orders need a store that has everything; cancel restores the store stock; admin can cancel; no store means auto-cancel', async () => {
  const t = await start({ noStoreCancelMs: 400 });
  const { call } = t;
  try {
    await world(t);
    let r = await call('cust', '/api/orders', { body: orderBody({ items: [{ id: 'amul-butter-100g', qty: 10 }, { id: 'patanjali-cow-ghee-500ml', qty: 10 }], expectedTotal: 62 * 10 + 340 * 10 }) });
    assert.equal(r.status, 201);
    await call('storeA', '/api/store/stock', { body: { stock: { 'tata-salt-1kg': 0 } } });
    await call('storeB', '/api/store/stock', { body: { stock: { 'tata-salt-1kg': 0 } } });
    r = await call('cust', '/api/orders', { body: orderBody({ items: [{ id: 'tata-salt-1kg', qty: 1 }], expectedTotal: 53 }) });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'no_store');
    r = await call('cust', '/api/orders', { body: orderBody({ expectedTotal: 1 }) });
    assert.equal(r.json.code, 'total_changed');

    const id = (await call('cust', '/api/orders', { body: orderBody() })).json.id;
    const owner = (await offersFor(call, 'storeA')).includes(id) ? 'storeA' : 'storeB';
    await call(owner, `/api/store/orders/${id}/accept`, { body: {} });
    const before = (await call(owner, '/api/store/dashboard')).json.stock.find((p) => p.id === 'amul-butter-100g').stock;
    assert.equal((await call('cust', `/api/orders/${id}/cancel`, { body: {} })).json.status, 'cancelled');
    const afterStock = (await call(owner, '/api/store/dashboard')).json.stock.find((p) => p.id === 'amul-butter-100g').stock;
    assert.equal(afterStock, before + 2);

    const id2 = (await call('cust', '/api/orders', { body: orderBody() })).json.id;
    assert.equal((await call('admin', `/api/admin/orders/${id2}/cancel`, { body: {} })).json.status, 'cancelled');

    for (const s of ['storeA', 'storeB']) await call(s, '/api/store/online', { body: { online: true } });
    const id3 = (await call('cust', '/api/orders', { body: orderBody() })).json.id;
    for (const s of ['storeA', 'storeB']) await call(s, '/api/store/online', { body: { online: false } });
    await sleep(900);
    const v = (await call('cust', `/api/orders/${id3}`)).json;
    assert.equal(v.status, 'cancelled');
    assert.match(v.cancelReason, /No open store/);
  } finally { await t.stop(); }
});

test('accounts: saved address, linked orders, delete account', async () => {
  const t = await start();
  const { call } = t;
  try {
    await world(t);
    const id = (await call('cust', '/api/orders', { body: orderBody({ saveAddress: true }) })).json.id;
    const me = (await call('cust', '/api/account/me')).json;
    assert.equal(me.orders[0].id, id);
    assert.equal(me.address.pincode, '781005');
    assert.match((await call('cust', '/shop')).text, /class="location-chip"[\s\S]*?781005<\/strong>/, 'header shows the delivery area');
    assert.equal((await call('cust', '/api/account/address', { body: { house: 'A', street: 'Zoo Road', pincode: '110001' } })).status, 422);
    assert.equal((await call('cust', '/api/account/delete', { body: { password: 'password-123' } })).status, 409, 'active order blocks deletion');
    await call('cust', `/api/orders/${id}/cancel`, { body: {} });
    assert.equal((await call('cust', '/api/account/delete', { body: { password: 'nope-nope' } })).status, 422);
    assert.equal((await call('cust', '/api/account/delete', { body: { password: 'password-123' } })).status, 200);
    assert.equal(t.app.db.order(id).customer.name, null);
    assert.equal((await call('cust', '/api/account/me')).status, 401);
  } finally { await t.stop(); }
});

test('data rights, marketing emails and unsubscribe', async () => {
  const t = await start();
  const { call } = t;
  try {
    await world(t);
    const id = (await call('cust', '/api/orders', { body: orderBody({ consents: { marketing: true, email: 'buyer@example.in' } }) })).json.id;
    const mail = t.app.db.data.outbox.at(-1);
    assert.match(mail.headers['List-Unsubscribe'], /unsubscribe\?t=/);
    assert.equal(mail.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    const exp = await call(null, '/api/data-requests', { body: { orderId: id, phone: '9864012345', type: 'export' } });
    assert.equal(exp.json.account.name, 'Anjali Das');
    assert.equal(exp.json.marketingEmails[0].email, 'buyer@example.in');
    assert.equal((await call(null, '/api/data-requests', { body: { orderId: id, phone: '9864012345', type: 'delete', confirm: true } })).status, 409);
    await call('cust', `/api/orders/${id}/cancel`, { body: {} });
    const del = await call(null, '/api/data-requests', { body: { orderId: id, phone: '9864012345', type: 'delete', confirm: true } });
    assert.equal(del.json.deletedAccount, true);
    assert.ok(!JSON.stringify(t.app.db.data).includes('9864012345'));

    await reg(call, 'c2', 'customer', { phone: '7002000001' });
    await call('c2', '/api/orders', { body: orderBody({ consents: { marketing: true, email: 'two@example.in' } }) });
    const sub = t.app.db.data.subscribers.find((s) => s.email === 'two@example.in');
    const one = await fetch(`${t.base}/unsubscribe?t=${sub.unsubscribeToken}`, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(one.status, 200);
    assert.ok(!t.app.db.data.subscribers.some((s) => s.email === 'two@example.in'));
  } finally { await t.stop(); }
});

test('admin: overview counts, catalogue rules', async () => {
  const t = await start();
  const { call } = t;
  try {
    await world(t);
    const o = (await call('admin', '/api/admin/overview')).json;
    assert.deepEqual(o.stores, { total: 2, online: 2 });
    assert.deepEqual(o.riders, { total: 2, online: 2 });
    assert.equal(o.customers, 1);
    let r = await call('admin', '/api/admin/products', { body: { name: 'Test Ghee', brand: 'Test', brandOwner: 'Test Ltd', category: 'staples', netQuantity: '500 ml', mrp: 100, price: 120, indianBrandConfirmed: true } });
    assert.ok(r.json.fields.price);
    r = await call('admin', '/api/admin/products', { body: { name: 'Test Ghee', brand: 'Test', brandOwner: 'Test Ltd', category: 'staples', netQuantity: '500 ml', mrp: 100, price: 90 } });
    assert.ok(r.json.fields.indianBrandConfirmed);
    assert.equal((await call('admin', '/api/admin/users?role=customer')).json.length, 1);
  } finally { await t.stop(); }
});

test('store hours, cross-site requests, rate limits', async () => {
  const t = await start({ clock: MIDNIGHT_IST });
  const { call } = t;
  try {
    await world(t);
    const r = await call('cust', '/api/orders', { body: orderBody() });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /closed/);
    assert.equal(isOpen({ open: '07:00', close: '23:00', timeZone: 'Asia/Kolkata' }, NOON_IST()), true);
    const x = await fetch(`${t.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
    assert.equal(x.status, 403);
  } finally { await t.stop(); }
  const rl = await start({ rateScale: 1 });
  try {
    const codes = [];
    for (let i = 0; i < 21; i++) codes.push((await rl.call(null, '/api/auth/login', { body: { role: 'customer', phone: '9000000000', password: 'x' } })).status);
    assert.equal(codes.at(-1), 429);
  } finally { await rl.stop(); }
});

test('demo mode and the production launch gate', async () => {
  const t = await start({ env: { DEMO_MODE: '1', NODE_ENV: 'production' }, clock: MIDNIGHT_IST });
  try {
    const page = await t.call(null, '/login');
    assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.match(page.text, /class="demo-banner"/);
    const privacy = await t.call(null, '/privacy');
    assert.match(privacy.text, /demo project, not a registered business/);
    assert.ok(!privacy.text.includes('Not yet published'));
    assert.equal((await t.call(null, '/api/config')).json.isOpen, true, 'open at midnight in demo');
    assert.equal(await (await fetch(`${t.base}/robots.txt`)).text(), 'User-agent: *\nDisallow: /\n');
  } finally { await t.stop(); }
  assert.throws(() => createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pmart-prod-')), env: { NODE_ENV: 'production' } }), /Launch checks failed/);
});
