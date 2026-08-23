# Updater channel — 1132 Fixer for Windows

`main` publishes to **this repository's GitHub Releases**. The binaries
already in the field poll a different feed — see
[Broker channel](#broker-channel--what-the-shipped-binaries-actually-poll).
Version truth is `package.json`. This document is the live channel record,
not a release.

## Current feed — what `main` publishes to

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

## Broker channel — what the shipped binaries actually poll

`build.publish` at tag **`v5.6.0`** — the commit the released binaries were
built from — is the **generic** provider
`https://botify-network.com/downloads/1132-fixer/updates`, not GitHub. The
GitHub publish target above exists only on `main`, which has not been
released. So every v5.6.0 install in the field polls the broker, and the
`download_count` on this repository's own `latest.yml` measures CI and
tooling, not field adoption.

| | |
| --- | --- |
| Broker feed | `https://botify-network.com/downloads/1132-fixer/updates/latest.yml` |
| Serves | `version: 5.6.0`, same installer SHA-512 and size as this repository's `latest.yml` |
| Allowlist | **rejected** by `isAllowedUpdaterUrl`, and `main.js` must never bake the URL in — both asserted by the smoke |

`tools/updater-channel-smoke.js` fetches the broker directly (outside the
app's allowlist, which is deliberate — the *app* must not poll it) and fails
if the broker is unreachable, or if its `version`, `sha512`, `path` or `size`
diverge from the channel `main` publishes to. Divergence would mean half the
population is offered a different build; an outage would silently break every
shipped install's updater. Nothing else in CI covers either condition.

## Residual old channel — deletion blocked

`PrimeUpYourLife/1132-Fixer-Windows-Releases` is **not** deleted. v5.5.1 and
earlier clients still poll its `latest.yml`.

Live counts on 2026-08-23, read from the REST release object:

| Channel | Latest tag | `latest.yml` downloads |
| --- | --- | --- |
| `1132-Fixer/windows` (current) | v5.6.0 | 478 |
| `PrimeUpYourLife/1132-Fixer-Windows-Releases` (old) | v5.5.1 | 2246 |

**Read these counts through the REST release object, never by GETting the
asset.** A `GET` of `latest.yml` increments its `download_count`; reading
`/repos/{owner}/{repo}/releases/latest` returns the same number and
increments nothing.

This test used to GET the old feed's `latest.yml` on every `npm test`, so
every CI run on every push and pull request added to that counter — measured
at +10 across a single working session in which no release occurred. The
old-channel count was therefore **not** a clean measure of field clients, and
the deletion gate that reads it ("no asset GET by any chip or CI in the
window") could never pass while that fetch existed. The fetch is gone; the
old channel is now read via REST metadata only. Counts recorded before that
change are contaminated by an unknown CI share and must not be treated as a
field-client baseline.

Some part of the old-channel count is genuine: only `<=5.5.1` builds have
that URL baked in, and there is no in-app path to move them if it 404s. They
reinstall once from https://github.com/1132-Fixer/windows/releases/latest (or
https://1132-fixer.xyz/). The size of that population is not derivable from
this counter.

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
