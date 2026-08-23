# 1132 Fixer — feedback proxy

Holds the GitHub issues token **server-side** so the desktop app never ships a
credential.

## Why

The app used to embed a GitHub PAT and call the API directly. That can't be made
safe. Anything bundled into an Electron app lands in `app.asar` inside the
installer, and asar stores file contents **uncompressed** — so the token was
recoverable from the public download in about a minute:

```bash
7za x 1132-Fixer-Portable-5.3.10.exe -oext
grep -a "GH_ISSUES_TOKEN" ext/resources/app.asar
# -> GH_ISSUES_TOKEN: 'github_pat_11A674FI...'
```

Injecting the token at build time rather than committing it did **not** fix
this — it only kept the secret out of git. It still shipped in every build.

The token now lives here. The app posts plain JSON to a **public url**. A url is
not a credential, so it's safe to hardcode and safe to extract. There is nothing
in the client worth stealing.

## What this does and doesn't buy

The endpoint is public and unauthenticated — deliberately. Any shared key we
shipped in the app would be exactly as extractable as the token was, so it would
be security theatre. An attacker can therefore still spam issues, which is the
same worst case as the leaked token. What actually changes:

- **The token can't be obtained**, so it can't be reused elsewhere, and its blast
  radius can't grow beyond "open an issue on one repo".
- **Abuse is throttled here** — 5 requests/hour/IP, 8 KB body cap, 4000-char text
  cap, strict field validation.
- **You can disable or patch instantly** by redeploying — no client update, no
  token rotation, no waiting for users to upgrade.
- **The client can't forge issues** — the proxy builds the title, body, and
  labels; the client may only pick from a fixed set of types.

If you ever need real authentication, do it with something the client can prove
without holding a secret (e.g. per-install tokens issued server-side), not a
shared key baked into the binary.

## Deploy (Railway)

```bash
cd feedback-proxy
railway init
railway variables set GH_ISSUES_TOKEN=github_pat_...        # the ONLY place this lives
railway variables set GH_ISSUES_REPO=1132-Fixer/windows
railway up
railway domain            # -> https://<something>.up.railway.app
```

Then point the app at it. The url is **not** a secret — use a repo *variable*,
not a secret:

```bash
gh variable set FEEDBACK_PROXY_URL \
  --repo 1132-Fixer/windows \
  --body "https://<something>.up.railway.app"
```

`release.yml` reads `${{ vars.FEEDBACK_PROXY_URL }}` and `inject-config.js` bakes
it in. Builds without it still succeed — feedback just reports
"not configured".

## Verify

```bash
curl https://<host>/health
# {"ok":true,"service":"1132-fixer-feedback-proxy","configured":true}

curl -X POST https://<host>/feedback \
  -H 'Content-Type: application/json' \
  -d '{"type":"Feedback","text":"hello from curl","version":"5.3.11","os":"Windows 10.0.26200"}'
# {"ok":true,"number":123}
```

`configured:false` means `GH_ISSUES_TOKEN` isn't set — the service will 503 on
`/feedback` rather than fail silently.

## API

| Route | Method | Notes |
|---|---|---|
| `/health` | GET | Liveness + whether a token is configured. Never reveals the token. |
| `/feedback` | POST | `{type, text, version, os}` → creates an issue. |

`type` must be one of: `Bug Report`, `Feature Request`, `User Rating`,
`Feedback`.

| Status | Meaning |
|---|---|
| 201 | Issue created, returns `{ok:true, number}` |
| 400 | `bad_json` / `bad_type` / `empty_text` |
| 413 | Body over 8 KB |
| 429 | Rate limited (5/hour/IP) |
| 502 | GitHub rejected it (detail is logged server-side, never returned) |
| 503 | `GH_ISSUES_TOKEN` not set |

## Test

```bash
npm test
```

Runs the real server against a stubbed GitHub with a fake token — no network, no
credential needed. Asserts the token never appears in any client response and
that clients can't choose their own labels.

## Rules

- **Never** put the token in the desktop app, `src/main/`, or git.
- `inject-config.js` hard-fails if `FEEDBACK_PROXY_URL` looks like a token.
- Rotate by changing the env var here and redeploying. The client never changes.
