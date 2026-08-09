# Building 1132 Fixer locally

Release builds are produced by CI (`release.yml`, tag-triggered) — that is the
release of record. Local builds exist for validation matrices and development.

## Commands

```
npm ci
npm test          # seven smoke suites; must be green before any build you intend to use
npm run build     # portable only
npm run build:installer
npm run build:all # both targets, dist/
```

All build scripts pass `--publish never` — do not remove it (electron-builder
auto-detects CI and would try to publish to the wrong repo; see CHANGELOG
history around v5.3.x for the incident).

## Troubleshooting

### winCodeSign "Cannot create symbolic link" (local Windows builds)

Without Windows Developer Mode or elevation, electron-builder's winCodeSign
cache extraction fails on two `darwin/*.dylib` symlinks inside the archive and
the build dies. The numbered directories under
`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\` are **per-attempt random
staging names** — pre-extracting into them does nothing; every retry mints a
new number.

**Fix:** extract any of the cached `.7z` archives into the FINAL cache name the
pre-download check looks for, tolerating exit code 2 (symlink-only errors —
the darwin payload is irrelevant on Windows):

```powershell
& node_modules\7zip-bin\win\x64\7za.exe x -y -bd `
  "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign\<any>.7z" `
  "-o$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0"
```

The version suffix (`2.6.0`) belongs to the electron-builder major in use
(24.x → winCodeSign-2.6.0). CI runners never hit this — they have symlink
privilege.

## Build evidence record — v5.6.0 (2026-08-09)

Local build from source `a2cee7ca` (master at the v5.6.0 bump), same tree green
in CI run 31283107932:

| Artifact | SHA-256 | Size |
|---|---|---|
| `1132-Fixer-Setup-5.6.0.exe` | `f9e4cf8397cd077202a7f51e58da8c5af8fb47c1f52f5f5164d896f7be8bec81` | 105,336,977 B |
| `1132-Fixer-Portable-5.6.0.exe` | `9f69321234f6ef62993aa79d9abc9d508b53a91a0cf7b3b2e313f91d0b6c452d` | 104,866,886 B |

Local hashes differ from the eventual tag-build hashes (timestamps); the
published release's own checksums file is authoritative for distribution. This
record exists to tie the validation-matrix run to an exact source identity.
