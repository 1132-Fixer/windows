# Support contract

The report that this app sends to the support service is defined in one place:
the `contract/` folder of
[1132-Fixer/support-reporting](https://github.com/1132-Fixer/support-reporting)
(a private repository). Every 1132 Fixer product sends the same shape. This
app does not define the shape; it keeps an exact copy.

## What is in this repository

| Path | Purpose |
| --- | --- |
| `src/main/support-contract/feedback.v1.schema.json` | Exact copy of the JSON Schema of the request body. |
| `src/main/support-contract/validate.js` | Exact copy of the schema checker. It has no dependencies. |
| `src/main/support-contract/pin.json` | Source repository, source commit, contract version, and the SHA-256 fingerprint of each copied file (computed with LF line ends). |
| `src/main/support-contract/index.js` | Loads the three files for the app. This file belongs to this repository. |

Never edit the two copied files here.

## How the app uses it

- `src/main/support-client.js` builds the request. It always sends
  `product: "windows"`.
- Before a request leaves the computer, the client checks it against the
  schema. A request that the contract does not accept is not sent.
- Diagnostics (the Support Report) are sent only when the person selects
  **Include Support Report** in the Bug Report form for that one report. The
  form passes that choice through `submit-feedback`; a new form never inherits
  it, and a second press withdraws it. The report is not merged into the
  message text. The client then sends
  `diagnostics: { format: "markdown", text }` together with
  `consent: { diagnostics: true }`. The service refuses diagnostics that come
  without that statement.

## What keeps the two repositories in sync

1. `tools/support-contract-smoke.js` (part of `npm test` and of the
   **Support Service** check) fails when a copied file differs from its
   fingerprint in `pin.json`, and when any request that the client can build
   does not pass the schema.
2. The support service reports `contract: { version, schemaSha256 }` at
   `GET /health`. At release time, `scripts/verify-support-endpoint.mjs`
   refuses a service whose version or fingerprint differs from `pin.json`.

## How to update the copy

1. Merge the contract change in `1132-Fixer/support-reporting` first.
2. Copy `contract/feedback.v1.schema.json` and `contract/validate.js` from
   that commit, without changes.
3. Update `pin.json`: the commit, and the fingerprint of each file. The
   schema fingerprint is the value that the service prints with
   `node -e "console.log(require('./contract').sha256)"`.
4. Run `node tools/support-contract-smoke.js`. Change the client until every
   request passes.
