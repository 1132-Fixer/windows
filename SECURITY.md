# Security policy

## Supported versions

Security fixes land on the latest published Windows release of 1132 Fixer. Older installer lines do not receive backports unless a maintainer says otherwise on the release notes.

## How to report a vulnerability

**Do not open a public issue for a live credential, a remote-code path, or an unpatched privilege problem.**

Use [GitHub private vulnerability reporting](https://github.com/1132-Fixer/windows/security/advisories/new) on this repository.

If private vulnerability reporting is unavailable, use the contact path on [1132-fixer.xyz](https://1132-fixer.xyz/) and write **Security** in the subject. Include:

- the app version (About, or the release tag)
- Windows edition and build
- a minimal reproduction
- impact (what an attacker gains)

Do not attach unredacted support reports that contain usernames, SIDs, or profile paths unless those values are required to prove the bug — and then redact everything else.

## What this app is allowed to do

1132 Fixer requests Windows administrator approval so it can:

- create, reset, and delete the local helper account `user1`
- start Zoom Workplace as that account via Secondary Logon
- write a DPAPI-sealed helper credential under the signed-in user's `%APPDATA%`

A report that the app needs elevation for those steps is expected behavior, not a vulnerability.

## Secrets in contributions

Never put tokens, signing certificates, or webhook URLs in source, fixtures that ship in the installer, or GitHub issue bodies. CI and the feedback service read secrets from the host, by name.
