# Release-home migration — August 2026

## Canonical home

Public source, CI, issues, and GitHub Releases for the Windows app:

**https://github.com/1132-Fixer/windows**

`build.publish` on `main` points the **next** build's updater feed here (HTTPS):
`https://github.com/1132-Fixer/windows/releases/latest/download/latest.yml`

**No shipped binary polls that feed.** It has no clients today. What each
generation of client actually polls is in [Updater](#updater) below.

`package.json` is the version source of truth. This repository is the
survivor. Do not delete it.

## Old download repo — deletion blocked

`PrimeUpYourLife/1132-Fixer-Windows-Releases` is a leftover public release
channel. It is not the product source. It is **still live** and **must not
be deleted**.

Live residual (2026-08-23, GitHub Releases API):

| Channel | Latest tag | `latest.yml` downloads |
| --- | --- | --- |
| `1132-Fixer/windows` (current) | v5.6.0 | 440 |
| `PrimeUpYourLife/1132-Fixer-Windows-Releases` (old) | v5.5.1 | 2216 |

Neither number is a clean field-client count. Until #161 the channel smoke
GETted the feeds on every `npm test`, so every CI run on every push and pull
request incremented them. Read these counters through the REST release object
(`/repos/{owner}/{repo}/releases/latest`), never by GETting the asset — a
`GET` of `latest.yml` increments its own `download_count`.

The `1132-Fixer/windows` figure measures CI and tooling **only**: no shipped
binary polls that feed at all (see [Updater](#updater)). It is not adoption.

Some part of the old-channel count is genuine. Only `<=5.5.1` builds have that
URL baked in, and there is no in-app path to reach them once it 404s. Deleting
the old repo would break their updater checks silently. The size of that
population is not derivable from this counter.

**Policy (2026-08-23): the old feed is an active compatibility bridge, not a
frozen archive.** `<=5.5.1` clients must keep receiving automatic updates —
manual reinstall is **not** an acceptable migration. See
[Legacy compatibility bridge](#legacy-compatibility-bridge) for how a release
is published to this feed so those clients auto-transition to the current
channel. The feed is retired only under the objective condition stated there.

See [`development/updater-channel.md`](development/updater-channel.md).

## Updater

Three feeds are live at once. Which one a client polls is fixed at build time
by the `build.publish` value in the commit it was built from. The app never
calls `autoUpdater.setFeedURL`, so nothing can move a client after install.

| Client generation | Feed it polls | Population |
| --- | --- | --- |
| v5.5.1 and earlier | old Releases-repo `latest.yml` on `PrimeUpYourLife/1132-Fixer-Windows-Releases` — **still serving** | legacy installs |
| **v5.6.0 — the shipped build** | the generic broker `https://botify-network.com/downloads/1132-fixer/updates/latest.yml` | **the entire current install base** |
| the next build cut from `main` | GitHub Releases on `1132-Fixer/windows` (`latest.yml`, SHA-512; URL gated by `isAllowedUpdaterUrl`) | **none — no shipped binary uses this feed** |

Measured 2026-08-23, read from `package.json` at each commit:

- at tag **`v5.6.0`** (`d8278cf71ff98fbfb7736c95c49b84accf524c8c`), the commit the
  released binaries were built from, `build.publish` is
  `{"provider": "generic", "url": "https://botify-network.com/downloads/1132-fixer/updates"}`
- on **`main`** (`ad57009af786a14bd7c46e963fad717bcea8242a`), `build.publish` is
  `{"provider": "github", "owner": "1132-Fixer", "repo": "windows"}`

PR #161 pinned the channel docs and added `tools/updater-channel-smoke.js`. It
changed `main` only. It published no release, and **it moved zero field
clients**. It governs the **next** build. The GitHub feed acquires its first
client when a build cut from `main` is installed — not before.

The broker is a live server-side proxy of this repository's GitHub Releases; it
stores nothing. It serves the same `version`, installer SHA-512, filename and
size as this repository's `latest.yml`, which is what the smoke asserts.

`autoUpdater.setFeedURL` is never called. Portable fetches the named
`LATEST_YML_URL`. HTTPS only; redirects cannot leave the allowlist.
`isAllowedUpdaterUrl` **rejects** the broker and the old repo: residual and
v5.6.0 clients keep working only because their already-installed binary has
its URL baked in.

Do not flip `verifyUpdateCodeSignature` while artifacts are unsigned. Do not
publish a GitHub Release from a channel-docs change. Do not random-bump
`package.json`.

## User comms

> **1132 Fixer downloads now live on the open-source Windows repo.**
> If you installed **v5.5.1 or earlier**, download the latest Setup from
> https://github.com/1132-Fixer/windows/releases/latest
> (or https://1132-fixer.xyz/) and run it over your existing copy.
> Portable users: replace the old `.exe` with the new portable build.

## Retiring the old channel — two populations

Retirement is not one event. The field splits into two populations with
different exits, and only one of them has an exit at all.

| Population | Feed | Does a v5.7 cut from `main` reach it? |
| --- | --- | --- |
| v5.6.0 broker clients | `botify-network.com` broker | **Yes.** The broker proxies this repository's releases, so a v5.7 published here is offered on their next poll. They migrate by updating. |
| v5.5.1 and earlier | old Releases repo, baked in | **Only if a release is published to the old Releases repo.** They never consult the broker and never see this repository — so the migration release is published to their feed as well (see below). |

A release cut from `main` drains the broker population automatically. The
legacy population is drained by **publishing the same release to the old
Releases feed** so their baked-in updater discovers it and upgrades in place —
see [Legacy compatibility bridge](#legacy-compatibility-bridge). This replaces
the earlier "migrate by manual reinstall" plan, which is no longer policy:
manual reinstall is not an acceptable migration path.

**Do not delete, and do not freeze into unusability.** The old feed must keep
answering AND keep receiving the transition release while any supported client
still polls it. Deleting it breaks those clients silently; archiving it in a
way that blocks new releases would strand them at their current version. Retire
it only under the [objective condition](#legacy-compatibility-bridge) below.

## Legacy compatibility bridge

An updater URL compiled into a shipped binary is a **compatibility contract**.
`<=5.5.1` clients have this baked in (measured — extracted from the shipped
`1132-Fixer-Setup-5.5.1.exe`, `resources/app-update.yml`):

| Field | Value |
| --- | --- |
| provider | `github` |
| owner / repo | `PrimeUpYourLife` / `1132-Fixer-Windows-Releases` |
| `latest.yml` URL | `https://github.com/PrimeUpYourLife/1132-Fixer-Windows-Releases/releases/latest/download/latest.yml` |
| release API | `https://api.github.com/repos/PrimeUpYourLife/1132-Fixer-Windows-Releases/releases/latest` |
| installer name | `1132-Fixer-Setup-<version>.exe` |
| blockmap | `1132-Fixer-Setup-<version>.exe.blockmap` (differential; full download if absent) |
| channel | stable (no channel suffix) |
| version format | plain semver `x.y.z` |
| signing | unsigned; `verifyUpdateCodeSignature: false` — the installed client does not require a signed update |
| app identity | `com.hightexas.1132fixer` (unchanged — the update is an in-place upgrade) |

### The bridge is a single release, published to both feeds

A `<=5.5.1` client and a v5.6.0 broker client are migrated by the **same
release**, no separate transition build required, because one release does both
steps automatically:

```
<=5.5.1 install
  -> polls the old PrimeUpYourLife latest.yml (baked in)
  -> discovers 6.0.0 there  (we publish 6.0.0 to the old feed too)
  -> installs 1132-Fixer-Setup-6.0.0.exe as the SAME app (same appId)
  -> now running 6.0.0, whose baked app-update.yml is github/1132-Fixer/windows
  -> from here on polls the CURRENT channel and gets every future release
```

Step 2 works because 6.0.0 is built from `main`, where `build.publish` is
`github/1132-Fixer/windows`, so the upgraded client's feed is the current
channel — the migration is self-completing after one hop.

**What we publish to the old feed:** the identical `latest.yml`, Setup, and
`.blockmap` artifacts produced by the `1132-Fixer/windows` release (same
bytes, same SHA-512). Nothing is rebuilt for the old feed, so the two can never
diverge.

### Objective retirement condition (not download-count)

The old feed may be retired **only** when both hold, and never on
download-count alone:

1. The current-channel telemetry/feed shows no supported client generation
   whose baked-in feed is still `PrimeUpYourLife/1132-Fixer-Windows-Releases`
   (i.e. every `<=5.5.1` install that checks in has already taken the bridge
   hop to a build that polls the current channel); and
2. A measured `<=5.5.1 -> 6.0.0` automatic upgrade has been reproduced and is
   on record (see the testing section of the release notes / this file).

Until then the feed stays live AND keeps receiving each new release. Retire by
leaving it reachable (archive that still serves assets is fine); never in a way
that blocks a needed transition release.

## Checklist

1. Merge the open-source README / LICENSE / updater-home change set.
2. Keep this repository public.
3. **Do not delete** `PrimeUpYourLife/1132-Fixer-Windows-Releases`, and keep
   publishing each release to it, until the
   [objective retirement condition](#objective-retirement-condition-not-download-count)
   is met. It is an active compatibility bridge, not a frozen archive.
4. Next `v*` tag publishes Setup, Portable, checksums, and `latest.yml` here
   **and** the same Setup + `latest.yml` + `.blockmap` are mirrored to the
   legacy feed for `<=5.5.1` clients.
5. Keep https://1132-fixer.xyz/ pointed at this Releases page.

---

## 6.0.0 release cut (2026-08-23)

Version rolled `5.6.0 -> 6.0.0`. This is a **version rollover of the same
application**, not a new product and not a channel change. `build.publish`
on `main` is unchanged (`github / 1132-Fixer / windows`), so 6.0.0 is the
"next build cut from `main`" described under [Updater](#updater): it bakes the
`1132-Fixer/windows` GitHub feed and publishes its artifacts there. The
`botify-network.com` broker proxies this repository's Releases, so v5.6.0
field clients are offered 6.0.0 on their next poll.

### Application identity retained (must not change on an upgrade)

Every identity-bearing value below is **unchanged** from the versions already
in the field. This is what makes 6.0.0 an in-place upgrade instead of a second
install. Verified against the `app-update.yml` extracted from the shipped
`1132-Fixer-Setup-5.5.1.exe`.

| Identity value | Retained value |
| --- | --- |
| Electron `appId` (NSIS uninstall GUID derives from this) | `com.hightexas.1132fixer` |
| `productName` | `1132 Fixer` |
| `updaterCacheDirName` (matches 5.5.1's baked value) | `1132-fixer-updater` |
| NSIS `shortcutName` / `uninstallDisplayName` | `1132 Fixer` |
| NSIS mode | `perMachine: true`, `oneClick: true` |
| Installer artifact name | `1132-Fixer-Setup-${version}.exe` |
| Portable artifact name | `1132-Fixer-Portable-${version}.exe` |
| `publisherName` | `High Texas` |
| Update provider baked into 6.0.0 | `github / 1132-Fixer / windows` |
| `verifyUpdateCodeSignature` | `false` (unsigned — do not flip) |

Because `appId` is unchanged, electron-builder derives the same per-machine
uninstall registry key and the same install directory, so an installed
v5.x upgrades in place: one Start-Menu entry, one uninstall entry, one
app-data root. No side-by-side install.

### Stale-link census — KEEP vs MOVE

Repo-wide census of `PrimeUpYourLife` / `windows-release` references. Not a
blanket replace: each is classified by whether it is release infrastructure
(KEEP) or a project/home pointer to the pre-migration source repo (MOVE).

| Reference | Class | Reason |
| --- | --- | --- |
| `CHANGELOG.md` v5.3.x release-tag links on `PrimeUpYourLife/1132-Fixer-Windows-Releases` | KEEP | historical release provenance — those tags really live there |
| `docs/development/updater-channel.md`, this file | KEEP | release-infra documentation |
| `main.js` comment on the still-live legacy channel | KEEP | accurate runtime note |
| `tools/updater-channel-smoke.js` `OLD_OWNER`/`OLD_REPO` | KEEP | test asserts the legacy feed is rejected by the allowlist |
| `scripts/validate-release-assets.mjs` comment | KEEP | explains a former default; not a live link |
| `docs/security/code-signing.md`, `docs/security/electron-trust.md` | KEEP | historical release-channel facts |
| `README.md` updater paragraph | KEEP | accurate user-facing description of which client polls which feed |
| `docs/security-followup-static-helper-account.md` issue-open URL | MOVE → `1132-Fixer/windows` | project/issue pointer to the old *source* repo |
| `feedback-proxy/README.md` `GH_ISSUES_REPO` / `gh variable --repo` | MOVE → `1132-Fixer/windows` | operator deployment docs that route issues/variables to the old *source* repo. NOTE: the *running* proxy's `GH_ISSUES_REPO` Railway variable must be updated to match — the doc edit alone does not change the deployed service |
| `feedback-proxy/test.js` `GH_ISSUES_REPO` fixture | MOVE → `1132-Fixer/windows` | names the pre-migration source repo; moved so no reference points at the old home, even in fixtures |

`PrimeUpYourLife/1132-Fixer-Windows-Releases` (the **-Releases** repo) is the
release/update endpoint for `<=5.5.1` clients and is never a MOVE target — see
the deletion-blocked warning above. The MOVE rows point at
`PrimeUpYourLife/1132-Fixer-Windows` (**no -Releases**), the pre-migration
*source* repo, which is a project pointer, not release infrastructure.
