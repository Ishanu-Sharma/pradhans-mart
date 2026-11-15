import fs from 'node:fs';
import path from 'node:path';
import { escapeHtml, formatTime12 } from './util.js';

// access: who may open the page.
//   guest     only when signed out (signed-in people go to their home)
//   customer  / rider / store: that role only (others go to their home, signed-out people to /login)
//   admin     the admin page handles its own sign-in
//   public    anyone (legal pages, data rights, unsubscribe)
export const pages = {
  '/login': { view: 'login', title: 'Sign in', description: 'Sign in to order groceries from Indian brands in Guwahati, or to work as a delivery or store partner.', script: 'login', access: 'guest', bare: true },
  '/shop': { view: 'shop', title: 'Shop', description: 'Groceries, snacks, tea and household goods from Indian brands, with live stock.', script: 'shop', access: 'customer', bodyClass: 'page-shop' },
  '/checkout': { view: 'checkout', title: 'Checkout', description: 'Review every charge and place your order.', script: 'checkout', access: 'customer' },
  '/order': { view: 'order', title: 'Your order', description: 'Live status of your order.', script: 'order', access: 'customer' },
  '/account': { view: 'account', title: 'Your account', description: 'Your orders, saved address and account settings.', script: 'account', access: 'customer' },
  '/rider': { view: 'rider', title: 'Delivery partner', description: 'Delivery requests and active deliveries.', script: 'rider', access: 'rider', app: 'Delivery partner' },
  '/store': { view: 'store', title: 'Store partner', description: 'Order requests, packing and stock.', script: 'store', access: 'store', app: 'Store partner' },
  '/admin': { view: 'admin', title: 'Admin', description: 'Platform administration.', script: 'admin', access: 'admin', app: 'Admin' },
  '/privacy': { view: 'privacy', title: 'Privacy policy', description: 'What personal data Pradhan’s Mart collects, why, how long we keep it and how to use your rights.', access: 'public' },
  '/terms': { view: 'terms', title: 'Terms of service', description: 'The terms that apply when you use Pradhan’s Mart.', access: 'public' },
  '/refunds': { view: 'refunds', title: 'Cancellation and refund policy', description: 'How to cancel an order, refuse an item at the door or ask for a refund.', access: 'public' },
  '/cookies': { view: 'cookies', title: 'Cookie policy', description: 'Every cookie and browser storage item Pradhan’s Mart uses.', access: 'public' },
  '/contact': { view: 'contact', title: 'Contact and business details', description: 'Business details, customer support and the grievance officer.', access: 'public' },
  '/credits': { view: 'credits', title: 'Photo and font credits', description: 'Where the product photos and the typeface come from, and their licences.', access: 'public' },
  '/data-request': { view: 'data-request', title: 'Your data', description: 'Download or delete the personal data we hold about you.', script: 'data-request', access: 'public' },
  '/unsubscribe': { view: 'unsubscribe', title: 'Unsubscribe', description: 'Stop offer emails from Pradhan’s Mart.', script: 'unsubscribe', access: 'public' }
};

export const HOME = { customer: '/shop', rider: '/rider', store: '/store', admin: '/admin' };

const icon = (name, cls = 'icon') => `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="/assets/icons.svg#${name}"></use></svg>`;

export function createRenderer({ root, business, store, production, getBrands, getProducts, demo = false }) {
  const viewsDir = path.join(root, 'views');
  const cache = new Map();
  const readView = (name) => {
    if (production && cache.has(name)) return cache.get(name);
    const t = fs.readFileSync(path.join(viewsDir, `${name}.html`), 'utf8');
    cache.set(name, t);
    return t;
  };
  const UNSET = '<span class="unset">Not yet published</span>';
  const lookup = (obj, key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const allDay = () => store.hours.open === store.hours.close;

  function context() {
    const f = store.fees;
    return {
      biz: business, store, year: new Date().getFullYear(),
      deliveryFee: f.deliveryFee, freeDeliveryFrom: f.freeDeliveryFrom,
      openTime: formatTime12(store.hours.open), closeTime: formatTime12(store.hours.close),
      hoursText: allDay() ? '24 hours a day, every day' : `from ${formatTime12(store.hours.open)} to ${formatTime12(store.hours.close)}, every day`,
      copyrightName: demo ? business.brandName : (business.legalName || business.brandName),
      footerLine: demo ? 'A demo project. No orders are delivered and no payment is taken.' : `${business.brandName} delivers only within ${store.city}, Assam. Prices include GST.`,
      payShort: demo ? 'by cash' : 'by cash or UPI',
      payLong: demo ? 'in cash' : 'in cash or by UPI',
      radiusKm: store.serviceArea.radiusKm,
      reportWithinHours: store.refunds.reportWithinHours, refundWithinDays: store.refunds.refundWithinDays,
      addressDays: store.retention.addressDaysAfterCompletion,
      sessionHours: store.retention.staffSessionHours, customerSessionDays: store.retention.customerSessionDays,
      pincodeCount: store.serviceArea.pincodes.length,
      pincodeFirst: store.serviceArea.pincodes[0], pincodeLast: store.serviceArea.pincodes.at(-1)
    };
  }

  // {{key}} is escaped text; {{{key}}} is trusted HTML built here.
  function fill(tpl, ctx, raw) {
    return tpl
      .replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_, k) => raw[k] ?? '')
      .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
        const v = lookup(ctx, k);
        return v === undefined || v === null || String(v).trim() === '' ? UNSET : escapeHtml(v);
      });
  }

  function rawBlocks() {
    const products = getProducts();
    const pick = (ids) => ids.map((id) => products.find((p) => p.id === id)).filter(Boolean);
    const collage = pick(['amul-butter-100g', 'tata-tea-gold-500g', 'parle-g-250g', 'aashirvaad-atta-1kg', 'bingo-mad-angles-66g', 'himalaya-neem-150ml', 'good-day-cashew-200g', 'tata-salt-1kg', 'purabi-smart-milk-1l']);
    return {
      brandList: getBrands().map((b) => `<li>${escapeHtml(b)}</li>`).join(''),
      pincodeList: store.serviceArea.pincodes.map((p) => `<li>${p}</li>`).join(''),
      cinRow: business.cin ? `<div><dt>CIN</dt><dd>${escapeHtml(business.cin)}</dd></div>` : '',
      hoursNote: allDay() ? '' : ' Outside these hours you can still browse, but checkout is closed.',
      demoFooterNote: demo ? `<p>${escapeHtml(business.brandName)} is a demo project made for a presentation. It is not a registered business: orders are not delivered and no payment is taken.</p>` : '',
      bizHidden: demo ? ' hidden' : '',
      collage: collage.map((p) => `<li><img src="${p.image}" alt="" width="160" height="160" decoding="async"></li>`).join(''),
      creditRows: products.filter((p) => p.imageCredit).map((p) => `<tr><td><img src="${p.image}" alt="" width="48" height="48" loading="lazy"></td><td>${escapeHtml(p.name)}, ${escapeHtml(p.netQuantity)}</td><td><a href="${escapeHtml(p.imageCredit)}" rel="noopener">${escapeHtml(new URL(p.imageCredit).hostname)}</a></td></tr>`).join('')
    };
  }

  function layout(page, body, ctx, raw, urlPath, viewer) {
    const brand = escapeHtml(business.brandName);
    const title = `${escapeHtml(page.title)} | ${brand}`;
    const canonical = !demo && process.env.PUBLIC_URL ? `<link rel="canonical" href="${escapeHtml(new URL(urlPath, process.env.PUBLIC_URL).href)}">` : '';
    const script = `<script type="module" src="/assets/js/${page.script || 'common'}.js"></script>`;
    const banner = demo ? '<div class="demo-banner" role="note"><div class="wrap">Demo project for a presentation. Orders are not delivered and nothing is charged.</div></div>' : '';
    const robots = page.access !== 'public' || demo ? '<meta name="robots" content="noindex">' : '';
    let header = ''; let footer = ''; let main;
    if (page.bare) {
      main = body; // the view brings its own <main>
    } else {
      if (page.app) header = appHeader(brand, page, viewer);
      else if (viewer.role === 'customer') header = customerHeader(brand, urlPath, viewer);
      else header = publicHeader(brand, viewer);
      main = `<main id="main" tabindex="-1">\n${body}\n</main>`;
      if (!page.app) footer = fill(readView('_footer'), ctx, raw);
    }
    const cookieBanner = page.app ? '' : readView('_cookie-banner');
    return `<!doctype html>
<html lang="en-IN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${escapeHtml(page.description)}">
${robots}
${canonical}
<meta property="og:title" content="${title}">
<meta property="og:description" content="${escapeHtml(page.description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${brand}">
<meta name="theme-color" content="#2563EB">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="preload" href="/assets/fonts/figtree-latin-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/figtree-latin-700.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/css/site.css">
${script}
</head>
<body class="${page.bodyClass || ''}${page.app ? ' app-body' : ''}${page.bare ? ' bare-body' : ''}">
<a class="skip-link" href="#main">Skip to main content</a>
${banner}
${header}
${main}
${footer}
${cookieBanner}
</body>
</html>`;
  }

  function customerHeader(brand, urlPath, viewer) {
    const pin = viewer.pincode;
    return `<header class="site-header customer-header">
  <div class="wrap header-grid">
    <a class="brand" href="/shop" aria-label="${brand}, shop home">
      <svg class="brand-mark" aria-hidden="true" focusable="false" viewBox="0 0 32 32"><use href="/assets/icons.svg#mark"></use></svg>
      <span class="brand-name" aria-hidden="true">${brand}</span>
    </a>
    <a class="location-chip" href="/account#addr-title">
      ${icon('pin')}
      <span><span class="chip-label">Deliver to</span><strong>${pin ? `<span class="hide-sm">Guwahati </span>${escapeHtml(pin)}` : 'Add your address'}</strong></span>
    </a>
    <form class="header-search" action="/shop" method="get" role="search">
      <label class="visually-hidden" for="q">Search products</label>
      ${icon('search')}
      <input id="q" name="q" type="search" placeholder="Search atta, dal, tea and more" autocomplete="off">
    </form>
    <nav class="header-actions" aria-label="Account">
      <a class="header-link" href="/account"${urlPath === '/account' ? ' aria-current="page"' : ''}>${icon('user')}<span>Account</span></a>
      <a class="cart-button" href="/shop#cart" data-cart-link aria-label="Cart, 0 items">${icon('cart')}<span data-cart-summary>My cart</span></a>
    </nav>
  </div>
</header>`;
  }

  function publicHeader(brand, viewer) {
    const action = viewer.role
      ? `<a class="btn btn-secondary btn-small" href="${HOME[viewer.role]}">Back to ${viewer.role === 'customer' ? 'the shop' : 'your app'}</a>`
      : '<a class="btn btn-primary btn-small" href="/login">Sign in</a>';
    return `<header class="site-header">
  <div class="wrap header-bar">
    <a class="brand" href="/">
      <svg class="brand-mark" aria-hidden="true" focusable="false" viewBox="0 0 32 32"><use href="/assets/icons.svg#mark"></use></svg>
      <span class="brand-name">${brand}</span>
    </a>
    ${action}
  </div>
</header>`;
  }

  function appHeader(brand, page, viewer) {
    return `<header class="site-header app-header">
  <div class="wrap header-bar">
    <span class="brand">
      <svg class="brand-mark" aria-hidden="true" focusable="false" viewBox="0 0 32 32"><use href="/assets/icons.svg#mark"></use></svg>
      <span class="brand-name">${brand}<span class="app-label">${escapeHtml(page.app)}</span></span>
    </span>
    <span class="app-user" data-app-user>${viewer.name ? escapeHtml(viewer.name) : ''}</span>
    <button type="button" class="btn btn-secondary btn-small" data-logout${viewer.role ? '' : ' hidden'}>Sign out</button>
  </div>
</header>`;
  }

  return {
    render(urlPath, viewer = {}) {
      const page = pages[urlPath];
      if (!page) return null;
      const ctx = context();
      const raw = rawBlocks();
      return layout(page, fill(readView(page.view), ctx, raw), ctx, raw, urlPath, viewer);
    },
    renderNotFound(viewer = {}) {
      const ctx = context();
      const raw = rawBlocks();
      const page = { view: '404', title: 'Page not found', description: 'This page does not exist.', access: 'public' };
      return layout(page, fill(readView('404'), ctx, raw), ctx, raw, '/404', viewer);
    }
  };
}
