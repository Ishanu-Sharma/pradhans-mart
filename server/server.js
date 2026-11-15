import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDb } from './db.js';
import { createRenderer, pages, HOME } from './render.js';
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
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2'
};

const STATUS_LABEL = {
  placed: 'Order placed', accepted: 'Accepted by the store', packed: 'Packed',
  rider_assigned: 'Delivery partner assigned', out_for_delivery: 'Out for delivery',
  delivered: 'Delivered', cancelled: 'Cancelled'
};
const ACTIVE = ['placed', 'accepted', 'packed', 'rider_assigned', 'out_for_delivery'];
const RIDER_BUSY = ['rider_assigned', 'out_for_delivery'];
const STORE_WORK = ['accepted', 'packed', 'rider_assigned'];
const VEHICLES = { bicycle: 'Bicycle', scooter: 'Scooter', motorcycle: 'Motorcycle' };
const ROLES = ['customer', 'rider', 'store'];

export async function createApp({
  dataDir = path.join(root, 'data'), env = process.env, clock = () => new Date(), rateScale = 1,
  offerMs = { store: 60_000, rider: 45_000 }, noStoreCancelMs = 10 * 60_000, sweepMs = 15_000
} = {}) {
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
    const fillNa = (obj) => { for (const [k, v] of Object.entries(obj)) { if (k.startsWith('_')) continue; if (v && typeof v === 'object') fillNa(v); else if (!String(v ?? '').trim()) obj[k] = na; } };
    if (!business.legalName) business.legalName = `${business.brandName} (demo project, not a registered business)`;
    if (!business.registeredAddress) business.registeredAddress = 'Guwahati, Assam (no registered office)';
    if (!business.storeAddress) business.storeAddress = 'Guwahati, Assam (stores are run by store partners)';
    if (!business.hostingProvider) business.hostingProvider = 'Render (render.com)';
    if (!business.dataStorageLocation) business.dataStorageLocation = env.MONGODB_URI ? 'MongoDB Atlas, a database service run by MongoDB, Inc.' : 'files on Render servers';
    if (!business.policyEffectiveDate) business.policyEffectiveDate = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(clock());
    fillNa(business);
    business.cin = '';
    store.hours = { ...store.hours, open: '00:00', close: '00:00' };
  }
  const db = await createDb({ dataDir, mongoUri: env.MONGODB_URI, mongoDbName: env.MONGODB_DB });
  const baseUrl = env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${env.PORT || 3000}`;

  let adminPassword = env.ADMIN_PASSWORD;
  if (!adminPassword) {
    adminPassword = randomToken(12);
    console.log(`[dev] No ADMIN_PASSWORD set. This run's admin password: ${adminPassword}`);
  }

  // UPI needs a payment gateway account and a real merchant UPI ID, so the demo offers cash only.
  const paymentMethods = store.paymentMethods.map((m) => ({ ...m, available: !(demo && m.id === 'upi_on_delivery'), note: demo && m.id === 'upi_on_delivery' ? 'Not available in this demo' : '' }));
  const activeProducts = () => db.data.products.filter((p) => p.active);
  const brands = () => [...new Set(activeProducts().map((p) => p.brand))].sort((a, b) => a.localeCompare(b));
  const renderer = createRenderer({ root, business, store, production, getBrands: brands, getProducts: activeProducts, demo });

  // ---------- in-memory state ----------
  const sessions = new Map(); // token -> { role, userId?, exp }
  const riderLocations = new Map(); // orderId -> { lat, lng, accuracy, at } (never written to disk)
  const lastLocationAt = new Map();
  const streams = { stock: new Set(), admin: new Set(), users: new Map() };
  const timers = new Map();

  const limit = {
    order: rateLimiter({ windowMs: 60_000, max: 10 * rateScale }),
    auth: rateLimiter({ windowMs: 15 * 60_000, max: 20 * rateScale }),
    data: rateLimiter({ windowMs: 60_000, max: 5 * rateScale }),
    api: rateLimiter({ windowMs: 60_000, max: 900 * rateScale })
  };

  // ---------- helpers ----------
  const clientIp = (req) => (env.TRUST_PROXY === '1' && req.headers['x-forwarded-for'])
    ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
    : req.socket.remoteAddress || 'unknown';
  const nowIso = () => new Date().toISOString();

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

  // ---------- sessions ----------
  function session(req) {
    const token = parseCookies(req.headers.cookie).pm_session;
    const s = token && sessions.get(token);
    if (!s || s.exp < Date.now()) return null;
    if (s.role === 'admin') return { ...s, token };
    const u = db.user(s.userId);
    if (!u || u.status === 'suspended' || u.status === 'rejected') return null;
    return { ...s, token, user: u };
  }
  function requireUser(req, role, { active = true } = {}) {
    const s = session(req);
    if (!s || s.role !== role) throw new HttpError(401, 'Please sign in.');
    if (role !== 'admin' && active && s.user.status !== 'active') throw new HttpError(403, 'Your account is waiting for admin approval.');
    return s;
  }
  function startSession(res, data, hours) {
    const token = randomToken(32);
    sessions.set(token, { ...data, exp: Date.now() + hours * 3_600_000 });
    res.setHeader('Set-Cookie', `pm_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.round(hours * 3600)}${production ? '; Secure' : ''}`);
  }
  function endSession(req, res) {
    const token = parseCookies(req.headers.cookie).pm_session;
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', `pm_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${production ? '; Secure' : ''}`);
  }
  const endSessionsFor = (userId) => { for (const [t, s] of sessions) if (s.userId === userId) sessions.delete(t); };
  const sessionHours = (role) => (role === 'customer' ? store.retention.customerSessionDays * 24 : store.retention.staffSessionHours);
  const DUMMY_HASH = hashPassword(randomToken(12)); // keeps sign-in timing the same for unknown numbers

  // ---------- streams ----------
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
  const userSet = (id) => { if (!streams.users.has(id)) streams.users.set(id, new Set()); return streams.users.get(id); };
  const pushUser = (id, event, data) => push(streams.users.get(id), event, data);
  const heartbeat = setInterval(() => {
    const all = [...streams.stock, ...streams.admin, ...[...streams.users.values()].flatMap((s) => [...s])];
    for (const res of all) res.write(': ping\n\n');
  }, 25_000);
  heartbeat.unref();

  // ---------- views ----------
  const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';
  const paymentLabel = (id) => paymentMethods.find((m) => m.id === id)?.label || id;
  const itemCount = (o) => o.items.reduce((n, i) => n + i.qty, 0);

  function waitingText(o) {
    if (o.status === 'placed') return o.offer ? 'Waiting for a store to accept your order.' : 'Looking for an open store.';
    if (o.status === 'packed') return o.offer ? 'Waiting for a delivery partner to accept.' : 'Looking for a free delivery partner.';
    return '';
  }
  function customerView(o) {
    const st = o.storeId ? db.user(o.storeId) : null;
    const rider = o.riderId ? db.user(o.riderId) : null;
    return {
      id: o.id, status: o.status, statusLabel: STATUS_LABEL[o.status], waiting: waitingText(o), history: o.history,
      createdAt: o.createdAt, items: o.items, subtotal: o.subtotal, deliveryFee: o.deliveryFee, total: o.total,
      payment: paymentLabel(o.payment), canCancel: ['placed', 'accepted'].includes(o.status), cancelReason: o.cancelReason || null,
      address: o.anonymized || o.addressPurged ? null : { name: o.customer.name, house: o.customer.house, street: o.customer.street, landmark: o.customer.landmark, pincode: o.customer.pincode },
      customerLocation: o.location || null,
      store: st ? { name: st.storeName } : null,
      rider: rider ? { name: firstName(rider.name), vehicle: VEHICLES[rider.vehicle] || '' } : null,
      riderLocation: riderLocations.get(o.id) || null
    };
  }
  function storeOrderView(o, storeId) {
    const rider = o.riderId ? db.user(o.riderId) : null;
    return {
      id: o.id, status: o.status, statusLabel: STATUS_LABEL[o.status], createdAt: o.createdAt,
      items: o.items, subtotal: o.subtotal, deliveryFee: o.deliveryFee, total: o.total, payment: paymentLabel(o.payment),
      pincode: o.customer.pincode, itemCount: itemCount(o),
      offerExpiresAt: o.offer?.kind === 'store' && o.offer.userId === storeId ? o.offer.expiresAt : null,
      waiting: o.status === 'packed' ? waitingText(o) : '',
      rider: rider ? { name: rider.name, vehicle: VEHICLES[rider.vehicle] || '' } : null
    };
  }
  function riderOfferView(o) {
    const st = db.user(o.storeId);
    return {
      id: o.id, expiresAt: o.offer.expiresAt, itemCount: itemCount(o), total: o.total, payment: paymentLabel(o.payment),
      store: { name: st?.storeName, street: st?.storeStreet, pincode: st?.storePincode },
      drop: { street: o.customer.street, pincode: o.customer.pincode }
    };
  }
  function riderActiveView(o) {
    const st = db.user(o.storeId);
    return {
      id: o.id, status: o.status, statusLabel: STATUS_LABEL[o.status], total: o.total, payment: paymentLabel(o.payment),
      itemCount: itemCount(o), items: o.items.map((i) => ({ name: i.name, netQuantity: i.netQuantity, qty: i.qty })),
      store: { name: st?.storeName, street: st?.storeStreet, pincode: st?.storePincode },
      customer: o.customer, location: o.location || null
    };
  }
  function adminView(o) {
    const st = o.storeId ? db.user(o.storeId) : null;
    const rider = o.riderId ? db.user(o.riderId) : null;
    const offered = o.offer ? db.user(o.offer.userId) : null;
    return {
      ...customerView(o), customer: o.customer, anonymized: !!o.anonymized,
      storeName: st?.storeName || null, riderName: rider?.name || null,
      offer: o.offer ? { kind: o.offer.kind, to: offered ? (offered.storeName || offered.name) : '', expiresAt: o.offer.expiresAt } : null,
      canCancel: ACTIVE.includes(o.status)
    };
  }
  function userAdminView(u) {
    return {
      id: u.id, role: u.role, status: u.status, name: u.name, phone: u.phone, createdAt: u.createdAt,
      online: !!u.online, vehicle: VEHICLES[u.vehicle] || null, storeName: u.storeName || null,
      storeStreet: u.storeStreet || null, storePincode: u.storePincode || null,
      orders: db.data.orders.filter((o) => o.customerId === u.id || o.storeId === u.id || o.riderId === u.id).length
    };
  }

  // ---------- availability (what the shop shows) ----------
  const openStores = () => db.users('store').filter((s) => s.status === 'active' && s.online);
  function availabilityMap() {
    const stores = openStores();
    const m = {};
    for (const p of db.data.products) m[p.id] = p.active ? stores.reduce((mx, s) => Math.max(mx, s.stock?.[p.id] || 0), 0) : 0;
    return m;
  }
  let lastAvail = availabilityMap();
  let lastOpen = openStores().length;
  function refreshAvailability() {
    const a = availabilityMap();
    for (const [id, n] of Object.entries(a)) if (lastAvail[id] !== n) push(streams.stock, 'stock', { id, available: n });
    lastAvail = a;
    const open = openStores().length;
    if (open !== lastOpen) push(streams.stock, 'stores', { open });
    lastOpen = open;
  }
  const publicProduct = (p) => ({
    id: p.id, name: p.name, brand: p.brand, brandOwner: p.brandOwner, category: p.category,
    netQuantity: p.netQuantity, mrp: p.mrp, price: p.price, available: lastAvail[p.id] || 0,
    image: p.image || null, imageCredit: p.imageCredit || null, countryOfOrigin: p.countryOfOrigin, packer: p.packer
  });

  // ---------- dispatch: offer each order to one partner at a time ----------
  const clearTimer = (id) => { clearTimeout(timers.get(id)); timers.delete(id); };
  const storeHasItems = (s, o) => o.items.every((l) => (s.stock?.[l.id] || 0) >= l.qty);
  const storeLoad = (s) => db.data.orders.filter((o) => o.storeId === s.id && STORE_WORK.includes(o.status)).length;
  const riderBusy = (r) => db.data.orders.some((o) => (o.riderId === r.id && RIDER_BUSY.includes(o.status)) || (o.offer?.kind === 'rider' && o.offer.userId === r.id));

  // A store in the customer's pincode first, then the store with the fewest orders in hand.
  const candidateStores = (o) => openStores()
    .filter((s) => !o.declined.store.includes(s.id) && storeHasItems(s, o))
    .sort((a, b) => ((a.storePincode === o.customer.pincode ? 0 : 1) - (b.storePincode === o.customer.pincode ? 0 : 1)) || (storeLoad(a) - storeLoad(b)) || a.createdAt.localeCompare(b.createdAt));
  // The free, online delivery partner who has been waiting longest.
  const candidateRiders = (o) => db.users('rider')
    .filter((r) => r.status === 'active' && r.online && !o.declined.rider.includes(r.id) && !riderBusy(r))
    .sort((a, b) => (a.lastFreeAt || a.createdAt).localeCompare(b.lastFreeAt || b.createdAt));

  function dispatch(o, notify = []) {
    if (o.offer) {
      if (Date.parse(o.offer.expiresAt) > Date.now()) return;
      o.declined[o.offer.kind].push(o.offer.userId); // an offer that ran out counts as declined
      notify.push(o.offer.userId);
      o.offer = null;
    }
    clearTimer(o.id);
    const kind = o.status === 'placed' ? 'store' : o.status === 'packed' ? 'rider' : null;
    if (kind) {
      const next = (kind === 'store' ? candidateStores(o) : candidateRiders(o))[0];
      if (next) {
        const ms = offerMs[kind];
        o.offer = { kind, userId: next.id, expiresAt: new Date(Date.now() + ms).toISOString() };
        const t = setTimeout(() => expireOffer(o.id, kind, next.id), ms);
        t.unref?.();
        timers.set(o.id, t);
      } else {
        if (o.declined[kind].length) o.declined[kind] = []; // everyone said no: ask them all again on the next sweep
        if (kind === 'store' && Date.now() - Date.parse(o.createdAt) > noStoreCancelMs) {
          return cancelOrder(o, 'No open store could take your order in time. You have not been charged.', notify);
        }
      }
    }
    db.save();
    broadcastOrder(o, notify);
  }
  function expireOffer(orderId, kind, userId) {
    const o = db.order(orderId);
    if (!o || o.offer?.kind !== kind || o.offer.userId !== userId) return;
    o.offer.expiresAt = new Date(0).toISOString();
    dispatch(o);
  }
  function declineOffer(o, userId) {
    clearTimer(o.id);
    o.declined[o.offer.kind].push(userId);
    o.offer = null;
    dispatch(o, [userId]);
  }
  function sweep() {
    for (const o of db.data.orders) {
      if ((o.status === 'placed' || o.status === 'packed') && (!o.offer || Date.parse(o.offer.expiresAt) <= Date.now())) dispatch(o);
    }
  }
  const sweepTimer = setInterval(sweep, sweepMs); sweepTimer.unref();

  function broadcastOrder(o, extra = []) {
    if (o.customerId) pushUser(o.customerId, 'order', customerView(o));
    const ids = new Set([o.storeId, o.riderId, o.offer?.userId, ...extra].filter(Boolean));
    for (const id of ids) pushUser(id, 'refresh', { orderId: o.id });
    push(streams.admin, 'order', adminView(o));
  }
  function setStatus(o, status, extra = []) {
    o.status = status;
    o.history.push({ status, label: STATUS_LABEL[status], at: nowIso() });
    if (status === 'delivered' || status === 'cancelled') {
      o.completedAt = nowIso();
      riderLocations.delete(o.id);
      lastLocationAt.delete(o.id);
    }
    db.save();
    broadcastOrder(o, extra);
  }
  function cancelOrder(o, reason, notify = []) {
    clearTimer(o.id);
    if (o.offer) { notify.push(o.offer.userId); o.offer = null; }
    if (o.stockTaken && !o.stockRestored) {
      const s = db.user(o.storeId);
      if (s) for (const l of o.items) s.stock[l.id] = (s.stock[l.id] || 0) + l.qty;
      o.stockRestored = true;
    }
    const rider = o.riderId ? db.user(o.riderId) : null;
    o.cancelReason = reason;
    setStatus(o, 'cancelled', notify);
    if (rider) rider.lastFreeAt = nowIso();
    refreshAvailability();
    sweep();
  }

  // ---------- account helpers ----------
  function validateAddress(b) {
    const fields = {};
    for (const f of ['house', 'street', 'landmark']) { const e = rules[f](b[f]); if (e) fields[f] = e; }
    const pe = rules.pincode(b.pincode, store.serviceArea.pincodes); if (pe) fields.pincode = pe;
    if (Object.keys(fields).length) throw new HttpError(422, 'Check the highlighted details.', { fields });
    return { house: String(b.house).trim(), street: String(b.street).trim(), landmark: String(b.landmark || '').trim(), pincode: String(b.pincode).trim() };
  }
  function anonymiseOrders(orders) {
    const at = nowIso();
    for (const o of orders) {
      o.customer = { name: null, phone: null, house: null, street: null, landmark: null, pincode: null };
      o.location = null; o.customerId = null; o.anonymized = true; o.anonymizedAt = at;
    }
  }
  function accountView(u) {
    return {
      role: u.role, status: u.status, name: u.name, phone: u.phone, address: u.address || null, createdAt: u.createdAt,
      orders: db.data.orders.filter((o) => o.customerId === u.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((o) => ({ id: o.id, status: o.status, statusLabel: STATUS_LABEL[o.status], total: o.total, createdAt: o.createdAt, itemCount: itemCount(o), image: db.product(o.items[0]?.id)?.image || null }))
    };
  }
  function deleteUserData(u) {
    const mine = db.data.orders.filter((o) => o.customerId === u.id);
    anonymiseOrders(mine);
    db.data.subscribers = db.data.subscribers.filter((x) => x.phoneHash !== sha256(u.phone));
    db.data.users = db.data.users.filter((x) => x.id !== u.id);
    endSessionsFor(u.id);
    return mine.length;
  }

  // ---------- orders ----------
  async function createOrder(req, res) {
    const s = requireUser(req, 'customer');
    if (!limit.order(clientIp(req))) throw new HttpError(429, 'Too many orders from this connection. Try again in a minute.');
    if (!isOpen(store.hours, clock())) throw new HttpError(409, `Orders are closed. We take orders from ${formatTime12(store.hours.open)} to ${formatTime12(store.hours.close)}.`);
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
    const method = paymentMethods.find((m) => m.id === b.payment);
    if (!method) fields.payment = 'Choose how you will pay.';
    else if (!method.available) fields.payment = `${method.label} is not available in this demo. Choose cash on delivery.`;
    const consents = b.consents || {};
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
        lines.push({ id, name: p.name, brand: p.brand, netQuantity: p.netQuantity, price: p.price, qty });
      }
    }
    if (Object.keys(fields).length) throw new HttpError(422, 'Check the highlighted details.', { fields });

    const subtotal = lines.reduce((t, l) => t + l.price * l.qty, 0);
    const deliveryFee = subtotal >= store.fees.freeDeliveryFrom ? 0 : store.fees.deliveryFee;
    const sums = { subtotal, deliveryFee, total: subtotal + deliveryFee };
    if (Number(b.expectedTotal) !== sums.total) {
      throw new HttpError(409, 'A price changed while you were checking out. Review the new total before you place the order.', { totals: sums, code: 'total_changed' });
    }
    const probe = { items: lines, customer: { pincode: String(c.pincode).trim() }, declined: { store: [], rider: [] } };
    if (candidateStores(probe).length === 0) {
      throw new HttpError(409, 'No open store has all of these items right now. Remove anything marked out of stock, or try again shortly.', { code: 'no_store' });
    }

    let id; do { id = `PM${randomCode(8)}`; } while (db.order(id));
    const now = nowIso();
    const o = {
      id, createdAt: now, status: 'placed', history: [{ status: 'placed', label: STATUS_LABEL.placed, at: now }],
      items: lines, ...sums, payment: b.payment, customerId: s.user.id,
      customer: {
        name: String(c.name).trim(), phone: normalisePhone(c.phone), house: String(c.house).trim(),
        street: String(c.street).trim(), landmark: String(c.landmark || '').trim(), pincode: String(c.pincode).trim()
      },
      location, storeId: null, riderId: null, offer: null, declined: { store: [], rider: [] },
      consents: { termsAcceptedAt: s.user.termsAcceptedAt, ageConfirmedAt: s.user.ageConfirmedAt, policyVersion: business.policyEffectiveDate || 'draft' }
    };
    if (b.saveAddress === true) s.user.address = { house: o.customer.house, street: o.customer.street, landmark: o.customer.landmark, pincode: o.customer.pincode };
    db.data.orders.push(o);
    if (email && !db.data.subscribers.some((x) => x.email === email)) {
      const unsubscribeToken = randomToken();
      db.data.subscribers.push({ id: randomCode(10), email, unsubscribeToken, phoneHash: sha256(o.customer.phone), consentAt: now, consentText: 'Email me offers from Pradhan’s Mart. I can unsubscribe at any time.' });
      db.data.outbox.push({ createdAt: now, ...composeWelcomeEmail({ business, baseUrl, email, unsubscribeToken }) });
    }
    dispatch(o);
    sendJson(res, 201, { id: o.id, total: o.total });
  }
  function myOrder(s, id) {
    const o = db.order(String(id || '').toUpperCase());
    if (!o || o.customerId !== s.user.id) throw new HttpError(404, 'Order not found in your account.');
    return o;
  }

  // ---------- data rights ----------
  function findOrderByProof(orderId, phone) {
    const o = db.order(String(orderId || '').trim().toUpperCase());
    if (!o || o.anonymized || o.customer.phone !== normalisePhone(phone)) return null;
    return o;
  }
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
    const subs = db.data.subscribers.filter((x) => x.phoneHash === phoneHash);
    const accounts = db.data.users.filter((u) => u.role === 'customer' && u.phone === phone);
    const log = { id: randomCode(10), type: b.type, at: nowIso(), phoneHash, orders: orders.length };
    if (b.type === 'export') {
      db.data.requests.push({ ...log, result: 'completed' }); db.save();
      return sendJson(res, 200, {
        generatedAt: log.at,
        about: `Personal data held by ${business.legalName || business.brandName} for mobile number ${phone}`,
        account: accounts.map((u) => ({ name: u.name, phone: u.phone, createdAt: u.createdAt, savedAddress: u.address || null, password: 'Stored only as a one-way hash' }))[0] || null,
        orders: orders.map((o) => ({
          id: o.id, placedAt: o.createdAt, status: STATUS_LABEL[o.status], items: o.items, total: o.total,
          payment: paymentLabel(o.payment), name: o.customer.name, phone: o.customer.phone,
          address: o.addressPurged ? 'Deleted after delivery under our retention rule' : { house: o.customer.house, street: o.customer.street, landmark: o.customer.landmark, pincode: o.customer.pincode },
          deliveryLocation: o.location || null, consents: o.consents
        })),
        marketingEmails: subs.map((x) => ({ email: x.email, consentAt: x.consentAt, consentText: x.consentText }))
      });
    }
    if (orders.some((o) => ACTIVE.includes(o.status))) {
      db.data.requests.push({ ...log, result: 'refused: order in progress' }); db.save();
      throw new HttpError(409, 'You have an order in progress. You can delete your data once it is delivered or cancelled.');
    }
    anonymiseOrders(orders);
    db.data.subscribers = db.data.subscribers.filter((x) => x.phoneHash !== phoneHash);
    for (const u of accounts) deleteUserData(u);
    db.data.requests.push({ ...log, result: 'completed' });
    db.save();
    sendJson(res, 200, { deletedOrders: orders.length, deletedSubscriptions: subs.length, deletedAccount: accounts.length > 0 });
  }
  function unsubscribe(token) {
    const before = db.data.subscribers.length;
    db.data.subscribers = db.data.subscribers.filter((x) => x.unsubscribeToken !== token);
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
    const num = (k, label) => {
      if (b[k] === undefined && existing) return;
      const v = Number(b[k]);
      if (!Number.isFinite(v) || v < 0.01) fields[k] = `Enter a valid ${label}.`;
      else out[k] = Math.round(v * 100) / 100;
    };
    num('mrp', 'MRP');
    num('price', 'price');
    const mrp = out.mrp ?? existing?.mrp; const price = out.price ?? existing?.price;
    if (!fields.mrp && !fields.price && price > mrp) fields.price = 'The selling price cannot be higher than the MRP.';
    if (b.active !== undefined) out.active = b.active === true;
    if (!existing) {
      if (b.indianBrandConfirmed !== true) fields.indianBrandConfirmed = 'Confirm that this brand was founded in India and is owned in India.';
      out.indianBrandConfirmed = true; out.countryOfOrigin = 'India'; out.defaultStock = 0; out.image = null; out.imageCredit = null;
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

    // ----- public -----
    if (m === 'GET' && p === '/api/config') {
      return sendJson(res, 200, {
        brandName: business.brandName, city: store.city, serviceArea: store.serviceArea, isOpen: isOpen(store.hours, clock()),
        hours: { open: formatTime12(store.hours.open), close: formatTime12(store.hours.close), allDay: store.hours.open === store.hours.close },
        fees: store.fees, limits: store.limits, paymentMethods, categories, vehicles: VEHICLES, demo,
        openStores: openStores().length
      });
    }
    if (m === 'POST' && p === '/api/data-requests') return dataRequest(req, res);
    if (m === 'POST' && p === '/api/unsubscribe') {
      const b = await readJson(req);
      return sendJson(res, 200, { removed: unsubscribe(String(b.token || '')) });
    }

    // ----- sign up, sign in -----
    if (m === 'POST' && p === '/api/auth/register') {
      if (!limit.auth(clientIp(req))) throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.');
      const b = await readJson(req);
      const role = b.role;
      if (!ROLES.includes(role)) throw new HttpError(422, 'Choose customer, delivery partner or store partner.');
      const fields = {};
      for (const k of ['name', 'phone', 'password']) { const e = rules[k](b[k]); if (e) fields[k] = e; }
      if (b.terms !== true) fields.terms = 'Accept the Terms of service and Privacy policy to continue.';
      if (b.age !== true) fields.age = 'You must be 18 or older.';
      if (role === 'rider' && !VEHICLES[b.vehicle]) fields.vehicle = 'Choose your vehicle.';
      if (role === 'store') {
        const sn = String(b.storeName || '').trim();
        if (sn.length < 2 || sn.length > 60) fields.storeName = 'Enter the store name, 2 to 60 characters.';
        const st = rules.street(b.storeStreet); if (st) fields.storeStreet = st;
        const pc = rules.pincode(b.storePincode, store.serviceArea.pincodes); if (pc) fields.storePincode = pc;
      }
      if (Object.keys(fields).length) throw new HttpError(422, 'Check the highlighted details.', { fields });
      const phone = normalisePhone(b.phone);
      if (db.data.users.some((u) => u.role === role && u.phone === phone)) {
        const msg = 'An account with this mobile number already exists. Sign in instead.';
        throw new HttpError(409, msg, { fields: { phone: msg } });
      }
      const now = nowIso();
      const u = {
        id: randomCode(10), role, status: role === 'customer' ? 'active' : 'pending',
        name: String(b.name).trim(), phone, passwordHash: hashPassword(b.password),
        createdAt: now, termsAcceptedAt: now, ageConfirmedAt: now
      };
      if (role === 'customer') u.address = null;
      if (role === 'rider') Object.assign(u, { vehicle: b.vehicle, online: false, lastFreeAt: null });
      if (role === 'store') Object.assign(u, { storeName: String(b.storeName).trim(), storeStreet: String(b.storeStreet).trim(), storePincode: String(b.storePincode).trim(), online: false, stock: {} });
      db.data.users.push(u); db.save();
      startSession(res, { role, userId: u.id }, sessionHours(role));
      if (role !== 'customer') push(streams.admin, 'users', { pending: db.data.users.filter((x) => x.status === 'pending').length });
      return sendJson(res, 201, { role, status: u.status, home: HOME[role] });
    }
    if (m === 'POST' && p === '/api/auth/login') {
      if (!limit.auth(clientIp(req))) throw new HttpError(429, 'Too many sign-in attempts. Wait 15 minutes and try again.');
      const b = await readJson(req);
      const role = ROLES.includes(b.role) ? b.role : 'customer';
      const phone = normalisePhone(b.phone);
      const u = db.data.users.find((x) => x.role === role && x.phone === phone);
      const ok = verifyPassword(String(b.password || ''), u ? u.passwordHash : DUMMY_HASH);
      if (!u || !ok) throw new HttpError(401, 'That mobile number and password do not match an account.');
      if (u.status === 'suspended') throw new HttpError(403, 'This account is suspended. Contact support.');
      if (u.status === 'rejected') throw new HttpError(403, 'Your application was not approved. Contact support for details.');
      startSession(res, { role, userId: u.id }, sessionHours(role));
      return sendJson(res, 200, { role, status: u.status, home: HOME[role] });
    }
    // Forgot password: a 6-digit code, valid for 10 minutes, 5 tries.
    // A live service sends it by SMS. No SMS provider is connected, so the demo shows it on screen.
    if (m === 'POST' && p === '/api/auth/forgot') {
      if (!limit.auth(clientIp(req))) throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.');
      const b = await readJson(req);
      const role = ROLES.includes(b.role) ? b.role : 'customer';
      const e = rules.phone(b.phone);
      if (e) throw new HttpError(422, 'Check the highlighted details.', { fields: { phone: e } });
      if (!demo) throw new HttpError(503, 'Password reset by SMS is not set up yet. Contact support to reset your password.');
      const u = db.data.users.find((x) => x.role === role && x.phone === normalisePhone(b.phone) && x.status !== 'suspended' && x.status !== 'rejected');
      const generic = { sent: true, message: 'If an account exists for this number, a code has been sent.' };
      if (!u) return sendJson(res, 200, generic);
      const code = String(Math.floor(100000 + Math.random() * 900000));
      u.reset = { codeHash: sha256(`${u.id}:${code}`), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), attempts: 0 };
      db.save();
      return sendJson(res, 200, { ...generic, demoCode: code });
    }
    if (m === 'POST' && p === '/api/auth/reset') {
      if (!limit.auth(clientIp(req))) throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.');
      const b = await readJson(req);
      const role = ROLES.includes(b.role) ? b.role : 'customer';
      const fields = {};
      const pe = rules.phone(b.phone); if (pe) fields.phone = pe;
      if (!/^\d{6}$/.test(String(b.code || '').trim())) fields.code = 'Enter the 6-digit code.';
      const pw = rules.password(b.password); if (pw) fields.password = pw;
      if (Object.keys(fields).length) throw new HttpError(422, 'Check the highlighted details.', { fields });
      const u = db.data.users.find((x) => x.role === role && x.phone === normalisePhone(b.phone));
      const bad = () => new HttpError(422, 'Check the highlighted details.', { fields: { code: 'That code is not correct or has expired. Ask for a new one.' } });
      if (!u || !u.reset) throw bad();
      if (Date.parse(u.reset.expiresAt) < Date.now() || u.reset.attempts >= 5) { delete u.reset; db.save(); throw bad(); }
      if (!safeEqual(u.reset.codeHash, sha256(`${u.id}:${String(b.code).trim()}`))) { u.reset.attempts += 1; db.save(); throw bad(); }
      delete u.reset;
      u.passwordHash = hashPassword(b.password);
      db.save();
      endSessionsFor(u.id); // signs out every other device
      startSession(res, { role, userId: u.id }, sessionHours(role));
      return sendJson(res, 200, { role, status: u.status, home: HOME[role] });
    }
    if (m === 'POST' && p === '/api/auth/logout') {
      const s = session(req);
      if (s?.user && (s.role === 'rider' || s.role === 'store') && s.user.online && !(s.role === 'rider' && riderBusy(s.user))) {
        s.user.online = false; db.save(); refreshAvailability();
      }
      endSession(req, res);
      return sendJson(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/auth/me') {
      const s = session(req);
      if (!s || s.role === 'admin') throw new HttpError(401, 'Please sign in.');
      return sendJson(res, 200, { role: s.role, status: s.user.status, name: s.user.name, home: HOME[s.role] });
    }
    if (m === 'GET' && p === '/api/stream/me') {
      const s = session(req);
      if (!s || s.role === 'admin') throw new HttpError(401, 'Please sign in.');
      return openStream(req, res, userSet(s.user.id));
    }

    // ----- customers -----
    if (m === 'GET' && p === '/api/products') {
      requireUser(req, 'customer');
      return sendJson(res, 200, { products: activeProducts().map(publicProduct), openStores: openStores().length });
    }
    if (m === 'GET' && p === '/api/stream/stock') { requireUser(req, 'customer'); return openStream(req, res, streams.stock); }
    if (m === 'POST' && p === '/api/orders') return createOrder(req, res);
    if ((match = p.match(/^\/api\/orders\/([A-Z0-9]{10})$/)) && m === 'GET') {
      const s = requireUser(req, 'customer');
      return sendJson(res, 200, customerView(myOrder(s, match[1])));
    }
    if ((match = p.match(/^\/api\/orders\/([A-Z0-9]{10})\/cancel$/)) && m === 'POST') {
      const s = requireUser(req, 'customer');
      const o = myOrder(s, match[1]);
      if (!['placed', 'accepted'].includes(o.status)) throw new HttpError(409, 'This order is already packed, so it can no longer be cancelled here. Contact support for help.');
      cancelOrder(o, 'You cancelled this order.');
      return sendJson(res, 200, customerView(o));
    }
    if (p.startsWith('/api/account/')) {
      const s = requireUser(req, 'customer');
      const u = s.user;
      if (m === 'GET' && p === '/api/account/me') return sendJson(res, 200, accountView(u));
      if (m === 'POST' && p === '/api/account/address') {
        const b = await readJson(req);
        u.address = b.remove === true ? null : validateAddress(b);
        db.save();
        return sendJson(res, 200, accountView(u));
      }
      if (m === 'POST' && p === '/api/account/delete') {
        const b = await readJson(req);
        if (!verifyPassword(String(b.password || ''), u.passwordHash)) throw new HttpError(422, 'Check the highlighted details.', { fields: { 'del-password': 'That password is not correct.' } });
        if (db.data.orders.some((o) => o.customerId === u.id && ACTIVE.includes(o.status))) throw new HttpError(409, 'You have an order in progress. You can delete your account once it is delivered or cancelled.');
        const phoneHash = sha256(u.phone);
        const n = deleteUserData(u);
        db.data.requests.push({ id: randomCode(10), type: 'delete account', at: nowIso(), phoneHash, orders: n, result: 'completed' });
        db.save();
        endSession(req, res);
        return sendJson(res, 200, { deletedOrders: n });
      }
      throw new HttpError(404, 'Not found.');
    }

    // ----- store partners -----
    if (p.startsWith('/api/store/')) {
      const s = requireUser(req, 'store', { active: p !== '/api/store/dashboard' });
      const st = s.user;
      if (m === 'GET' && p === '/api/store/dashboard') {
        const mine = db.data.orders.filter((o) => o.storeId === st.id);
        const today = new Date(); today.setHours(0, 0, 0, 0);
        return sendJson(res, 200, {
          store: { name: st.name, storeName: st.storeName, storeStreet: st.storeStreet, storePincode: st.storePincode, status: st.status, online: !!st.online },
          offers: db.data.orders.filter((o) => o.offer?.kind === 'store' && o.offer.userId === st.id).map((o) => storeOrderView(o, st.id)),
          toPack: mine.filter((o) => o.status === 'accepted').map((o) => storeOrderView(o, st.id)),
          handover: mine.filter((o) => ['packed', 'rider_assigned'].includes(o.status)).map((o) => storeOrderView(o, st.id)),
          done: mine.filter((o) => ['out_for_delivery', 'delivered', 'cancelled'].includes(o.status) && Date.parse(o.createdAt) >= today.getTime()).slice(-20).reverse().map((o) => storeOrderView(o, st.id)),
          stock: st.status === 'active' ? activeProducts().map((x) => ({ id: x.id, name: x.name, brand: x.brand, netQuantity: x.netQuantity, image: x.image, category: x.category, stock: st.stock?.[x.id] || 0 })) : []
        });
      }
      if (m === 'POST' && p === '/api/store/online') {
        const b = await readJson(req);
        st.online = b.online === true;
        if (!st.online) for (const o of db.data.orders) if (o.offer?.kind === 'store' && o.offer.userId === st.id) declineOffer(o, st.id);
        db.save(); refreshAvailability();
        if (st.online) sweep();
        return sendJson(res, 200, { online: st.online });
      }
      if (m === 'POST' && p === '/api/store/stock') {
        const b = await readJson(req);
        const next = { ...st.stock };
        for (const [id, v] of Object.entries(b.stock || {})) {
          const n = Number(v);
          if (!db.product(id)) continue;
          if (!Number.isInteger(n) || n < 0 || n > 100000) throw new HttpError(422, 'Stock must be a whole number of 0 or more.');
          next[id] = n;
        }
        st.stock = next; db.save(); refreshAvailability(); sweep();
        return sendJson(res, 200, { ok: true });
      }
      if ((match = p.match(/^\/api\/store\/orders\/([A-Z0-9]{10})\/(accept|decline|packed)$/)) && m === 'POST') {
        const o = db.order(match[1]);
        if (!o) throw new HttpError(404, 'Order not found.');
        const action = match[2];
        if (action === 'accept' || action === 'decline') {
          if (!(o.status === 'placed' && o.offer?.kind === 'store' && o.offer.userId === st.id)) throw new HttpError(409, 'This request is no longer available.');
          if (action === 'decline') { declineOffer(o, st.id); return sendJson(res, 200, { ok: true }); }
          if (!storeHasItems(st, o)) throw new HttpError(409, 'You do not have enough stock for this order. Decline it or update your stock first.');
          for (const l of o.items) st.stock[l.id] -= l.qty;
          clearTimer(o.id);
          o.offer = null; o.storeId = st.id; o.stockTaken = true;
          setStatus(o, 'accepted');
          refreshAvailability();
          return sendJson(res, 200, { ok: true });
        }
        if (o.storeId !== st.id || o.status !== 'accepted') throw new HttpError(409, 'Only accepted orders can be marked packed.');
        setStatus(o, 'packed');
        dispatch(o);
        return sendJson(res, 200, { ok: true });
      }
      throw new HttpError(404, 'Not found.');
    }

    // ----- delivery partners -----
    if (p.startsWith('/api/rider/')) {
      const s = requireUser(req, 'rider', { active: p !== '/api/rider/dashboard' });
      const r = s.user;
      if (m === 'GET' && p === '/api/rider/dashboard') {
        const offer = db.data.orders.find((o) => o.offer?.kind === 'rider' && o.offer.userId === r.id);
        const active = db.data.orders.find((o) => o.riderId === r.id && RIDER_BUSY.includes(o.status));
        const today = new Date(); today.setHours(0, 0, 0, 0);
        return sendJson(res, 200, {
          rider: { name: r.name, vehicle: VEHICLES[r.vehicle], status: r.status, online: !!r.online },
          offer: offer ? riderOfferView(offer) : null,
          active: active ? riderActiveView(active) : null,
          deliveredToday: db.data.orders.filter((o) => o.riderId === r.id && o.status === 'delivered' && Date.parse(o.completedAt) >= today.getTime()).length
        });
      }
      if (m === 'POST' && p === '/api/rider/online') {
        const b = await readJson(req);
        const want = b.online === true;
        if (!want && db.data.orders.some((o) => o.riderId === r.id && RIDER_BUSY.includes(o.status))) throw new HttpError(409, 'Finish your current delivery before going offline.');
        r.online = want;
        if (want && !r.lastFreeAt) r.lastFreeAt = nowIso();
        if (!want) for (const o of db.data.orders) if (o.offer?.kind === 'rider' && o.offer.userId === r.id) declineOffer(o, r.id);
        db.save();
        if (want) sweep();
        return sendJson(res, 200, { online: r.online });
      }
      if ((match = p.match(/^\/api\/rider\/orders\/([A-Z0-9]{10})\/(accept|decline|pickup|delivered|location)$/)) && m === 'POST') {
        const o = db.order(match[1]);
        if (!o) throw new HttpError(404, 'Order not found.');
        const action = match[2];
        if (action === 'accept' || action === 'decline') {
          if (!(o.status === 'packed' && o.offer?.kind === 'rider' && o.offer.userId === r.id)) throw new HttpError(409, 'This request is no longer available.');
          if (action === 'decline') { declineOffer(o, r.id); return sendJson(res, 200, { ok: true }); }
          clearTimer(o.id);
          o.offer = null; o.riderId = r.id;
          setStatus(o, 'rider_assigned');
          return sendJson(res, 200, { ok: true });
        }
        if (o.riderId !== r.id) throw new HttpError(404, 'This order is not assigned to you.');
        if (action === 'pickup') {
          if (o.status !== 'rider_assigned') throw new HttpError(409, 'This order is not waiting for pickup.');
          setStatus(o, 'out_for_delivery');
          return sendJson(res, 200, { ok: true });
        }
        if (action === 'delivered') {
          if (o.status !== 'out_for_delivery') throw new HttpError(409, 'Pick up the order before marking it delivered.');
          setStatus(o, 'delivered');
          r.lastFreeAt = nowIso(); db.save();
          sweep();
          return sendJson(res, 200, { ok: true });
        }
        // location
        if (o.status !== 'out_for_delivery') throw new HttpError(409, 'Location is shared only while the order is out for delivery.');
        const b = await readJson(req);
        const loc = { lat: Number(b.lat), lng: Number(b.lng) };
        if (!isValidCoord(loc)) throw new HttpError(422, 'Invalid location.');
        if (Date.now() - (lastLocationAt.get(o.id) || 0) < 3000) return sendJson(res, 202, { skipped: true });
        lastLocationAt.set(o.id, Date.now());
        const acc = Number(b.accuracy);
        riderLocations.set(o.id, { lat: loc.lat, lng: loc.lng, accuracy: Number.isFinite(acc) ? Math.round(acc) : null, at: nowIso() });
        if (o.customerId) pushUser(o.customerId, 'order', customerView(o));
        push(streams.admin, 'order', adminView(o));
        return sendJson(res, 200, { ok: true });
      }
      throw new HttpError(404, 'Not found.');
    }

    // ----- admin -----
    if (m === 'POST' && p === '/api/admin/login') {
      if (!limit.auth(clientIp(req))) throw new HttpError(429, 'Too many sign-in attempts. Wait 15 minutes and try again.');
      const b = await readJson(req);
      if (!safeEqual(String(b.password || ''), adminPassword)) throw new HttpError(401, 'That password is not correct.');
      startSession(res, { role: 'admin' }, store.retention.staffSessionHours);
      return sendJson(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/admin/logout') { endSession(req, res); return sendJson(res, 200, { ok: true }); }
    if (p.startsWith('/api/admin/')) {
      requireUser(req, 'admin');
      if (m === 'GET' && p === '/api/admin/me') return sendJson(res, 200, { role: 'admin' });
      if (m === 'GET' && p === '/api/admin/stream') return openStream(req, res, streams.admin);
      if (m === 'GET' && p === '/api/admin/overview') {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const users = db.data.users;
        return sendJson(res, 200, {
          ordersToday: db.data.orders.filter((o) => Date.parse(o.createdAt) >= today.getTime()).length,
          activeOrders: db.data.orders.filter((o) => ACTIVE.includes(o.status)).length,
          waitingForStore: db.data.orders.filter((o) => o.status === 'placed').length,
          waitingForRider: db.data.orders.filter((o) => o.status === 'packed').length,
          pending: users.filter((u) => u.status === 'pending').length,
          stores: { total: users.filter((u) => u.role === 'store' && u.status === 'active').length, online: openStores().length },
          riders: { total: users.filter((u) => u.role === 'rider' && u.status === 'active').length, online: users.filter((u) => u.role === 'rider' && u.status === 'active' && u.online).length },
          customers: users.filter((u) => u.role === 'customer').length
        });
      }
      if (m === 'GET' && p === '/api/admin/users') {
        const role = url.searchParams.get('role');
        const list = db.data.users.filter((u) => (role === 'pending' ? u.status === 'pending' : u.role === role));
        return sendJson(res, 200, list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(userAdminView));
      }
      if ((match = p.match(/^\/api\/admin\/users\/([A-Z0-9]{10})\/status$/)) && m === 'POST') {
        const u = db.user(match[1]);
        if (!u) throw new HttpError(404, 'Account not found.');
        const b = await readJson(req);
        const allowed = { pending: ['active', 'rejected'], active: ['suspended'], suspended: ['active'], rejected: ['active'] };
        if (!allowed[u.status]?.includes(b.status)) throw new HttpError(409, `An account that is ${u.status} cannot be set to ${b.status}.`);
        if (b.status === 'suspended') {
          if (u.role === 'rider' && db.data.orders.some((o) => o.riderId === u.id && RIDER_BUSY.includes(o.status))) throw new HttpError(409, 'This delivery partner has a delivery in progress. Wait until it is finished.');
          if (u.role === 'store' && db.data.orders.some((o) => o.storeId === u.id && STORE_WORK.includes(o.status))) throw new HttpError(409, 'This store has orders in progress. Wait until they are handed over.');
          u.online = false;
          for (const o of db.data.orders) if (o.offer?.userId === u.id) declineOffer(o, u.id);
          endSessionsFor(u.id);
        }
        if (b.status === 'active' && u.role === 'store' && Object.keys(u.stock || {}).length === 0) {
          // A newly approved store starts with the catalogue's opening stock, which the owner can then edit.
          u.stock = Object.fromEntries(db.data.products.map((x) => [x.id, x.defaultStock || 0]));
        }
        u.status = b.status;
        db.save(); refreshAvailability(); sweep();
        pushUser(u.id, 'refresh', { status: u.status });
        push(streams.admin, 'users', { pending: db.data.users.filter((x) => x.status === 'pending').length });
        return sendJson(res, 200, userAdminView(u));
      }
      if (m === 'GET' && p === '/api/admin/orders') {
        return sendJson(res, 200, db.data.orders.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 300).map(adminView));
      }
      if ((match = p.match(/^\/api\/admin\/orders\/([A-Z0-9]{10})\/cancel$/)) && m === 'POST') {
        const o = db.order(match[1]);
        if (!o) throw new HttpError(404, 'Order not found.');
        if (!ACTIVE.includes(o.status)) throw new HttpError(409, 'This order is already completed.');
        cancelOrder(o, 'Cancelled by Pradhan’s Mart. You have not been charged.');
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
        db.data.products.push(prod); db.save(); refreshAvailability();
        return sendJson(res, 201, prod);
      }
      if ((match = p.match(/^\/api\/admin\/products\/([a-z0-9-]+)$/)) && m === 'POST') {
        const prod = db.product(match[1]);
        if (!prod) throw new HttpError(404, 'Product not found.');
        const b = await readJson(req);
        Object.assign(prod, validateProduct(b, prod)); db.save(); refreshAvailability();
        return sendJson(res, 200, prod);
      }
      if (m === 'GET' && p === '/api/admin/requests') {
        return sendJson(res, 200, {
          requests: db.data.requests.slice().reverse().map(({ phoneHash, ...rq }) => rq),
          subscribers: db.data.subscribers.length, outbox: db.data.outbox.length
        });
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
    const long = /\.(jpg|png|woff2)$/.test(file);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': production ? `public, max-age=${long ? 604800 : 3600}` : 'no-cache' });
    if (req.method === 'HEAD') { res.end(); return true; }
    fs.createReadStream(file).pipe(res);
    return true;
  }

  function viewerOf(req) {
    const s = session(req);
    if (!s) return {};
    if (s.role === 'admin') return { role: 'admin' };
    return { role: s.role, name: s.user.name, status: s.user.status, pincode: s.user.address?.pincode || null };
  }
  const redirect = (res, to) => { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }); res.end(); };

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
      if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
      if (demo && url.pathname === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('User-agent: *\nDisallow: /\n'); }

      const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : '/';
      const viewer = viewerOf(req);
      if (pathname === '/') return redirect(res, viewer.role ? HOME[viewer.role] : '/login');
      const page = pages[pathname];
      if (page) {
        if (page.access === 'guest' && viewer.role && viewer.role !== 'admin') return redirect(res, HOME[viewer.role]);
        if (['customer', 'rider', 'store'].includes(page.access) && viewer.role !== page.access) {
          if (viewer.role) return redirect(res, HOME[viewer.role]);
          const role = page.access === 'customer' ? '' : `role=${page.access}&`;
          return redirect(res, `/login?${role}next=${encodeURIComponent(pathname + url.search)}`);
        }
        const html = renderer.render(pathname, viewer);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(req.method === 'HEAD' ? undefined : html);
      }
      if (serveStatic(req, res, url)) return;
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : renderer.renderNotFound(viewer));
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, ...(err.details || {}) });
      console.error(err);
      sendJson(res, 500, { error: 'Something went wrong on our side. Please try again.' });
    }
  });

  // Offers that were open when the server stopped are re-sent on start.
  for (const o of db.data.orders) if (o.offer) o.offer.expiresAt = new Date(0).toISOString();
  sweep();

  server.on('close', () => { clearInterval(heartbeat); clearInterval(purgeTimer); clearInterval(sweepTimer); for (const t of timers.values()) clearTimeout(t); });
  return {
    server, db,
    close: () => new Promise((r) => {
      for (const set of [streams.stock, streams.admin, ...streams.users.values()]) for (const x of set) x.end();
      server.close(() => db.close().then(r, r));
    })
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let app;
  try { app = await createApp(); } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, () => console.log(`Pradhan’s Mart running on http://localhost:${port} (data: ${app.db.kind})`));
  const shutdown = () => { app.close().finally(() => process.exit(0)); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
