# Release-home migration — August 2026

## What happened

The dedicated downloads repo `PrimeUpYourLife/1132-Fixer-Windows-Releases` was
deleted on 2026-08-09. Every URL under it now returns 404, including the
`latest.yml` feed that shipped builds poll for updates.

## New release home

GitHub Releases on this repository (`PrimeUpYourLife/1132-Fixer-Windows`).
The release pipeline (`.github/workflows/release.yml`), the updater feed
(`package.json` → `build.publish`), the in-app links (`main.js`), and the
docs all point here as of this change.

**Activation requirement:** anonymous access to `latest.yml` and the release
assets only works while this repository is **public**. If it is private at
first-tag time, the auto-updater, the portable update banner, the download
page, and every README download link fail for end users. The visibility
decision belongs to the release operator and must precede the first `v*` tag
on the new home.

## Who is affected

| Group | Effect | Reachable how |
|---|---|---|
| Installed (NSIS) users ≤ v5.5.1 | Auto-update polls the deleted feed → silent no-update, forever | Only via channels outside the app (website, store listing, Discord/Telegram, GitHub) |
| Portable users ≤ v5.5.1 | Update banner never appears (feed 404 is swallowed as a non-fatal warning) | Same |
| New users | Old download links 404 until docs/website re-point lands everywhere | Website + README fixed by this change set |

There is no in-app path to reach stranded users: the old feed URL is baked
into shipped binaries and the old repo cannot serve a redirect. Migration is
a one-time manual download per user.

## User comms draft (paste into website banner / store listing update / community posts)

> **1132 Fixer moved its downloads.**
> If you installed 1132 Fixer **v5.5.1 or earlier**, automatic updates have
> stopped working — the old download location was retired. Nothing is wrong
> with your installed copy, but it will no longer see new versions.
>
> **To get back on updates:** download the latest installer once from
> <https://github.com/PrimeUpYourLife/1132-Fixer-Windows/releases/latest>
> (or <https://1132-fixer.xyz/>) and run it. It installs over your existing
> copy and keeps your settings. From then on, auto-update works again.
>
> Portable users: download the new portable build from the same page and
> replace your old `.exe`.

## Checklist to complete the migration (owner: release operator / Control)

1. Merge this change set.
2. Decide/confirm repository visibility (public) — required for anonymous
   updater + download access.
3. Push the next `v*` tag; verify the release lands on this repo with
   `latest.yml` + Setup + Portable + checksums (`scripts/validate-release-assets.mjs`).
4. Merge the download-page re-point (`1132-fixer-download-page`) so
   <https://1132-fixer.xyz/> serves the new source.
5. Publish the comms draft above on the website and community channels.
6. Chrome extension listing docs re-point (`1132-Fixer-Chrome` PR) reaches the
   store listing on its next store update.
