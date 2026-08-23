# Release-home migration — August 2026

## Canonical home

Public source, CI, issues, GitHub Releases, and the **current updater feed**
for the Windows app:

**https://github.com/1132-Fixer/windows**

Feed (HTTPS):
`https://github.com/1132-Fixer/windows/releases/latest/download/latest.yml`

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

Census the same day recorded **2212** old-channel downloads; the count is
still rising. Those polls are field clients on v5.5.1 (and earlier) whose
baked-in feed is the old repo. Deleting it would 404 their updater checks.
There is no in-app path to reach them after a 404. They install once from
this repository's Releases page (or https://1132-fixer.xyz/).

See [`development/updater-channel.md`](development/updater-channel.md).

## Updater

| Install | Feed |
| --- | --- |
| Current source / current builds | GitHub Releases on `1132-Fixer/windows` (`latest.yml`, SHA-512; URL gated by `isAllowedUpdaterUrl`) |
| v5.6.0 already shipped | this repository's GitHub Releases (same `latest.yml`); a generic broker URL was tried and is **not** the live feed |
| v5.5.1 and earlier | old Releases-repo `latest.yml` — **still serving** |

Current `package.json` `build.publish` is GitHub provider, owner `1132-Fixer`,
repo `windows`. `autoUpdater.setFeedURL` is never called. Portable fetches
the named `LATEST_YML_URL`. HTTPS only; redirects cannot leave the allowlist.

Do not flip `verifyUpdateCodeSignature` while artifacts are unsigned. Do not
publish a GitHub Release from a channel-docs change. Do not random-bump
`package.json`.

## User comms

> **1132 Fixer downloads now live on the open-source Windows repo.**
> If you installed **v5.5.1 or earlier**, download the latest Setup from
> https://github.com/1132-Fixer/windows/releases/latest
> (or https://1132-fixer.xyz/) and run it over your existing copy.
> Portable users: replace the old `.exe` with the new portable build.

## Checklist

1. Merge the open-source README / LICENSE / updater-home change set.
2. Keep this repository public.
3. **Do not delete** `PrimeUpYourLife/1132-Fixer-Windows-Releases` while
   residual `latest.yml` downloads continue.
4. Next `v*` tag publishes Setup, Portable, checksums, and `latest.yml` here.
5. Keep https://1132-fixer.xyz/ pointed at this Releases page.
