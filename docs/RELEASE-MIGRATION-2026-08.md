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
the old repo would break their updater checks silently. They install once from
this repository's Releases page (or https://1132-fixer.xyz/). The size of that
population is not derivable from this counter.

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
| v5.5.1 and earlier | old Releases repo, baked in | **No.** They never consult the broker and never see this repository. Nothing published on either reaches them. |

A v5.7 from `main` therefore drains the broker population over time, and drains
the legacy population by exactly zero. Legacy clients have **no decay
mechanism**: their count falls only when a user manually reinstalls, and the
project can neither observe nor drive that. There is no date on which the old
feed becomes safe to remove by attrition.

**Archive over delete.** When the old channel is eventually retired, archive
`PrimeUpYourLife/1132-Fixer-Windows-Releases` — do not delete it. Archiving
freezes the repository while keeping every release asset and its `latest.yml`
reachable, so legacy updater checks keep resolving instead of 404ing. Deletion
is irreversible, breaks those clients silently, and leaves no path to reach
them.

## Checklist

1. Merge the open-source README / LICENSE / updater-home change set.
2. Keep this repository public.
3. **Do not delete** `PrimeUpYourLife/1132-Fixer-Windows-Releases`. If it is
   retired, archive it — see [Retiring the old channel](#retiring-the-old-channel--two-populations).
4. Next `v*` tag publishes Setup, Portable, checksums, and `latest.yml` here.
5. Keep https://1132-fixer.xyz/ pointed at this Releases page.
