# Decision: resume of the Emoji and 1132 Fixer lane (2026-10-26)

Owner: Claude lane worker under Control. Policy: governance `CONTROL_POLICY.md` v1.4.0.
Source: Codex closeout `emoji-1132-closeout-handoff-20261026.json` and its supplements.

## Decisions

1. The Codex dirty state on `test/656-support-report-sanitizer` is preserved as commit
   `a594c01` with no change. Its diff is byte-identical to `fixer656-unpublished-stop.patch`
   (same SHA-256).
2. The Unicode username boundary regression runs as a `node:test` file,
   `tools/sanitizer-unicode-boundary.test.js`, beside the smoke script. The smoke script
   exports its harness and still runs as before when called directly.
3. The browser CODEOWNERS patch is already commit `eb04d12` on
   `fix/514-browser-codeowners-current-owner`. Nothing to apply. It stays local.
4. The Emoji auth patch targets PR156/157 code that is absent from
   `fix/admin-permissions-134`, so it does not apply there. The fence invariant is written
   as a fail-first test only, `tests/subscriptionAuthIdentityFence.test.mjs`. The fix needs
   the PR156 attempt tracking, which is more than 30 lines, so it is not implemented here.

## Serverless / Rich Messages / Cost audit

### Hosting

- Emoji Generator bot and Mini App run on Railway. The `emoji-generator-app` Nuxt service
  serves the frontend and the API from a Dockerfile build (`railway.json`). PostgreSQL and
  Redis are separate Railway services. Source: `docs/railway-topology.md`, 2026-10-22.
- Telegram Serverless (tgcloud) projects exist under `apps/telegram-serverless/` for the
  Original and Studio bots. They are prepared relays. Ingress is held. They are not the
  live host. Source: `docs/telegram-serverless-delivery.md`.
- Emoji support flow: the Mini App feedback endpoint (`server/api/feedback.post.ts`) runs on
  Railway and posts to Telegram over the Bot API. The support bot 8692359727 has no webhook
  set. Support intake stays on the Railway inbox.
- 1132 Fixer support flow: the Windows app builds a sanitized markdown report in the Electron
  main process and copies it to the clipboard. It sends nothing to Telegram or Railway. The
  `1132-Fixer/support-reporting` repository is not checked out under `C:\src`, so its runtime
  was not inspected in this lane. The closeout records it as Discord-based.

### Rich Messages

- This lane changed no outgoing Telegram message. The sanitizer, CODEOWNERS and fence work
  send nothing.
- Emoji server audit (read-only): bot router, admin broadcasts, lifecycle, publish jobs,
  rendered sets, expiry reminder, weekly message, promo channel and launch service all go
  through `sendRichMessage`.
- Exception found: `server/api/feedback.post.ts` sends support feedback with raw
  `sendMessage` and `sendPhoto`. It does not use Rich Messages. It is outside the patch
  scope of this lane and is recorded as a follow-up, not changed.

### Railway cost

- Current shape: one app replica, restart on failure with 5 retries, PostgreSQL, Redis and
  a PITR bucket. No measured per-service cost exists in the repository. Savings are UNKNOWN
  until measured.
- Reductions that apply, in order of evidence needed:
  1. Keep `numReplicas` at 1. Already true.
  2. Confirm whether any code reads the Redis service `emoji-generator-cache`. If no consumer
     exists, retire it after a readback. This is the only candidate that removes a billed
     service.
  3. Move update validation, small menus and Rich Message presentation to tgcloud only after
     parity and rollback proof. Media generation, secrets and the purchase ledger stay on
     Railway. This changes compute, not the service count.
- Rule: measure usage and cost before and after any change. Do not claim a saving without
  the Railway usage readback.

## Holds that remain

- Release signing for 1132 Fixer Windows.
- GitHub approval for browser commit `eb04d12` (no eligible independent reviewer found).
- Live acceptance for Emoji auth, payment and Mini App flows.
- No push, merge, release or deploy from this lane without Control approval.
