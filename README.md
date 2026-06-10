# CyberSource Unified Checkout — Test Harness

A minimal Node.js/Express app for testing the CyberSource Unified Checkout payment flow end-to-end: capture context generation, card entry, authorization, and transaction retrieval.

## What it does

1. **Browser** — user enters an amount and clicks Launch Checkout
2. **`POST /api/session`** — server generates a signed capture context JWT via `POST /up/v1/capture-contexts` using the `cybersource-rest-client` SDK
3. **Browser** — dynamically loads `SecureAcceptance.js` from the `clientLibrary` URL embedded in the JWT, then calls `Accept(jwt)` → `unifiedPayments(sidebar)` → `show()` → `complete()` to render the card-entry iframes and collect payment
4. **Browser** — on completion, POSTs the final response token to the server
5. **`POST /api/pay`** — server submits the token to `POST /pts/v2/payments`, authorizing and capturing the payment
6. **`GET /api/transaction/:id`** — retrieve full transaction details including `merchantDefinedInformation`. The `:id` can be found in the browser console payment response.

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

## Client library

The capture context JWT returned by `POST /up/v1/capture-contexts` embeds a `clientLibrary` URL pointing to `SecureAcceptance.js` — CyberSource's 0.x Unified Checkout SDK. The browser loads this script dynamically (with SRI integrity check) rather than from a static script tag, ensuring the library version always matches the JWT.

`clientVersion` in `server.js` controls which JWT format is returned. This app uses `0.26`, which is the version used by the [official CyberSource sample](https://github.com/CyberSource/cybersource-unified-checkout-sample-node).

### Method chain

```javascript
const client   = await Accept(sessionJWT);           // verify JWT, return client
const payments = await client.unifiedPayments(true); // true = sidebar layout
const token    = await payments.show({               // render iframes, collect card
  containers: { paymentSelection: '#payment-buttons' }
});
const response = await payments.complete(token);     // finalise, return response JWT
```

`show()` resolves when the customer completes card entry and returns a transient token. `complete()` takes that token, finalises the session, and returns the response JWT that is submitted to `POST /pts/v2/payments`. The `sidebar` boolean passed to `unifiedPayments()` controls whether the card-entry form opens inline (`false`) or in a sidebar panel (`true`).

### VAS 1.0.0 (`VAS.UnifiedCheckout`)

CyberSource's documentation references a `VAS.UnifiedCheckout` API served from `UnifiedCheckout.js`. This uses a different method chain (`.createCheckout()` → `.mount()`) and a different JWT format that includes an `iframes.orc` orchestrator key. The official CyberSource sample app does **not** use this API — it uses the same `Accept` flow described above. Both API versions are present in `index.html`, one active and one commented out, to make switching straightforward if a compatible `clientVersion` becomes available.

| | 0.x / `Accept` (current) | VAS 1.0.0 |
|---|---|---|
| Script tag | dynamic, loaded from JWT `clientLibrary` | static `<script src=".../UnifiedCheckout.js">` |
| Entry point | `Accept(jwt)` | `VAS.UnifiedCheckout(jwt)` |
| Method chain | `unifiedPayments(sidebar)` → `show()` → `complete()` | `createCheckout()` → `mount('#selector')` |
| `clientLibrary` args | required | not needed |

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
