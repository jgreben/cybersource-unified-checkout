# CyberSource Unified Checkout — Test Harness

A minimal Node.js/Express app for testing the CyberSource Unified Checkout payment flow end-to-end: capture context generation, card entry, authorization, and transaction retrieval.

## What it does

1. **Browser** — user enters an amount and clicks Launch Checkout
2. **`POST /api/session`** — server generates a signed capture context JWT via `POST /up/v1/capture-contexts` using the `cybersource-rest-client` SDK
3. **Browser** — dynamically loads `SecureAcceptance.js` from the URL embedded in the JWT, calls `Accept(jwt)` → `unifiedPayments()` → `show()` to render the card-entry iframes
4. **Browser** — on completion, receives a transient token JWT and POSTs it to the server
5. **`POST /api/pay`** — server submits the transient token to `POST /pts/v2/payments`, authorizing and capturing the payment
6. **`GET /api/transaction/:id`** — retrieve full transaction details including `merchantDefinedInformation`. The :`id` can be found in the browser console payment response.

## Setup

```bash 
cp .env.example .env   # fill in MERCHANT_ID, KEY_ID, SHARED_SECRET
npm install
```

Credentials come from [Business Center (test)](https://businesscentertest.cybersource.com/ebc2) under Payment Configuration → Key Management → Generate Key (REST - Shared Secret).

CyberSource requires an HTTPS origin in `targetOrigins`. Two options for local development:

**Option A — ngrok** (simpler, no setup):
```bash
npx ngrok http 3000
# paste the https://xxxx.ngrok-free.app URL into .env as ORIGIN_URL
npm start
```
Drawback: the ngrok URL changes every restart (unless you have a paid static domain), so you must update `ORIGIN_URL` and restart the server each session.

**Option B — self-signed certificate** (no external dependency, stable URL):
```bash
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes \
  -subj "/CN=localhost"
```
Then set `ORIGIN_URL=https://localhost:3000` in `.env`. The browser will show a certificate warning on first visit — click through it (the cert is valid for CyberSource's purposes). Add `key.pem` and `cert.pem` to `.gitignore`. This approach matches what the official CyberSource sample app does.

```bash
npm start
```

Test card: `4111 1111 1111 1111`, any future expiry, any CVV.

## API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/session` | Generate capture context JWT |
| `POST` | `/api/pay` | Authorize & capture via transient token |
| `GET`  | `/api/transaction/:id` | Retrieve full transaction record |

## How this differs from the VAS 1.0.0 flow

CyberSource has two generations of the Unified Checkout JavaScript SDK:

| | This app (0.x) | VAS 1.0.0 |
|---|---|---|
| Capture context endpoint | `POST /up/v1/capture-contexts` | Same |
| `clientVersion` | `0.10`–`0.20` | Requires `iframes.orc` in JWT (not produced by 0.x) |
| Client library | `SecureAcceptance.js` (embedded in JWT) | `UnifiedCheckout.js` (static script tag) |
| Entry point | `Accept(jwt)` | `VAS.UnifiedCheckout(jwt)` |
| Method chain | `.unifiedPayments()` → `.show({containers})` | `.createCheckout()` → `.mount('#selector')` |
| Assets host | `testup.cybersource.com` | `apitest.cybersource.com` |

The 1.0.0 library (`VAS.UnifiedCheckout`) expects a key called `iframes.orc` (an orchestrator iframe) in the capture context JWT. No 0.x `clientVersion` produces this key, making the two generations incompatible. The 0.x generation works end-to-end and is what this app uses.

### Switching between flows

Three places in `public/index.html` must be toggled together:

| | 0.x flow (default) | VAS 1.0.0 flow |
|---|---|---|
| Script tag | `loadScript` helper block (dynamic, from JWT) | `<script src=".../UnifiedCheckout.js">` (static) |
| `launchCheckout` | `Accept` → `unifiedPayments()` → `show()` | `VAS.UnifiedCheckout` → `createCheckout()` → `mount()` |
| `startCheckout` call | passes `clientLibrary`, `clientLibraryIntegrity` | no `clientLibrary` args |

Both versions are present in `index.html` — one active, one commented out. `server.js` also has a comment on `clientVersion` noting what value would be needed for the VAS flow.

## Appearance customization

The card-entry form and payment buttons are rendered inside **cross-origin iframes** served from `testup.cybersource.com`. Browser security (same-origin policy) prevents any CSS in your page from reaching inside them — selectors, `!important`, and shadow DOM tricks all fail at the iframe boundary.

What you can style locally:
- The `#payment-buttons` container div (size, margin, background)
- The outer iframe box once injected (width, height, border) — not its content

What you cannot style locally:
- Button color, font, border-radius, or any content inside the iframes

Business Center appearance customizations (branding, button color) are only applied in the VAS 1.0.0 flow via an `appearance` object in the capture context. The 0.x `GenerateUnifiedCheckoutCaptureContextRequest` model does not expose an `appearance` field, so Business Center profiles have no effect in this integration.

## merchantDefinedInformation

Keys must be integers `1`–`100` passed as strings. Arbitrary string keys (e.g. `"feeFineId1"`) are silently dropped by the API. Each key maps to one string value (up to 255 chars). To associate multiple UUIDs with a logical field, either use consecutive keys or comma-separate values within a single key.

`merchantDefinedInformation` is not echoed in the authorization response — use `GET /api/transaction/:id` to confirm the values were stored.
