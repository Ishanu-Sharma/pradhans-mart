import fs from 'node:fs';
import path from 'node:path';
import { escapeHtml, formatTime12 } from './util.js';

export const pages = {
  '/': { view: 'home', title: 'Grocery delivery in Guwahati', description: 'Order groceries and household goods from Indian brands for delivery in Guwahati. Pay by cash or UPI on delivery.', script: 'home', bodyClass: 'page-home' },
  '/shop': { view: 'shop', title: 'Shop', description: 'Browse groceries, snacks, tea and household goods from Indian brands, with prices and stock shown live.', script: 'shop' },
  '/checkout': { view: 'checkout', title: 'Checkout', description: 'Enter your delivery address, review every charge and place your order.', script: 'checkout', noindex: true },
  '/order': { view: 'order', title: 'Track your order', description: 'Follow your order status and rider location live.', script: 'order', noindex: true },
  '/data-request': { view: 'data-request', title: 'Your data', description: 'Download or delete the personal data we hold about you.', script: 'data-request' },
  '/unsubscribe': { view: 'unsubscribe', title: 'Unsubscribe', description: 'Stop offer emails from Pradhan’s Mart.', script: 'unsubscribe', noindex: true },
  '/privacy': { view: 'privacy', title: 'Privacy policy', description: 'What personal data Pradhan’s Mart collects, why, how long we keep it and how to use your rights.' },
  '/terms': { view: 'terms', title: 'Terms of service', description: 'The terms that apply when you order from Pradhan’s Mart.' },
  '/refunds': { view: 'refunds', title: 'Cancellation and refund policy', description: 'How to cancel an order, refuse an item at the door or ask for a refund.' },
  '/cookies': { view: 'cookies', title: 'Cookie policy', description: 'Every cookie and browser storage item Pradhan’s Mart uses, and how to change your choice.' },
  '/contact': { view: 'contact', title: 'Contact and business details', description: 'Business details, customer support and the grievance officer for Pradhan’s Mart.' },
  '/login': { view: 'login', title: 'Sign in', description: 'Sign in as a customer, store admin or rider.', script: 'login', noindex: true },
  '/account': { view: 'account', title: 'Your account', description: 'Your orders, saved address and account settings.', script: 'account', noindex: true },
  '/admin': { view: 'admin', title: 'Store dashboard', description: 'Staff dashboard.', script: 'admin', noindex: true, staff: true },
  '/rider': { view: 'rider', title: 'Rider app', description: 'Rider deliveries.', script: 'rider', noindex: true, staff: true }
};

const UNSET = '<span class="unset">Not yet published</span>';

export function createRenderer({ root, business, store, production, getBrands, demo = false }) {
  const viewsDir = path.join(root, 'views');
  const cache = new Map();
  const readView = (name) => {
    if (production && cache.has(name)) return cache.get(name);
    const t = fs.readFileSync(path.join(viewsDir, `${name}.html`), 'utf8');
    cache.set(name, t);
    return t;
  };

  const lookup = (obj, key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

  function context() {
    const f = store.fees;
    return {
      biz: business,
      store,
      year: new Date().getFullYear(),
      deliveryFee: f.deliveryFee,
      freeDeliveryFrom: f.freeDeliveryFrom,
      openTime: formatTime12(store.hours.open),
      closeTime: formatTime12(store.hours.close),
      hoursText: store.hours.open === store.hours.close ? '24 hours a day, every day' : `from ${formatTime12(store.hours.open)} to ${formatTime12(store.hours.close)}, every day`,
      copyrightName: demo ? business.brandName : (business.legalName || business.brandName),
      footerLine: demo ? 'A demo project. No orders are delivered and no payment is taken.' : `${business.brandName} delivers only within ${store.city}, Assam. Prices include GST.`,
      radiusKm: store.serviceArea.radiusKm,
      reportWithinHours: store.refunds.reportWithinHours,
      refundWithinDays: store.refunds.refundWithinDays,
      addressDays: store.retention.addressDaysAfterCompletion,
      sessionHours: store.retention.staffSessionHours,
      customerSessionDays: store.retention.customerSessionDays,
      pincodeCount: store.serviceArea.pincodes.length,
      pincodeFirst: store.serviceArea.pincodes[0],
      pincodeLast: store.serviceArea.pincodes.at(-1)
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
    const brands = getBrands();
    return {
      brandList: brands.map((b) => `<li>${escapeHtml(b)}</li>`).join(''),
      pincodeList: store.serviceArea.pincodes.map((p) => `<li>${p}</li>`).join(''),
      cinRow: business.cin ? `<div><dt>CIN</dt><dd>${escapeHtml(business.cin)}</dd></div>` : '',
      hoursNote: store.hours.open === store.hours.close ? '' : ' Outside these hours the shop stays open for browsing, but checkout is closed.',
      demoFooterNote: demo ? `<p>${escapeHtml(business.brandName)} is a demo project made for a presentation. It is not a registered business: orders are not delivered and no payment is taken.</p>` : '',
      bizHidden: demo ? ' hidden' : ''
    };
  }

  function layout(page, body, ctx, raw, urlPath, viewer = {}) {
    const brand = escapeHtml(business.brandName);
    const title = page.view === 'home' ? `${brand}: ${escapeHtml(page.title)}` : `${escapeHtml(page.title)} | ${brand}`;
    const canonical = !demo && process.env.PUBLIC_URL ? `<link rel="canonical" href="${escapeHtml(new URL(urlPath, process.env.PUBLIC_URL).href)}">` : '';
    const header = page.staff ? staffHeader(brand, page) : siteHeader(brand, urlPath, viewer);
    const footer = page.staff ? '' : fill(readView('_footer'), ctx, raw);
    const banner = page.staff ? '' : readView('_cookie-banner');
    const script = page.script
      ? `<script type="module" src="/assets/js/${page.script}.js"></script>`
      : '<script type="module" src="/assets/js/common.js"></script>';
    return `<!doctype html>
<html lang="en-IN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${escapeHtml(page.description)}">
${page.noindex || demo ? '<meta name="robots" content="noindex">' : ''}
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
<link rel="stylesheet" href="/assets/css/site.css">
${script}
</head>
<body class="${page.bodyClass || ''}">
<a class="skip-link" href="#main">Skip to main content</a>
${demo && !page.staff ? '<div class="demo-banner" role="note"><div class="wrap">Demo project for a presentation. Orders are not delivered and nothing is charged.</div></div>' : ''}
${header}
<main id="main" tabindex="-1">
${body}
</main>
${footer}
${banner}
</body>
</html>`;
  }

  function siteHeader(brand, urlPath, viewer = {}) {
    const link = (href, label) => `<li><a href="${href}"${urlPath === href ? ' aria-current="page"' : ''}>${label}</a></li>`;
    return `<header class="site-header">
  <div class="wrap header-bar">
    <a class="brand" href="/">
      <svg class="brand-mark" aria-hidden="true" focusable="false" viewBox="0 0 32 32"><use href="/assets/icons.svg#mark"></use></svg>
      <span class="brand-name">${brand}</span>
    </a>
    <nav aria-label="Main">
      <ul class="nav-list">
        ${link('/shop', 'Shop')}
        ${link('/order', 'Track order')}
        ${viewer.customer ? link('/account', 'Account') : link('/login', 'Sign in')}
      </ul>
    </nav>
    <a class="cart-link" href="/shop#cart" data-cart-link aria-label="Cart, 0 items">
      <svg class="icon" aria-hidden="true" focusable="false"><use href="/assets/icons.svg#cart"></use></svg>
      <span class="cart-count" data-cart-count aria-hidden="true">0</span>
    </a>
  </div>
</header>`;
  }

  function staffHeader(brand, page) {
    return `<header class="site-header staff-header">
  <div class="wrap header-bar">
    <span class="brand">
      <svg class="brand-mark" aria-hidden="true" focusable="false" viewBox="0 0 32 32"><use href="/assets/icons.svg#mark"></use></svg>
      <span class="brand-name">${brand} <span class="staff-label">${escapeHtml(page.title)}</span></span>
    </span>
    <button type="button" class="btn btn-secondary btn-small" data-logout hidden>Sign out</button>
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
    renderNotFound() {
      const ctx = context();
      const raw = rawBlocks();
      const page = { view: '404', title: 'Page not found', description: 'This page does not exist.', noindex: true };
      return layout(page, fill(readView('404'), ctx, raw), ctx, raw, '/404');
    }
  };
}
