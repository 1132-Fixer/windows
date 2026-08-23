# Updater channel — 1132 Fixer for Windows

Current builds update from **this repository's GitHub Releases**. Version
truth is `package.json`. This document is the live channel record, not a
release.

## Current feed

| | |
| --- | --- |
| Source of version truth | `package.json` `version` (today: `5.6.0`) |
| Publish target | `build.publish` → GitHub `1132-Fixer` / `windows` |
| Feed URL | `https://github.com/1132-Fixer/windows/releases/latest/download/latest.yml` |
| Integrity | SHA-512 of the Setup installer, inside `latest.yml` |
| Transport | HTTPS only. First hop and every redirect must pass `isAllowedUpdaterUrl` (#156) |
| Renderer steering | none — `autoUpdater.setFeedURL` is never called |
| Code-signature check | `verifyUpdateCodeSignature` stays **false** while artifacts are unsigned |

NSIS installs use `electron-updater` against `build.publish`. Portable builds
cannot self-update; they fetch the same `latest.yml` and show a download
banner.

Proof: `tools/updater-channel-smoke.js` (wired into `npm test`) fetches the
live feed through the allowlist, then asserts `latest.yml` `version` equals
`package.json`.

Do not random-bump `package.json`. A bump without a matching published
`latest.yml` fails that test. Do not publish a GitHub Release from a
docs/test change.

## Residual old channel — deletion blocked

`PrimeUpYourLife/1132-Fixer-Windows-Releases` is **not** deleted. v5.5.1 and
earlier clients still poll its `latest.yml`.

Live counts on 2026-08-23:

| Channel | Latest tag | `latest.yml` downloads |
| --- | --- | --- |
| `1132-Fixer/windows` (current) | v5.6.0 | 440 |
| `PrimeUpYourLife/1132-Fixer-Windows-Releases` (old) | v5.5.1 | 2216 |

Census the same day recorded 2212 old-channel downloads; the count is still
rising. Those polls are field clients. There is no in-app path to move them
if that URL 404s. They install once from
https://github.com/1132-Fixer/windows/releases/latest (or
https://1132-fixer.xyz/).

`isAllowedUpdaterUrl` **rejects** the old GitHub path, the generic
`botify-network.com/downloads/1132-fixer` broker, `http:`, other repos, and
arbitrary hosts. Residual clients keep working only because their *already
installed* binary has the old URL baked in.

Do not delete `PrimeUpYourLife/1132-Fixer-Windows-Releases`.

## Related

- [`release-process.md`](release-process.md) — how a `v*` tag publishes `latest.yml`
- [`../security/electron-trust.md`](../security/electron-trust.md) — URL allowlist
- [`../security/code-signing.md`](../security/code-signing.md) — unsigned policy / updater trap
- [`../RELEASE-MIGRATION-2026-08.md`](../RELEASE-MIGRATION-2026-08.md) — old-channel history
