import { $, $$, api, cart, money, esc, icon, getConfig, liveStream, productImage, updateCartLink } from './common.js';

const grid = $('#products');
const empty = $('#empty');
const status = $('#results-status');
const cartDialog = $('#cart');
const pdDialog = $('#product-dialog');
const search = $('#q');

let config;
let products = new Map();
let openStores = 0;
let activeCategory = 'all';
let query = new URLSearchParams(window.location.search).get('q') || '';

const productName = (p) => `${p.name}, ${p.netQuantity}`;
const maxFor = (p) => Math.min(p.available, config.limits.maxQtyPerItem);

function priceBlock(p) {
  const mrp = p.price < p.mrp ? `<span class="price-note">MRP <span class="mrp-strike">${money(p.mrp)}</span></span>` : '<span class="price-note">MRP, incl. GST</span>';
  return `<div><span class="price">${money(p.price)}</span>${mrp}</div>`;
}
function controlHtml(p) {
  const q = cart.qty(p.id);
  if (p.available <= 0 && q === 0) return '<span class="stock-out">Out of stock</span>';
  if (q === 0) return `<button type="button" class="btn-add" data-action="add" aria-label="Add ${esc(productName(p))} to cart">ADD</button>`;
  return `<div class="stepper" role="group" aria-label="${esc(productName(p))} quantity">
    <button type="button" data-action="dec" aria-label="Remove one ${esc(productName(p))}">${icon('minus')}</button>
    <output>${q}</output>
    <button type="button" data-action="inc" aria-label="Add one more ${esc(productName(p))}" ${q >= maxFor(p) ? 'disabled' : ''}>${icon('plus')}</button>
  </div>`;
}
function cardHtml(p) {
  const out = p.available <= 0;
  return `<li class="product" data-id="${esc(p.id)}"${out ? ' data-out' : ''}>
    <div class="product-media">${productImage(p, 200)}${out ? '<span class="badge badge-out">Out of stock</span>' : ''}</div>
    <div class="product-body">
      <span class="product-qty">${esc(p.netQuantity)}</span>
      <h3 class="product-name"><button type="button" data-action="details">${esc(p.name)}</button></h3>
      <div class="product-foot">${priceBlock(p)}<div class="control">${controlHtml(p)}</div></div>
    </div>
  </li>`;
}

function visible() {
  const q = query.trim().toLowerCase();
  return [...products.values()].filter((p) =>
    (activeCategory === 'all' || p.category === activeCategory) &&
    (!q || p.name.toLowerCase().includes(q) || p.brand.toLowerCase().includes(q)))
    .sort((a, b) => (b.available > 0) - (a.available > 0));
}
function renderGrid() {
  const list = visible();
  grid.innerHTML = list.map(cardHtml).join('');
  empty.hidden = list.length > 0;
  const cat = activeCategory === 'all' ? 'All products' : config.categories.find((c) => c.id === activeCategory)?.name;
  $('#results-title').textContent = query.trim() ? `Results for "${query.trim()}"` : cat;
  status.textContent = `${list.length} ${list.length === 1 ? 'product' : 'products'} shown`;
}
function refreshCard(id, focusAction) {
  const card = grid.querySelector(`[data-id="${CSS.escape(id)}"]`);
  const p = products.get(id);
  if (!card || !p) return;
  card.outerHTML = cardHtml(p);
  if (focusAction) {
    const fresh = grid.querySelector(`[data-id="${CSS.escape(id)}"]`);
    (fresh.querySelector(`[data-action="${focusAction}"]:not([disabled])`) || fresh.querySelector('[data-action="add"], [data-action="dec"], [data-action="details"]'))?.focus();
  }
}
function changeQty(id, delta) {
  const p = products.get(id);
  if (!p) return;
  const next = Math.max(0, Math.min(maxFor(p), cart.qty(id) + delta));
  cart.set(id, next);
  status.textContent = next === 0 ? `${p.name} removed from cart` : `${p.name}: ${next} in cart`;
}

grid.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.closest('[data-id]').dataset.id;
  const a = btn.dataset.action;
  if (a === 'details') return openDetails(id, btn);
  if (a === 'add' || a === 'inc') { changeQty(id, 1); refreshCard(id, 'inc'); }
  if (a === 'dec') { const before = cart.qty(id); changeQty(id, -1); refreshCard(id, before === 1 ? 'add' : 'dec'); }
});

// ---------- product details ----------
function openDetails(id, opener) {
  const p = products.get(id);
  if (!p) return;
  $('#pd-title').textContent = p.name;
  const row = (k, v) => (v ? `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>` : '');
  const credit = p.imageCredit ? `<p class="credit">Photo: <a href="${esc(p.imageCredit)}" rel="noopener">${esc(new URL(p.imageCredit).hostname)}</a> contributors, CC BY-SA 3.0</p>` : '';
  $('#pd-body').innerHTML = `
    <div><div class="modal-media">${productImage(p, 260)}</div>${credit}</div>
    <div>
      <p class="price">${money(p.price)} <span class="price-note">MRP ${money(p.mrp)}, incl. of all taxes</span></p>
      <dl class="spec">
        ${row('Brand', p.brand)}
        ${row('Brand owner', p.brandOwner)}
        ${row('Net quantity', p.netQuantity)}
        ${row('Country of origin', p.countryOfOrigin)}
        ${row('Manufacturer or packer', p.packer)}
        ${row('Availability', p.available > 0 ? 'In stock' : 'Out of stock')}
      </dl>
      <p class="small muted">Check the pack for the best-before date, ingredients and allergens when your order arrives.</p>
    </div>`;
  pdDialog.showModal();
  pdDialog.addEventListener('close', () => opener.focus(), { once: true });
}

// ---------- cart drawer ----------
function cartTotals() {
  let subtotal = 0; const problems = [];
  const lines = cart.items().map((i) => {
    const p = products.get(i.id);
    if (!p) { problems.push(i.id); return { ...i, missing: true }; }
    if (p.available < i.qty) problems.push(i.id);
    subtotal += p.price * i.qty;
    return { ...i, p };
  });
  const deliveryFee = subtotal === 0 || subtotal >= config.fees.freeDeliveryFrom ? 0 : config.fees.deliveryFee;
  return { lines, subtotal, deliveryFee, total: subtotal + deliveryFee, problems };
}
function renderCart() {
  if (!config) return;
  const t = cartTotals();
  $('#cart-empty').hidden = t.lines.length > 0;
  $('#cart-lines').innerHTML = t.lines.map((l) => {
    if (l.missing) return `<li class="cart-line" data-id="${esc(l.id)}"><span></span><div><h3>Item no longer sold</h3></div><button type="button" class="link-button" data-remove>Remove</button></li>`;
    const p = l.p;
    const warn = p.available === 0 ? 'Out of stock right now. Remove it to check out.' : p.available < l.qty ? `Only ${p.available} available. Lower the quantity to check out.` : '';
    return `<li class="cart-line" data-id="${esc(p.id)}">
      ${productImage(p, 56)}
      <div><h3>${esc(p.name)}</h3><span class="meta">${esc(p.netQuantity)}, ${money(p.price)} each</span></div>
      <span class="line-total">${money(p.price * l.qty)}</span>
      <div class="line-actions">
        <div class="stepper" role="group" aria-label="${esc(productName(p))} quantity">
          <button type="button" data-step="-1" aria-label="Remove one ${esc(productName(p))}">${icon('minus')}</button>
          <output>${l.qty}</output>
          <button type="button" data-step="1" aria-label="Add one more ${esc(productName(p))}" ${l.qty >= maxFor(p) ? 'disabled' : ''}>${icon('plus')}</button>
        </div>
        <button type="button" class="link-button" data-remove aria-label="Remove ${esc(productName(p))} from cart">Remove</button>
      </div>
      ${warn ? `<p class="warn">${esc(warn)}</p>` : ''}
    </li>`;
  }).join('');
  $('#cart-summary').innerHTML = t.lines.length ? `
    <div><dt>Items</dt><dd>${money(t.subtotal)}</dd></div>
    <div><dt>Delivery fee</dt><dd>${t.deliveryFee === 0 ? 'Free' : money(t.deliveryFee)}</dd></div>
    <div class="total"><dt>Total to pay on delivery</dt><dd>${money(t.total)}</dd></div>` : '';
  $('#free-note').textContent = t.lines.length ? `Delivery is free when items total ${money(config.fees.freeDeliveryFrom)} or more. No other charges.` : '';
  const checkout = $('#to-checkout');
  const blocked = t.lines.length === 0 || t.problems.length > 0;
  checkout.setAttribute('aria-disabled', String(blocked));
  checkout.toggleAttribute('data-blocked', blocked);
  const n = cart.count();
  updateCartLink(n ? money(t.subtotal) : '');
  $('#cart-bar').hidden = n === 0;
  $('#cart-bar-count').textContent = `${n} ${n === 1 ? 'item' : 'items'}, ${money(t.total)}`;
}

$('#cart-lines').addEventListener('click', (e) => {
  const line = e.target.closest('[data-id]');
  if (!line) return;
  const id = line.dataset.id;
  if (e.target.closest('[data-remove]')) {
    cart.set(id, 0);
    status.textContent = 'Item removed from cart';
    renderCart(); refreshCard(id);
    (cartDialog.querySelector('[data-remove], [data-step]') || cartDialog.querySelector('[data-close]')).focus();
    return;
  }
  const step = e.target.closest('[data-step]');
  if (step) {
    const dir = Number(step.dataset.step);
    changeQty(id, dir);
    renderCart(); refreshCard(id);
    const again = cartDialog.querySelector(`[data-id="${CSS.escape(id)}"] [data-step="${dir}"]:not([disabled])`);
    (again || cartDialog.querySelector(`[data-id="${CSS.escape(id)}"] [data-step]`) || cartDialog.querySelector('[data-close]')).focus();
  }
});
$('#to-checkout').addEventListener('click', (e) => { if (e.currentTarget.hasAttribute('data-blocked')) e.preventDefault(); });

function openCart() { renderCart(); if (!cartDialog.open) cartDialog.showModal(); }
for (const link of $$('[data-cart-link], [data-cart-link-bar]')) link.addEventListener('click', (e) => { e.preventDefault(); openCart(); });
for (const d of [cartDialog, pdDialog]) d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
cart.onChange(renderCart);

// ---------- filters ----------
function renderCategories() {
  const tiles = [`<button type="button" class="tile" data-cat="all" aria-pressed="${activeCategory === 'all'}"><span class="tile-all">${icon('box')}</span>All products</button>`,
    ...config.categories.map((c) => `<button type="button" class="tile" data-cat="${esc(c.id)}" aria-pressed="${c.id === activeCategory}"><img src="${esc(c.image)}" alt="" width="64" height="64">${esc(c.name)}</button>`)];
  $('#categories').innerHTML = tiles.join('');
}
$('#categories').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  activeCategory = b.dataset.cat;
  for (const x of $$('[data-cat]', $('#categories'))) x.setAttribute('aria-pressed', String(x === b));
  renderGrid();
});
if (search) {
  search.value = query;
  search.addEventListener('input', () => { query = search.value; renderGrid(); });
  search.form.addEventListener('submit', (e) => { e.preventDefault(); query = search.value; renderGrid(); grid.querySelector('button')?.focus(); });
}

function renderStoreStatus() {
  $('#store-status').innerHTML = openStores > 0 ? '' :
    '<div class="notice notice-warn"><strong>No store is taking orders right now.</strong><p>Products show as out of stock until a store opens. You can still fill your cart.</p></div>';
  if (!config.isOpen) {
    $('#store-status').insertAdjacentHTML('beforeend', `<div class="notice notice-warn"><strong>Orders are closed right now.</strong><p>We take orders from ${esc(config.hours.open)} to ${esc(config.hours.close)}.</p></div>`);
  }
}

async function load() {
  const res = await api('/api/products');
  products = new Map(res.products.map((p) => [p.id, p]));
  openStores = res.openStores;
}

async function start() {
  try {
    config = await getConfig();
    await load();
  } catch (err) {
    grid.innerHTML = `<li class="notice notice-error"><strong>The shop could not load.</strong><p>${esc(err.message)}</p></li>`;
    return;
  }
  renderStoreStatus();
  renderCategories();
  renderGrid();
  renderCart();
  if (window.location.hash === '#cart') openCart();
  liveStream('/api/stream/stock', {
    stock({ id, available }) {
      const p = products.get(id);
      if (!p) { load().then(() => { renderGrid(); renderCart(); }).catch(() => {}); return; }
      p.available = available;
      const card = grid.querySelector(`[data-id="${CSS.escape(id)}"]`);
      const action = card?.contains(document.activeElement) ? document.activeElement.dataset.action : null;
      refreshCard(id, action);
      if (cartDialog.open || cart.qty(id)) renderCart();
    },
    stores({ open }) { openStores = open; renderStoreStatus(); }
  }, $('#live-state'));
}
start();
