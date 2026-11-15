import { $, $$, api, cart, money, esc, icon, getConfig, liveStream } from './common.js';

const grid = $('#products');
const empty = $('#empty');
const status = $('#results-status');
const cartDialog = $('#cart');
const pdDialog = $('#product-dialog');

let config;
let products = new Map();
let activeCategory = 'all';
let query = '';

const productName = (p) => `${p.name}, ${p.netQuantity}`;

function priceBlock(p) {
  const note = p.price < p.mrp ? `MRP ${money(p.mrp)}, incl. GST` : 'MRP, incl. GST';
  return `<div><span class="price">${money(p.price)}</span><span class="price-note">${esc(note)}</span></div>`;
}

function controlHtml(p) {
  const q = cart.qty(p.id);
  if (p.stock <= 0 && q === 0) return '<span class="stock-out">Out of stock</span>';
  if (q === 0) {
    return `<button type="button" class="btn btn-secondary btn-small" data-action="add" aria-label="Add ${esc(productName(p))} to cart">Add</button>`;
  }
  const max = Math.min(p.stock, config.limits.maxQtyPerItem);
  return `<div class="stepper" role="group" aria-label="${esc(productName(p))} quantity">
    <button type="button" data-action="dec" aria-label="Remove one ${esc(productName(p))}">${icon('minus')}</button>
    <output aria-live="off">${q}</output>
    <button type="button" data-action="inc" aria-label="Add one more ${esc(productName(p))}" ${q >= max ? 'disabled' : ''}>${icon('plus')}</button>
  </div>`;
}

function cardHtml(p) {
  return `<li class="product" data-id="${esc(p.id)}">
    <div class="product-art" data-cat="${esc(p.category)}" aria-hidden="true">${icon(`cat-${p.category}`, '')}</div>
    <div class="product-body">
      <span class="product-brand">${esc(p.brand)}</span>
      <h2 class="product-name"><button type="button" data-action="details">${esc(p.name)}</button></h2>
      <span class="product-qty">${esc(p.netQuantity)}</span>
      <div class="product-foot">${priceBlock(p)}<div class="control">${controlHtml(p)}</div></div>
    </div>
  </li>`;
}

function visible() {
  const q = query.trim().toLowerCase();
  return [...products.values()].filter((p) =>
    (activeCategory === 'all' || p.category === activeCategory) &&
    (!q || p.name.toLowerCase().includes(q) || p.brand.toLowerCase().includes(q)));
}

function renderGrid() {
  const list = visible();
  grid.innerHTML = list.map(cardHtml).join('');
  empty.hidden = list.length > 0;
  status.textContent = `${list.length} ${list.length === 1 ? 'product' : 'products'} shown`;
}

function refreshCard(id, focusAction) {
  const card = grid.querySelector(`[data-id="${CSS.escape(id)}"]`);
  const p = products.get(id);
  if (!card || !p) return;
  card.querySelector('.product-foot').innerHTML = `${priceBlock(p)}<div class="control">${controlHtml(p)}</div>`;
  if (focusAction) {
    const target = card.querySelector(`[data-action="${focusAction}"]:not([disabled])`) || card.querySelector('[data-action="add"], [data-action="dec"]');
    target?.focus();
  }
}

function changeQty(id, delta) {
  const p = products.get(id);
  if (!p) return;
  const max = Math.min(p.stock, config.limits.maxQtyPerItem);
  const next = Math.max(0, Math.min(max, cart.qty(id) + delta));
  cart.set(id, next);
  status.textContent = next === 0 ? `${p.name} removed from cart` : `${p.name}: ${next} in cart`;
}

grid.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.closest('[data-id]').dataset.id;
  const a = btn.dataset.action;
  if (a === 'details') return openDetails(id, btn);
  if (a === 'add') { changeQty(id, 1); refreshCard(id, 'inc'); }
  if (a === 'inc') { changeQty(id, 1); refreshCard(id, 'inc'); }
  if (a === 'dec') { const before = cart.qty(id); changeQty(id, -1); refreshCard(id, before === 1 ? 'add' : 'dec'); }
});

// ---------- product details ----------
function openDetails(id, opener) {
  const p = products.get(id);
  if (!p) return;
  $('#pd-title').textContent = p.name;
  const row = (k, v) => (v ? `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>` : '');
  $('#pd-body').innerHTML = `
    <dl class="spec">
      ${row('Brand', p.brand)}
      ${row('Brand owner', p.brandOwner)}
      ${row('Net quantity', p.netQuantity)}
      ${row('MRP', `${money(p.mrp)} (incl. of all taxes)`)}
      ${row('Our price', money(p.price))}
      ${row('Country of origin', p.countryOfOrigin)}
      ${row('Manufacturer or packer', p.packer)}
      ${row('Availability', p.stock > 0 ? 'In stock' : 'Out of stock')}
    </dl>
    <p class="small muted">Check the pack for the best-before date, ingredients and allergens when your order arrives.</p>`;
  pdDialog.showModal();
  pdDialog.addEventListener('close', () => opener.focus(), { once: true });
}

// ---------- cart drawer ----------
function cartTotals() {
  let subtotal = 0; const problems = [];
  const lines = cart.items().map((i) => {
    const p = products.get(i.id);
    if (!p) { problems.push(i.id); return { ...i, missing: true }; }
    if (p.stock < i.qty) problems.push(i.id);
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
    if (l.missing) return `<li class="cart-line" data-id="${esc(l.id)}"><div><h3>Item no longer sold</h3></div><button type="button" class="btn btn-secondary btn-small" data-remove>Remove</button></li>`;
    const p = l.p;
    const max = Math.min(p.stock, config.limits.maxQtyPerItem);
    const warn = p.stock === 0 ? 'Out of stock. Remove it to check out.' : p.stock < l.qty ? `Only ${p.stock} in stock. Lower the quantity to check out.` : '';
    return `<li class="cart-line" data-id="${esc(p.id)}">
      <div><h3>${esc(p.name)}</h3><span class="meta">${esc(p.netQuantity)} &middot; ${money(p.price)} each</span></div>
      <span class="line-total">${money(p.price * l.qty)}</span>
      <div class="stepper" role="group" aria-label="${esc(productName(p))} quantity">
        <button type="button" data-step="-1" aria-label="Remove one ${esc(productName(p))}">${icon('minus')}</button>
        <output>${l.qty}</output>
        <button type="button" data-step="1" aria-label="Add one more ${esc(productName(p))}" ${l.qty >= max ? 'disabled' : ''}>${icon('plus')}</button>
      </div>
      <button type="button" class="link-button" data-remove aria-label="Remove ${esc(productName(p))} from cart">Remove</button>
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
}

$('#cart-lines').addEventListener('click', (e) => {
  const line = e.target.closest('[data-id]');
  if (!line) return;
  const id = line.dataset.id;
  if (e.target.closest('[data-remove]')) {
    cart.set(id, 0);
    status.textContent = 'Item removed from cart';
    renderCart();
    (cartDialog.querySelector('[data-remove], [data-step]') || cartDialog.querySelector('[data-close]')).focus();
    return;
  }
  const step = e.target.closest('[data-step]');
  if (step) {
    const dir = Number(step.dataset.step);
    changeQty(id, dir);
    renderCart();
    const again = cartDialog.querySelector(`[data-id="${CSS.escape(id)}"] [data-step="${dir}"]:not([disabled])`);
    (again || cartDialog.querySelector(`[data-id="${CSS.escape(id)}"] [data-step]`) || cartDialog.querySelector('[data-close]')).focus();
  }
});

$('#to-checkout').addEventListener('click', (e) => {
  if (e.currentTarget.hasAttribute('data-blocked')) e.preventDefault();
});

function openCart() { renderCart(); if (!cartDialog.open) cartDialog.showModal(); }
for (const link of $$('[data-cart-link]')) link.addEventListener('click', (e) => { e.preventDefault(); openCart(); });

for (const d of [cartDialog, pdDialog]) {
  d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
}

cart.onChange(() => { renderCart(); });

// ---------- filters ----------
function renderCategories() {
  const all = [{ id: 'all', name: 'All' }, ...config.categories];
  $('#categories').innerHTML = all.map((c) => `<button type="button" class="chip-button" data-cat="${esc(c.id)}" aria-pressed="${c.id === activeCategory}">${esc(c.name)}</button>`).join('');
}
$('#categories').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  activeCategory = b.dataset.cat;
  for (const x of $$('[data-cat]', $('#categories'))) x.setAttribute('aria-pressed', String(x === b));
  renderGrid();
});
$('#search').addEventListener('input', (e) => { query = e.target.value; renderGrid(); });

// ---------- start ----------
async function start() {
  try {
    const [c, list] = await Promise.all([getConfig(), api('/api/products')]);
    config = c;
    products = new Map(list.map((p) => [p.id, p]));
  } catch (err) {
    grid.innerHTML = `<li class="notice notice-error"><strong>The shop could not load.</strong><p>${esc(err.message)}</p></li>`;
    return;
  }
  if (!config.isOpen) {
    $('#store-status').innerHTML = `<div class="notice notice-warn"><strong>We are closed right now.</strong><p>We take orders from ${esc(config.hours.open)} to ${esc(config.hours.close)}. You can still fill your cart.</p></div>`;
  }
  renderCategories();
  renderGrid();
  renderCart();
  if (location.hash === '#cart') openCart();

  liveStream('/api/stream/stock', {
    stock(update) {
      const p = products.get(update.id);
      if (!update.active) { products.delete(update.id); renderGrid(); renderCart(); return; }
      if (!p) { api('/api/products').then((list) => { products = new Map(list.map((x) => [x.id, x])); renderGrid(); renderCart(); }).catch(() => {}); return; }
      Object.assign(p, { stock: update.stock, price: update.price, mrp: update.mrp });
      const hadFocus = grid.querySelector(`[data-id="${CSS.escape(update.id)}"]`)?.contains(document.activeElement);
      refreshCard(update.id, hadFocus ? document.activeElement?.dataset.action : null);
      if (cartDialog.open || cart.qty(update.id)) renderCart();
    }
  }, $('#live-state'));
}
start();
