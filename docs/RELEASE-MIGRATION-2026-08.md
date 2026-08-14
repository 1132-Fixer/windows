# Release-home migration — August 2026

## Canonical home

Public source, CI, issues, and GitHub Releases for the Windows app:

**https://github.com/1132-Fixer/1132-Fixer-Windows**

This repository is the survivor. Do not delete it.

## Old download repo

`PrimeUpYourLife/1132-Fixer-Windows-Releases` is a leftover public release channel.
It is not the product source. After it is transferred to the `1132-Fixer` organization
and installed apps are rerouted, that releases-only repository may be deleted.
The Windows product repository stays.

## Updater

| Install | Feed |
| --- | --- |
| New builds from this branch | GitHub Releases on `1132-Fixer/1132-Fixer-Windows` |
| v5.6.0 already shipped | generic `https://botify-network.com/downloads/1132-fixer/updates` (broker currently failing — see Botify-Network-Website#297) |
| v5.5.1 and earlier | old Releases-repo `latest.yml` (broken unless that repo still serves assets) |

There is no in-app path to reach stranded v5.5.1 users if their baked-in URL 404s.
Those users install once from this repository's Releases page (or https://1132-fixer.xyz/).

## User comms

> **1132 Fixer downloads now live on the open-source Windows repo.**
> If you installed **v5.5.1 or earlier**, download the latest Setup from
> https://github.com/1132-Fixer/1132-Fixer-Windows/releases/latest
> (or https://1132-fixer.xyz/) and run it over your existing copy.
> Portable users: replace the old `.exe` with the new portable build.

## Checklist

1. Merge the open-source README / LICENSE / updater-home change set.
2. Keep this repository public.
3. Transfer `1132-Fixer-Windows-Releases` to `1132-Fixer`, then delete it only after the updater reroute is verified.
4. Next `v*` tag publishes Setup, Portable, checksums, and `latest.yml` here.
5. Keep https://1132-fixer.xyz/ pointed at this Releases page.
