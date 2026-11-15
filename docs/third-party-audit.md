# Third-party SDK and asset audit

Audited 15 November 2026.

## Result: no third-party code or assets

| Area | Finding |
|---|---|
| npm dependencies | None. `package.json` has no `dependencies` or `devDependencies`. The server uses only Node.js built-ins. |
| Browser scripts | Only files in `public/assets/js`, all written for this project. |
| Analytics, ads, pixels, tag managers | None. |
| Maps and geocoding | None. Area checks use our own pincode list and distance maths. Rider distance is computed on the customer's device. |
| Fonts | None shipped. The system font stack uses fonts already installed on the visitor's device, so no font licence is needed. |
| Images | No photographs. The logo, favicon, app icons and line icons are drawn in this project (`public/assets/icons.svg`, `scripts/make-icons.js`). |
| Payments | None online. Cash or UPI is paid to the rider. |
| Email | No provider connected yet. See the README. |

## How it is enforced

The server sends a Content-Security-Policy with `default-src 'self'`, so browsers block any script, style, font, image or connection to another origin. `tests/api.test.js` fails if any page references an external resource.

## When you add a third party

Before adding any SDK, record here what data it receives, where it is processed, its retention and its licence, and update the privacy policy (section 4 and 5) and the cookie policy. Add its origin to the CSP only after that.
