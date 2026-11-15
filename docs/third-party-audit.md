# Third-party SDK and asset audit

Audited 15 November 2026, updated the same day for photos and the typeface.

## Result: no third-party code; licensed third-party photos and font, self-hosted

| Area | Finding |
|---|---|
| npm dependencies | One, on the server only: `mongodb` 6.10.0, the official MongoDB driver, pinned to an exact version. Nothing is sent to browsers. |
| Browser scripts | Only files in `public/assets/js`, all written for this project. |
| Analytics, ads, pixels, tag managers | None. |
| Maps and geocoding | None. Area checks use our own pincode list and distance maths. Rider distance is computed on the customer's device. |
| Fonts | Figtree (SIL Open Font License 1.1), self-hosted from `public/assets/fonts` with its licence file. No font service is contacted. |
| Images | Product photos from Open Food Facts, Open Beauty Facts and Open Products Facts contributors (CC BY-SA 3.0), resized and self-hosted in `public/assets/products`, credited per product on `/credits`. The logo, favicon and icons are drawn in this project. |
| Payments | None online. Cash or UPI is paid to the rider. |
| Database | MongoDB Atlas when `MONGODB_URI` is set (named in the privacy policy). Otherwise a local JSON file. |
| SMS | None. Password reset codes are shown on screen in demo mode only. |
| Email | No provider connected yet. See the README. |

## How it is enforced

The server sends a Content-Security-Policy with `default-src 'self'`, so browsers block any script, style, font, image or connection to another origin. `tests/api.test.js` fails if any page references an external resource.

## When you add a third party

Before adding any SDK, record here what data it receives, where it is processed, its retention and its licence, and update the privacy policy (section 4 and 5) and the cookie policy. Add its origin to the CSP only after that.
