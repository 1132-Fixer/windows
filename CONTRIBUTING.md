# Contributing to 1132 Fixer for Windows

Thank you for helping. This repository is the canonical public source for the Windows app.

## Before you start

- Read the [README](README.md) safety note. The app creates and deletes a local Windows account named `user1`.
- Do not commit secrets, tokens, certificates, `.env` files, or unpacked release binaries.
- Do not open a pull request that rewrites git history.

## Setup

You need Windows 10/11 x64, Node.js 20+, and a machine-wide Zoom Workplace install to exercise the full fix path.

```bash
git clone https://github.com/1132-Fixer/windows.git
cd 1132-Fixer-Windows
npm ci
npm test
```

`npm start` launches the Electron app. Most engine tests do not require Zoom.

## Pull requests

1. Fork the repository (or branch from `master` if you have write access).
2. Create a focused branch. One concern per PR.
3. Run `npm test` and keep it green.
4. Describe the user-visible change and how you verified it.
5. Open the PR against `master` on `1132-Fixer/windows`.

Please keep diffs small. Do not bundle a redesign, a release bump, and a dependency upgrade in the same PR.

## What belongs here

- The Windows Electron app, installer, updater, and tests.
- Docs that help users or contributors of this app.

What does **not** belong here:

- The macOS app (`1132-Fixer/macos`).
- The Chrome extension (`1132-Fixer/chrome`).
- The public website (`1132-Fixer/website`).
- Secrets or production service credentials.

## Releases

Maintainers publish by pushing a `v*` tag. GitHub Actions builds Setup and Portable artifacts onto this repository's Releases. Do not point the updater at a different repository without a documented migration.

## Code of conduct

Be precise, be kind, and do not file support reports that include unredacted personal data. If a report contains secrets or private paths, say so in the issue and do not paste the raw dump.
