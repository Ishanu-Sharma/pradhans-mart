// Shared by the browser and the server, so both apply exactly the same rules.

export function normalisePhone(value) {
  let s = String(value ?? '').replace(/[\s-]/g, '');
  if (s.startsWith('+91')) s = s.slice(3);
  else if (s.length === 12 && s.startsWith('91')) s = s.slice(2);
  else if (s.length === 11 && s.startsWith('0')) s = s.slice(1);
  return s;
}

const text = (v) => String(v ?? '').trim();

export const rules = {
  name(v) {
    const s = text(v);
    if (!s) return 'Enter your name.';
    if (s.length < 2 || s.length > 60) return 'Use 2 to 60 characters.';
    if (!/^[\p{L}\p{M} .'’-]+$/u.test(s)) return 'Use letters, spaces, dots, hyphens or apostrophes only.';
    return '';
  },
  phone(v) {
    const s = normalisePhone(v);
    if (!s) return 'Enter your mobile number.';
    if (!/^[6-9]\d{9}$/.test(s)) return 'Enter a 10-digit Indian mobile number that starts with 6, 7, 8 or 9.';
    return '';
  },
  house(v) {
    const s = text(v);
    if (!s) return 'Enter your house, flat or building.';
    if (s.length > 80) return 'Keep this under 80 characters.';
    return '';
  },
  street(v) {
    const s = text(v);
    if (!s) return 'Enter your street and locality.';
    if (s.length < 3) return 'Enter at least 3 characters.';
    if (s.length > 120) return 'Keep this under 120 characters.';
    return '';
  },
  landmark(v) {
    return text(v).length > 80 ? 'Keep this under 80 characters.' : '';
  },
  pincode(v, allowed) {
    const s = text(v);
    if (!s) return 'Enter your pincode.';
    if (!/^\d{6}$/.test(s)) return 'A pincode has 6 digits.';
    if (allowed && !allowed.includes(s)) return 'We do not deliver to this pincode. We deliver only within Guwahati.';
    return '';
  },
  email(v) {
    const s = text(v);
    if (!s) return 'Enter your email address.';
    if (s.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return 'Enter an email address like name@domain.in.';
    return '';
  },
  orderId(v) {
    const s = text(v).toUpperCase();
    if (!s) return 'Enter your order ID.';
    if (!/^PM[A-Z0-9]{8}$/.test(s)) return 'An order ID starts with PM and has 10 characters, like PM7K2QX9RD.';
    return '';
  }
};

export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function isValidCoord(p) {
  return p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
}

export function inServiceRadius(point, serviceArea) {
  return isValidCoord(point) && haversineKm(point, serviceArea.center) <= serviceArea.radiusKm;
}
