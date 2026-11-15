import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDb } from './db.js';
import { createRenderer } from './render.js';
import { categories } from './seed.js';
import { composeWelcomeEmail } from './mail.js';
import { rules, normalisePhone, inServiceRadius, isValidCoord } from '../public/assets/js/validators.js';
import {
  sendJson, readJson, HttpError, randomCode, randomToken, sha256, safeEqual,
  parseCookies, isOpen, formatTime12, rateLimiter, hashPassword, verifyPassword
} from './util.js';
import { launchProblems } from '../scripts/launch-lib.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const readConfig = (f) => JSON.parse(fs.readFileSync(path.join(root, 'config', f), 'utf8'));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8'
};

const ACTIVE = ['placed', 'accepted', 'packed', 'out_for_delivery'];
const STATUS_LABEL = {
  placed: 'Order placed', accepted: 'Accepted by the store', packed: 'Packed',
  out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled'
};
const ADMIN_NEXT = {
  placed: ['accepted', 'cancelled'],
  accepted: ['packed', 'cancelled'],
  packed: ['out_for_delivery', 'cancelled'],
  out_for_delivery: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: []
};

export function createApp({ dataDir = path.join(root, 'data'), env = process.env, clock = () => new Date(), rateScale = 1 } = {}) {
  const production = env.NODE_ENV === 'production';
  const demo = env.DEMO_MODE === '1';
  if (production && !demo) {
    const problems = launchProblems(env);
    if (problems.length) {
      const err = new Error(`Launch checks failed:\n - ${problems.join('\n - ')}`);
      err.launchProblems = problems;
      throw err;
    }
  }
  const business = readConfig('business.json');
  const store = readConfig('store.json');
  if (demo) {
    // A presentation build: honest stand-ins instead of business details that do not exist yet,
    // and orders open around the clock so the full flow can be shown at any hour.
    const na = 'Not applicable: demo project';
    const fill = (obj) => { for (const [k, v] of Object.entries(obj)) { if (k.startsWith('_')) continue; if (v && typeof v === 'object') fill(v); else if (!String(v ?? '').trim()) obj[k] = na; } };
    if (!business.legalName) business.legalName = `${business.brandName} (demo project, not a registered business)`;
    if (!business.registeredAddress) business.registeredAddress = 'Guwahati, Assam (no registered office)';
    if (!business.storeAddress) business.storeAddress = 'Guwahati, Assam (no physical store)';
    if (!business.hostingProvider) business.hostingProvider = 'Render (render.com)';
    if (!business.dataStorageLocation) business.dataStorageLocation = env.DATA_LOCATION || 'Render servers';
    if (!business.policyEffectiveDate) business.policyEffectiveDate = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(clock());
    fill(business);
    business.cin = '';
    store.hours = { ...store.hours, open: '00:00', close: '00:00' };
  }
  const db = createDb(dataDir);
  const baseUrl = env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${env.PORT || 3000}`;

  let adminPassword = env.ADMIN_PASSWORD;
  if (!adminPassword) {
    adminPassword = randomToken(12);
    console.log(`[dev] No ADMIN_PASSWORD set. This run's admin password: ${adminPassword}`);
  }

  const brands = () => [...new Set(db.data.products.filter((p) => p.active).map((p) => p.brand))].sort((a, b) => a.localeCompare(b));
  const renderer = createRenderer({ root, business, store, production, getBrands: brands, demo });

  // ---------- in-memory state ----------
  const sessions = new Map(); // token -> { role, riderId, exp }
  const riderLocations = new Map(); // orderId -> { lat, lng, accuracy, at } (never written to disk)
  const lastLocationAt = new Map();
  const streams = { stock: new Set(), admin: new Set(), orders: new Map(), riders: new Map() };

  const limit = {
    order: rateLimiter({ windowMs: 60_000, max: 10 * rateScale }),
    lookup: rateLimiter({ windowMs: 60_000, max: 10 * rateScale }),
    login: rateLimiter({ windowMs: 15 * 60_000, max: 10 * rateScale }),
    data: rateLimiter({ windowMs: 60_000, max: 5 * rateScale }),
    api: rateLimiter({ windowMs: 60_000, max: 600 * rateScale })
  };

  // ---------- helpers ----------
  const clientIp = (req) => (env.TRUST_PROXY === '1' && req.headers['x-forwarded-for'])
    ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
    : req.socket.remoteAddress || 'unknown';

  function setSecurityHeaders(res) {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
      "font-src 'self'", "connect-src 'self'", "manifest-src 'self'", "object-src 'none'",
      "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"
    ].join('; '));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()');
    if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (demo) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }

  function session(req, role) {
    const token = parseCookies(req.headers.cookie).pm_session;
    const s = token && sessions.get(token);
    if (!s || s.exp < Date.now() || (role && s.role !== role)) return null;
    if (s.role === 'rider' && !db.rider(s.riderId)) return null;
    if (s.role === 'customer' && !db.customer(s.customerId)) return null;
    return { ...s, token };
  }
  function requireRole(req, role) {
    const s = session(req, role);
    if (!s) throw new HttpError(401, 'Please sign in.');
    return s;
  }
  function startSession(res, data, hours = store.retention.staffSessionHours) {
    const token = randomToken(32);
    sessions.set(token, { ...data, exp: Date.now() + hours * 3_600_000 });
    res.setHeader('Set-Cookie', `pm_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.round(hours * 3600)}${production ? '; Secure' : ''}`);
  }
  const customerHours = store.retention.customerSessionDays * 24;
  const DUMMY_HASH = hashPassword(randomToken(12)); // keeps sign-in timing the same for unknown numbers
  function endSessionsWhere(pred) { for (const [t, s] of sessions) if (pred(s)) sessions.delete(t); }

  function accountView(c) {
    return {
      name: c.name, phone: c.phone, address: c.address, createdAt: c.createdAt,
      orders: db.data.orders.filter((o) => o.customerId === c.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((o) => ({ id: o.id, status: o.status, statusLabel: STATUS_LABEL[o.status], total: o.total, createdAt: o.createdAt, itemCount: o.items.reduce((n, i) => n + i.qty, 0) }))
    };
  }
  function validateAddress(b) {
    const fields = {};
    for (const f of ['house', 'street', 'landmark']) { const e = rules[f](b[f]); if (e) fields[f] = e; }
    const pe = rules.pincode(b.pincode, store.serviceArea.pincodes); if (pe) fields.pincode = pe;
    if (Object.keys(fields).length) throw new HttpError(422, 'Check the highlighted details.', { fields });
    return { house: String(b.house).trim(), street: String(b.street).trim(), landmark: String(b.landmark || '').trim(), pincode: String(b.pincode).trim() };
  }
  function anonymiseOrders(orders) {
    const at = new Date().toISOString();
    for (const o of orders) {
      o.customer = { name: null, phone: null, house: null, street: null, landmark: null, pincode: null };
      o.location = null; o.tokenHashes = []; o.customerId = null; o.anonymized = true; o.anonymizedAt = at;
    }
  }
  function endSession(req, res) {
    const token = parseCookies(req.headers.cookie).pm_session;
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', `pm_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${production ? '; Secure' : ''}`);
  }

  const publicProduct = (p) => ({
    id: p.id, name: p.name, brand: p.brand, brandOwner: p.brandOwner, category: p.category,
    netQuantity: p.netQuantity, mrp: p.mrp, price: p.price, stock: p.stock,
    countryOfOrigin: p.countryOfOrigin, packer: p.packer
  });

  const priceSummary = (subtotal) => {
    const deliveryFee = subtotal >= store.fees.freeDeliveryFrom ? 0 : store.fees.deliveryFee;
    return { subtotal, deliveryFee, total: subtotal + deliveryFee };
  };

  const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'Your rider';
  const paymentLabel = (id) => store.paymentMethods.find((m) => m.id === id)?.label || id;

  function customerView(o) {
    const rider = o.riderId ? db.rider(o.riderId) : null;
    return {
      id: o.id, status: o.status, statusLabel: STATUS_LABEL[o.status], history: o.history,
      createdAt: o.createdAt, items: o.items, subtotal: o.subtotal, deliveryFee: o.deliveryFee, total: o.total,
      payment: paymentLabel(o.payment), canCancel: ['placed', 'accepted'].includes(o.status),
      address: o.anonymized || o.addressPurged ? null : {
        name: o.customer.name, house: o.customer.house, street: o.customer.street,
        landmark: o.customer.landmark, pincode: o.customer.pincode
      },
      customerLocation: o.location || null,
      rider: rider ? { name: firstName(rider.name) } : null,
      riderLocation: riderLocations.get(o.id) || null
    };
  }
  function adminView(o) {
    const rider = o.riderId ? db.rider(o.riderId) : null;
    return {
      ...customerView(o), customer: o.customer, location: o.location || null,
      riderId: o.riderId, riderName: rider?.name || null, next: ADMIN_NEXT[o.status],
      anonymized: !!o.anonymized
    };
  }
  function riderView(o) {
    return {
      id: o.id, status: o.status, statusLabel: STATUS_LABEL[o.status], total: o.total,
      payment: paymentLabel(o.payment), itemCount: o.items.reduce((n, i) => n + i.qty, 0),
      items: o.items.map((i) => ({ name: i.name, netQuantity: i.netQuantity, qty: i.qty })),
      customer: o.customer, location: o.location || null
    };
  }

  // ---------- server-sent events ----------
  function openStream(req, res, set) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 4000\n\n');
    set.add(res);
    req.on('close', () => set.delete(res));
  }
  const push = (set, event, data) => {
    if (!set) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) res.write(msg);
  };
  const keyedSet = (map, key) => { if (!map.has(key)) map.set(key, new Set()); return map.get(key); };
  const heartbeat = setInterval(() => {
    const all = [...streams.stock, ...streams.admin, ...[...streams.orders.values()].flatMap((s) => [...s]), ...[...streams.riders.values()].flatMap((s) => [...s])];
    for (const res of all) res.write(': ping\n\n');
  }, 25_000);
  heartbeat.unref();

  function broadcastOrder(o) {
    push(streams.orders.get(o.id), 'order', customerView(o));
    push(streams.admin, 'order', adminView(o));
    if (o.riderId) push(streams.riders.get(o.riderId), 'orders', null);
  }
  const broadcastStock = (p) => push(streams.stock, 'stock', { id: p.id, stock: p.stock, price: p.price, mrp: p.mrp, active: p.active });

  // ---------- orders ----------
  function setStatus(o, status) {
    o.status = status;
    o.history.push({ status, label: STATUS_LABEL[status], at: new Date().toISOString() });
    if (status === 'cancelled' && !o.stockRestored) {
      for (const line of o.items) {
        const p = db.product(line.id);
        if (p) { p.stock += line.qty; broadcastStock(p); }
      }
      o.stockRestored = true;
    }
    if (status === 'delivered' || status === 'cancelled') {
      o.completedAt = new Date().toISOString();
      riderLocations.delete(o.id);
      lastLocationAt.delete(o.id);
    }
    db.save();
    broadcastOrder(o);
  }

  function findOrderByProof(orderId, phone) {
    const id = String(orderId || '').trim().toUpperCase();
    const ph = normalisePhone(phone);
    const o = db.order(id);
    if (!o || o.anonymized || o.customer.phone !== ph) return null;
    return o;
  }
  function orderByToken(id, token) {
    const o = db.order(String(id || '').toUpperCase());
    if (!o || !token || !o.tokenHashes.includes(sha256(token))) throw new HttpError(404, 'We could not find that order on this device. Look it up with your order ID and mobile number.');
    return o;
  }
  function issueToken(o) {
    const token = randomToken();
    o.tokenHashes = [...o.tokenHashes.slice(-4), sha256(token)];
    return token;
  }

  async function createOrder(req, res) {
    if (!limit.order(clientIp(req))) throw new HttpError(429, 'Too many orders from this connection. Try again in a minute.');
    if (!isOpen(store.hours, clock())) throw new HttpError(409, `The store is closed. We take orders from ${formatTime12(store.hours.open)} to ${formatTime12(store.hours.close)}.`);
    const b = await readJson(req);
    const fields = {};
    const c = b.customer || {};
    for (const f of ['name', 'phone', 'house', 'street', 'landmark']) { const e = rules[f](c[f]); if (e) fields[f] = e; }
    const pinErr = rules.pincode(c.pincode, store.serviceArea.pincodes); if (pinErr) fields.pincode = pinErr;

    let location = null;
    if (b.shareLocation === true) {
      const loc = b.location && { lat: Number(b.location.lat), lng: Number(b.location.lng) };
      if (!isValidCoord(loc)) fields.location = 'We could not read your location. Untick the box or try again.';
      else if (!inServiceRadius(loc, store.serviceArea)) fields.location = 'This location is outside our delivery area in Guwahati.';
      else location = { lat: Math.round(loc.lat * 1e5) / 1e5, lng: Math.round(loc.lng * 1e5) / 1e5 };
    }
    if (!store.paymentMethods.some((m) => m.id === b.payment)) fields.payment = 'Choose how you will pay.';
    const consents = b.consents || {};
    if (consents.terms !== true) fields.terms = 'Accept the Terms of service and Privacy policy to place your order.';
    if (consents.age !== true) fields.age = 'You must be 18 or older to order.';
    let email = null;
    if (consents.marketing === true) {
      const e = rules.email(consents.email);
      if (e) fields.email = e; else email = String(consents.email).trim().toLowerCase();
    }

    const max = store.limits.maxQtyPerItem;
    const merged = new Map();
    if (!Array.isArray(b.items) || b.items.length === 0) fields.items = 'Your cart is empty.';
    else if (b.items.length > store.limits.maxLines) fields.items = `An order can have up to ${store.limits.maxLines} different items.`;
    else {
      for (const it of b.items) {
        const qty = Number(it?.qty);
        if (!Number.isInteger(qty) || qty < 1) { fields.items = 'Each quantity must be a whole number of at least 1.'; break; }
        merged.set(String(it.id), (merged.get(String(it.id)) || 0) + qty);
      }
    }
    const lines = [];
    if (!fields.items) {
      for (const [id, qty] of merged) {
        const p = db.product(id);
        if (!p || !p.active) { fields.items = 'An item in your cart is no longer sold. Remove it and try again.'; break; }
        if (qty > max) { fields.items = `You can order up to ${max} of each item.`; break; }
        if (p.stock < qty) { fields.items = p.stock === 0 ? `${p.name} is out of stock. Remove it to continue.` : `We have ${p.stock} of ${p.name} in stock. Lower the quantity to continue.`; break; }
        lines.push({ id, name: p.name, brand: p.brand, netQuantity: p.netQuantity, price: p.price, qty });
      }
    }
    if (Object.keys(fields).length) throw new HttpError(422, 'Check the highlighted details.', { fields });

    const sums = priceSummary(lines.reduce((s, l) => s + l.price * l.qty, 0));
    if (Number(b.expectedTotal) !== sums.total) {
      throw new HttpError(409, 'A price changed while you were checking out. Review the new total before you place the order.', { totals: sums, code: 'total_changed' });
    }

    for (const l of lines) { const p = db.product(l.id); p.stock -= l.qty; }
    let id; do { id = `PM${randomCode(8)}`; } while (db.order(id));
    const now = new Date().toISOString();
    const o = {
      id, createdAt: now, status: 'placed',
      history: [{ status: 'placed', label: STATUS_LABEL.placed, at: now }],
      items: lines, ...sums, payment: b.payment,
      customer: {
        name: String(c.name).trim(), phone: normalisePhone(c.phone), house: String(c.house).trim(),
        street: String(c.street).trim(), landmark: String(c.landmark || '').trim(), pincode: String(c.pincode).trim()
      },
      location, riderId: null, tokenHashes: [],
      consents: { termsAcceptedAt: now, ageConfirmedAt: now, policyVersion: business.policyEffectiveDate || 'draft' }
    };
    const viewer = session(req, 'customer');
    if (viewer) {
      o.customerId = viewer.customerId;
      if (b.saveAddress === true) {
        const acct = db.customer(viewer.customerId);
        acct.address = { house: o.customer.house, street: o.customer.street, landmark: o.customer.landmark, pincode: o.customer.pincode };
      }
    }
    const token = issueToken(o);
    db.data.orders.push(o);

    if (email && !db.data.subscribers.some((s) => s.email === email)) {
      const unsubscribeToken = randomToken();
      db.data.subscribers.push({
        id: randomCode(10), email, unsubscribeToken, phoneHash: sha256(o.customer.phone),
        consentAt: now, consentText: 'Email me offers from Pradhan’s Mart. I can unsubscribe at any time.'
      });
      db.data.outbox.push({ createdAt: now, ...composeWelcomeEmail({ business, baseUrl, email, unsubscribeToken }) });
    }
    db.save();
    for (const l of lines) broadcastStock(db.product(l.id));
    push(streams.admin, 'order', adminView(o));
    sendJson(res, 201, { id: o.id, token, total: o.total });
  }

  // ---------- data rights ----------
  async function dataRequest(req, res) {
    if (!limit.data(clientIp(req))) throw new HttpError(429, 'Too many requests. Try again in a minute.');
    const b = await readJson(req);
    const fields = {};
    const idErr = rules.orderId(b.orderId); if (idErr) fields.orderId = idErr;
    const phErr = rules.phone(b.phone); if (phErr) fields.phone = phErr;
    if (!['export', 'delete'].includes(b.type)) fields.type = 'Choose what you want us to do.';
    if (b.type === 'delete' && b.confirm !== true) fields.confirm = 'Tick the box to confirm you want your data deleted.';
    if (Object.keys(fields).length) throw new HttpError(422, 'Check the highlighted details.', { fields });
    const proof = findOrderByProof(b.orderId, b.phone);
    if (!proof) throw new HttpError(404, 'No order matches that order ID and mobile number.');
    const phone = proof.customer.phone;
    const phoneHash = sha256(phone);
    const orders = db.data.orders.filter((o) => !o.anonymized && o.customer.phone === phone);
    const subs = db.data.subscribers.filter((s) => s.phoneHash === phoneHash);
    const accounts = db.data.customers.filter((c) => c.phone === phone);
    const log = { id: randomCode(10), type: b.type, at: new Date().toISOString(), phoneHash, orders: orders.length };

    if (b.type === 'export') {
      db.data.requests.push({ ...log, result: 'completed' }); db.save();
      return sendJson(res, 200, {
        generatedAt: log.at,
        about: `Personal data held by ${business.legalName || business.brandName} for mobile number ${phone}`,
        orders: orders.map((o) => ({
          id: o.id, placedAt: o.createdAt, status: STATUS_LABEL[o.status], items: o.items, total: o.total,
          payment: paymentLabel(o.payment), name: o.customer.name, phone: o.customer.phone,
          address: o.addressPurged ? 'Deleted after delivery under our retention rule' : {
            house: o.customer.house, street: o.customer.street, landmark: o.customer.landmark, pincode: o.customer.pincode
          },
          deliveryLocation: o.location || null, consents: o.consents
        })),
        marketingEmails: subs.map((s) => ({ email: s.email, consentAt: s.consentAt, consentText: s.consentText })),
        account: accounts.map((c) => ({ name: c.name, phone: c.phone, createdAt: c.createdAt, savedAddress: c.address, password: 'Stored only as a one-way hash' }))[0] || null
      });
    }

    if (orders.some((o) => ACTIVE.includes(o.status))) {
      db.data.requests.push({ ...log, result: 'refused: order in progress' }); db.save();
      throw new HttpError(409, 'You have an order in progress. You can delete your data once it is delivered or cancelled.');
    }
    anonymiseOrders(orders);
    db.data.subscribers = db.data.subscribers.filter((s) => s.phoneHash !== phoneHash);
    const accountIds = new Set(accounts.map((c) => c.id));
    db.data.customers = db.data.customers.filter((c) => !accountIds.has(c.id));
    endSessionsWhere((s) => accountIds.has(s.customerId));
    db.data.requests.push({ ...log, result: 'completed' });
    db.save();
    for (const o of orders) push(streams.admin, 'order', adminView(o));
    sendJson(res, 200, { deletedOrders: orders.length, deletedSubscriptions: subs.length, deletedAccount: accounts.length > 0 });
  }

  function unsubscribe(token) {
    const before = db.data.subscribers.length;
    db.data.subscribers = db.data.subscribers.filter((s) => s.unsubscribeToken !== token);
    const removed = before !== db.data.subscribers.length;
    if (removed) db.save();
    return removed;
  }

  // Address and pin location are deleted a fixed number of days after an order is completed.
  function purgeOldAddresses() {
    const cutoff = Date.now() - store.retention.addressDaysAfterCompletion * 86_400_000;
    let changed = false;
    for (const o of db.data.orders) {
      if (o.completedAt && !o.addressPurged && !o.anonymized && Date.parse(o.completedAt) < cutoff) {
        o.customer.house = null; o.customer.street = null; o.customer.landmark = null; o.customer.pincode = null;
        o.location = null; o.addressPurged = true; changed = true;
      }
    }
    if (changed) db.save();
  }
  purgeOldAddresses();
  const purgeTimer = setInterval(purgeOldAddresses, 3_600_000); purgeTimer.unref();

  // ---------- products (admin) ----------
  function validateProduct(b, existing) {
    const fields = {};
    const out = {};
    const str = (k, label, min, maxLen, required = true) => {
      if (b[k] === undefined && existing) return;
      const v = String(b[k] ?? '').trim();
      if (required && v.length < min) fields[k] = `Enter the ${label}.`;
      else if (v.length > maxLen) fields[k] = `Keep the ${label} under ${maxLen} characters.`;
      else out[k] = v;
    };
    str('name', 'product name', 2, 80);
    str('brand', 'brand', 2, 40);
    str('brandOwner', 'brand owner', 2, 80);
    str('netQuantity', 'net quantity', 1, 20);
    str('packer', 'manufacturer or packer details', 0, 200, false);
    if (b.category !== undefined || !existing) {
      if (!categories.some((c) => c.id === b.category)) fields.category = 'Choose a category.'; else out.category = b.category;
    }
    const num = (k, label, { int = false, min = 0 } = {}) => {
      if (b[k] === undefined && existing) return;
      const v = Number(b[k]);
      if (!Number.isFinite(v) || v < min || (int && !Number.isInteger(v))) fields[k] = `Enter a valid ${label}.`;
      else out[k] = int ? v : Math.round(v * 100) / 100;
    };
    num('mrp', 'MRP', { min: 0.01 });
    num('price', 'price', { min: 0.01 });
    num('stock', 'stock count', { int: true });
    const mrp = out.mrp ?? existing?.mrp; const price = out.price ?? existing?.price;
    if (!fields.mrp && !fields.price && price > mrp) fields.price = 'The selling price cannot be higher than the MRP.';
    if (b.active !== undefined) out.active = b.active === true;
    if (!existing) {
      if (b.indianBrandConfirmed !== true) fields.indianBrandConfirmed = 'Confirm that this brand was founded in India and is owned in India.';
      out.indianBrandConfirmed = true; out.countryOfOrigin = 'India';
    }
    if (Object.keys(fields).length) throw new HttpError(422, 'Check the highlighted details.', { fields });
    return out;
  }

  // ---------- router ----------
  async function api(req, res, url) {
    const m = req.method;
    const p = url.pathname;
    let match;
    if (!limit.api(clientIp(req))) throw new HttpError(429, 'Too many requests.');

    // Public
    if (m === 'GET' && p === '/api/config') {
      return sendJson(res, 200, {
        brandName: business.brandName, city: store.city,
        serviceArea: store.serviceArea, isOpen: isOpen(store.hours, clock()),
        hours: { open: formatTime12(store.hours.open), close: formatTime12(store.hours.close), allDay: store.hours.open === store.hours.close },
        demo,
        fees: store.fees, limits: store.limits, paymentMethods: store.paymentMethods, categories
      });
    }
    if (m === 'GET' && p === '/api/products') return sendJson(res, 200, db.data.products.filter((x) => x.active).map(publicProduct));
    if (m === 'GET' && p === '/api/stream/stock') return openStream(req, res, streams.stock);
    if (m === 'POST' && p === '/api/orders') return createOrder(req, res);
    if (m === 'POST' && p === '/api/orders/lookup') {
      if (!limit.lookup(clientIp(req))) throw new HttpError(429, 'Too many attempts. Try again in a minute.');
      const b = await readJson(req);
      const fields = {};
      const a = rules.orderId(b.orderId); if (a) fields.orderId = a;
      const ph = rules.phone(b.phone); if (ph) fields.phone = ph;
      if (Object.keys(fields).length) throw new HttpError(422, 'Check the highlighted details.', { fields });
      const o = findOrderByProof(b.orderId, b.phone);
      if (!o) throw new HttpError(404, 'No order matches that order ID and mobile number.');
      const token = issueToken(o); db.save();
      return sendJson(res, 200, { id: o.id, token });
    }
    if ((match = p.match(/^\/api\/orders\/([A-Z0-9]{10})$/)) && m === 'GET') {
      return sendJson(res, 200, customerView(orderByToken(match[1], url.searchParams.get('t'))));
    }
    if ((match = p.match(/^\/api\/orders\/([A-Z0-9]{10})\/stream$/)) && m === 'GET') {
      const o = orderByToken(match[1], url.searchParams.get('t'));
      openStream(req, res, keyedSet(streams.orders, o.id));
      res.write(`event: order\ndata: ${JSON.stringify(customerView(o))}\n\n`);
      return;
    }
    if ((match = p.match(/^\/api\/orders\/([A-Z0-9]{10})\/cancel$/)) && m === 'POST') {
      const b = await readJson(req);
      const o = orderByToken(match[1], b.token);
      if (!['placed', 'accepted'].includes(o.status)) throw new HttpError(409, 'This order is already packed, so it can no longer be cancelled here. Contact support for help.');
      setStatus(o, 'cancelled');
      return sendJson(res, 200, customerView(o));
    }
    if (m === 'POST' && p === '/api/data-requests') return dataRequest(req, res);
    if (m === 'POST' && p === '/api/unsubscribe') {
      const b = await readJson(req);
      const removed = unsubscribe(String(b.token || ''));
      return sendJson(res, 200, { removed });
    }

    // Customer accounts
    if (m === 'POST' && p === '/api/account/register') {
      if (!limit.login(clientIp(req))) throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.');
      const b = await readJson(req);
      const fields = {};
      for (const k of ['name', 'phone', 'password']) { const e = rules[k](b[k]); if (e) fields[k] = e; }
      if (b.terms !== true) fields.terms = 'Accept the Terms of service and Privacy policy to create an account.';
      if (b.age !== true) fields.age = 'You must be 18 or older to create an account.';
      if (Object.keys(fields).length) throw new HttpError(422, 'Check the highlighted details.', { fields });
      const phone = normalisePhone(b.phone);
      if (db.data.customers.some((c) => c.phone === phone)) {
        throw new HttpError(409, 'An account with this mobile number already exists. Sign in instead.', { fields: { phone: 'An account with this mobile number already exists. Sign in instead.' } });
      }
      const now = new Date().toISOString();
      const c = { id: randomCode(10), name: String(b.name).trim(), phone, passwordHash: hashPassword(b.password), createdAt: now, termsAcceptedAt: now, ageConfirmedAt: now, address: null };
      db.data.customers.push(c); db.save();
      startSession(res, { role: 'customer', customerId: c.id }, customerHours);
      return sendJson(res, 201, accountView(c));
    }
    if (m === 'POST' && p === '/api/account/login') {
      if (!limit.login(clientIp(req))) throw new HttpError(429, 'Too many sign-in attempts. Wait 15 minutes and try again.');
      const b = await readJson(req);
      const phone = normalisePhone(b.phone);
      const c = db.data.customers.find((x) => x.phone === phone);
      const ok = verifyPassword(String(b.password || ''), c ? c.passwordHash : DUMMY_HASH);
      if (!c || !ok) throw new HttpError(401, 'That mobile number and password do not match an account.');
      startSession(res, { role: 'customer', customerId: c.id }, customerHours);
      return sendJson(res, 200, accountView(c));
    }
    if (m === 'POST' && p === '/api/account/logout') { endSession(req, res); return sendJson(res, 200, { ok: true }); }
    if (p.startsWith('/api/account/')) {
      const s = requireRole(req, 'customer');
      const c = db.customer(s.customerId);
      if (m === 'GET' && p === '/api/account/me') return sendJson(res, 200, accountView(c));
      if (m === 'POST' && p === '/api/account/address') {
        const b = await readJson(req);
        c.address = b.remove === true ? null : validateAddress(b);
        db.save();
        return sendJson(res, 200, accountView(c));
      }
      if ((match = p.match(/^\/api\/account\/orders\/([A-Z0-9]{10})\/track$/)) && m === 'POST') {
        const o = db.order(match[1]);
        if (!o || o.customerId !== c.id) throw new HttpError(404, 'Order not found in your account.');
        const token = issueToken(o); db.save();
        return sendJson(res, 200, { id: o.id, token });
      }
      if (m === 'POST' && p === '/api/account/delete') {
        const b = await readJson(req);
        if (!verifyPassword(String(b.password || ''), c.passwordHash)) throw new HttpError(422, 'Check the highlighted details.', { fields: { 'del-password': 'That password is not correct.' } });
        const mine = db.data.orders.filter((o) => o.customerId === c.id);
        if (mine.some((o) => ACTIVE.includes(o.status))) throw new HttpError(409, 'You have an order in progress. You can delete your account once it is delivered or cancelled.');
        anonymiseOrders(mine);
        db.data.subscribers = db.data.subscribers.filter((x) => x.phoneHash !== sha256(c.phone));
        db.data.customers = db.data.customers.filter((x) => x.id !== c.id);
        db.data.requests.push({ id: randomCode(10), type: 'delete account', at: new Date().toISOString(), phoneHash: sha256(c.phone), orders: mine.length, result: 'completed' });
        db.save();
        endSessionsWhere((x) => x.customerId === c.id);
        endSession(req, res);
        return sendJson(res, 200, { deletedOrders: mine.length });
      }
      throw new HttpError(404, 'Not found.');
    }

    // Admin
    if (m === 'POST' && p === '/api/admin/login') {
      if (!limit.login(clientIp(req))) throw new HttpError(429, 'Too many sign-in attempts. Wait 15 minutes and try again.');
      const b = await readJson(req);
      if (!safeEqual(String(b.password || ''), adminPassword)) throw new HttpError(401, 'That password is not correct.');
      startSession(res, { role: 'admin' });
      return sendJson(res, 200, { ok: true });
    }
    if (m === 'POST' && (p === '/api/admin/logout' || p === '/api/rider/logout')) { endSession(req, res); return sendJson(res, 200, { ok: true }); }
    if (p.startsWith('/api/admin/')) {
      requireRole(req, 'admin');
      if (m === 'GET' && p === '/api/admin/me') return sendJson(res, 200, { role: 'admin' });
      if (m === 'GET' && p === '/api/admin/stream') return openStream(req, res, streams.admin);
      if (m === 'GET' && p === '/api/admin/orders') {
        return sendJson(res, 200, db.data.orders.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 300).map(adminView));
      }
      if ((match = p.match(/^\/api\/admin\/orders\/([A-Z0-9]{10})\/status$/)) && m === 'POST') {
        const o = db.order(match[1]); if (!o) throw new HttpError(404, 'Order not found.');
        const b = await readJson(req);
        if (!ADMIN_NEXT[o.status].includes(b.status)) throw new HttpError(409, `An order that is "${STATUS_LABEL[o.status]}" cannot move to "${STATUS_LABEL[b.status] || b.status}".`);
        if (b.status === 'out_for_delivery' && !o.riderId) throw new HttpError(409, 'Assign a rider before sending the order out.');
        setStatus(o, b.status);
        return sendJson(res, 200, adminView(o));
      }
      if ((match = p.match(/^\/api\/admin\/orders\/([A-Z0-9]{10})\/rider$/)) && m === 'POST') {
        const o = db.order(match[1]); if (!o) throw new HttpError(404, 'Order not found.');
        if (!ACTIVE.includes(o.status)) throw new HttpError(409, 'This order is already completed.');
        const b = await readJson(req);
        const before = o.riderId;
        if (b.riderId === null || b.riderId === '') o.riderId = null;
        else if (!db.rider(b.riderId)) throw new HttpError(404, 'Rider not found.');
        else o.riderId = b.riderId;
        db.save();
        if (before && before !== o.riderId) push(streams.riders.get(before), 'orders', null);
        broadcastOrder(o);
        return sendJson(res, 200, adminView(o));
      }
      if (m === 'GET' && p === '/api/admin/products') return sendJson(res, 200, { products: db.data.products, categories });
      if (m === 'POST' && p === '/api/admin/products') {
        const b = await readJson(req);
        const v = validateProduct(b, null);
        const base = v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'product';
        let id = `${base}-${v.netQuantity.toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
        while (db.product(id)) id = `${base}-${randomCode(4).toLowerCase()}`;
        const prod = { id, packer: '', active: true, ...v };
        db.data.products.push(prod); db.save(); broadcastStock(prod);
        return sendJson(res, 201, prod);
      }
      if ((match = p.match(/^\/api\/admin\/products\/([a-z0-9-]+)$/)) && m === 'POST') {
        const prod = db.product(match[1]); if (!prod) throw new HttpError(404, 'Product not found.');
        const b = await readJson(req);
        Object.assign(prod, validateProduct(b, prod)); db.save(); broadcastStock(prod);
        return sendJson(res, 200, prod);
      }
      if (m === 'GET' && p === '/api/admin/riders') return sendJson(res, 200, db.data.riders.map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt })));
      if (m === 'POST' && p === '/api/admin/riders') {
        const b = await readJson(req);
        const e = rules.name(b.name);
        if (e) throw new HttpError(422, 'Check the highlighted details.', { fields: { name: e } });
        const code = randomCode(10);
        const r = { id: randomCode(8), name: String(b.name).trim(), codeHash: sha256(code), createdAt: new Date().toISOString() };
        db.data.riders.push(r); db.save();
        return sendJson(res, 201, { id: r.id, name: r.name, code });
      }
      if ((match = p.match(/^\/api\/admin\/riders\/([A-Z0-9]{8})\/remove$/)) && m === 'POST') {
        const r = db.rider(match[1]); if (!r) throw new HttpError(404, 'Rider not found.');
        if (db.data.orders.some((o) => o.riderId === r.id && ACTIVE.includes(o.status))) throw new HttpError(409, 'This rider has orders in progress. Reassign them first.');
        db.data.riders = db.data.riders.filter((x) => x.id !== r.id);
        for (const [t, s] of sessions) if (s.riderId === r.id) sessions.delete(t);
        db.save();
        return sendJson(res, 200, { ok: true });
      }
      if (m === 'GET' && p === '/api/admin/requests') {
        return sendJson(res, 200, {
          requests: db.data.requests.slice().reverse().map(({ phoneHash, ...r }) => r),
          subscribers: db.data.subscribers.length,
          outbox: db.data.outbox.length
        });
      }
      throw new HttpError(404, 'Not found.');
    }

    // Rider
    if (m === 'POST' && p === '/api/rider/login') {
      if (!limit.login(clientIp(req))) throw new HttpError(429, 'Too many sign-in attempts. Wait 15 minutes and try again.');
      const b = await readJson(req);
      const hash = sha256(String(b.code || '').trim().toUpperCase());
      const r = db.data.riders.find((x) => safeEqual(x.codeHash, hash));
      if (!r) throw new HttpError(401, 'That rider code is not correct.');
      startSession(res, { role: 'rider', riderId: r.id });
      return sendJson(res, 200, { name: r.name });
    }
    if (p.startsWith('/api/rider/')) {
      const s = requireRole(req, 'rider');
      const mine = (id) => {
        const o = db.order(id);
        if (!o || o.riderId !== s.riderId) throw new HttpError(404, 'This order is not assigned to you.');
        return o;
      };
      if (m === 'GET' && p === '/api/rider/me') return sendJson(res, 200, { name: db.rider(s.riderId).name });
      if (m === 'GET' && p === '/api/rider/stream') return openStream(req, res, keyedSet(streams.riders, s.riderId));
      if (m === 'GET' && p === '/api/rider/orders') {
        return sendJson(res, 200, db.data.orders.filter((o) => o.riderId === s.riderId && ACTIVE.includes(o.status) && o.status !== 'placed').map(riderView));
      }
      if ((match = p.match(/^\/api\/rider\/orders\/([A-Z0-9]{10})\/start$/)) && m === 'POST') {
        const o = mine(match[1]);
        if (o.status !== 'packed') throw new HttpError(409, 'The store has not marked this order as packed yet.');
        setStatus(o, 'out_for_delivery');
        return sendJson(res, 200, riderView(o));
      }
      if ((match = p.match(/^\/api\/rider\/orders\/([A-Z0-9]{10})\/location$/)) && m === 'POST') {
        const o = mine(match[1]);
        if (o.status !== 'out_for_delivery') throw new HttpError(409, 'Location is shared only while the order is out for delivery.');
        const b = await readJson(req);
        const loc = { lat: Number(b.lat), lng: Number(b.lng) };
        if (!isValidCoord(loc)) throw new HttpError(422, 'Invalid location.');
        const last = lastLocationAt.get(o.id) || 0;
        if (Date.now() - last < 3000) return sendJson(res, 202, { skipped: true });
        lastLocationAt.set(o.id, Date.now());
        const acc = Number(b.accuracy);
        riderLocations.set(o.id, { lat: loc.lat, lng: loc.lng, accuracy: Number.isFinite(acc) ? Math.round(acc) : null, at: new Date().toISOString() });
        push(streams.orders.get(o.id), 'order', customerView(o));
        push(streams.admin, 'order', adminView(o));
        return sendJson(res, 200, { ok: true });
      }
      if ((match = p.match(/^\/api\/rider\/orders\/([A-Z0-9]{10})\/delivered$/)) && m === 'POST') {
        const o = mine(match[1]);
        if (o.status !== 'out_for_delivery') throw new HttpError(409, 'Start the delivery before marking it delivered.');
        setStatus(o, 'delivered');
        return sendJson(res, 200, { ok: true });
      }
      throw new HttpError(404, 'Not found.');
    }
    throw new HttpError(404, 'Not found.');
  }

  function serveStatic(req, res, url) {
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return false; }
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir + path.sep)) return false;
    let st;
    try { st = fs.statSync(file); } catch { return false; }
    if (!st.isFile()) return false;
    const type = TYPES[path.extname(file).toLowerCase()];
    if (!type) return false;
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': production ? 'public, max-age=3600' : 'no-cache' });
    if (req.method === 'HEAD') { res.end(); return true; }
    fs.createReadStream(file).pipe(res);
    return true;
  }

  const server = http.createServer(async (req, res) => {
    setSecurityHeaders(res);
    let url;
    try { url = new URL(req.url, 'http://local'); } catch { res.writeHead(400); return res.end(); }
    try {
      if (url.pathname.startsWith('/api/')) {
        if (req.method === 'POST') {
          const origin = req.headers.origin;
          if (origin) {
            const host = (env.TRUST_PROXY === '1' && req.headers['x-forwarded-host']) || req.headers.host;
            let same = false;
            try { same = new URL(origin).host === host; } catch { same = false; }
            if (!same) throw new HttpError(403, 'Cross-site request blocked.');
          }
        }
        return await api(req, res, url);
      }
      // One-click unsubscribe (RFC 8058): mail providers POST to the link in the List-Unsubscribe header.
      if (req.method === 'POST' && url.pathname === '/unsubscribe') {
        unsubscribe(url.searchParams.get('t') || '');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Unsubscribed.');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
      if (demo && url.pathname === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('User-agent: *\nDisallow: /\n'); }
      if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
      const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : '/';
      const html = renderer.render(pathname, { customer: !!session(req, 'customer') });
      if (html) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        return res.end(req.method === 'HEAD' ? undefined : html);
      }
      if (serveStatic(req, res, url)) return;
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : renderer.renderNotFound());
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, ...(err.details || {}) });
      console.error(err);
      sendJson(res, 500, { error: 'Something went wrong on our side. Please try again.' });
    }
  });

  server.on('close', () => { clearInterval(heartbeat); clearInterval(purgeTimer); });
  return { server, db, close: () => new Promise((r) => { for (const set of [streams.stock, streams.admin, ...streams.orders.values(), ...streams.riders.values()]) for (const s of set) s.end(); server.close(r); }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let app;
  try { app = createApp(); } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, () => console.log(`Pradhan’s Mart running on http://localhost:${port}`));
}
