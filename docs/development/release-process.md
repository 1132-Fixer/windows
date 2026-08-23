# Release process and trust chain

A release of 1132 Fixer for Windows is produced by pushing a `v*` tag reachable
from `main`. That runs [`.github/workflows/release.yml`](../../.github/workflows/release.yml)
on a hosted `windows-latest` runner.

This document describes the chain a user's download depends on, link by link,
and states honestly which links exist today.

---

## The chain

```
source  ->  CI tests  ->  build  ->  security checks  ->  signing
        ->  signature verification  ->  checksums  ->  SBOM
        ->  GitHub Release  ->  updater metadata
```

| # | Link | Status | Where |
| --- | --- | --- | --- |
| 1 | Source | present | `main`, tag reachable from it |
| 2 | CI tests | present | `ci.yml` — smoke suites, feedback-proxy suites, both build targets |
| 3 | Build | present | `release.yml` — `electron-builder --win --x64 -p never` |
| 4 | Security checks | present | `npm audit` advisory-only in CI; packaging inventory + allowlist enforced in both CI and release |
| 5 | Signing | **absent** | no certificate configured — see [`../security/code-signing.md`](../security/code-signing.md) |
| 6 | Signature verification | present, and currently reports UNSIGNED | `scripts/check-signature-state.mjs` |
| 7 | Checksums | present | `checksums-sha256.txt`, generated from `dist/*.exe` |
| 8 | SBOM | present | `scripts/generate-sbom.mjs` — SPDX 2.3 JSON, attached to the release |
| 9 | GitHub Release | present | `softprops/action-gh-release`, assets attached |
| 10 | Updater metadata | present | `latest.yml`, validated by `scripts/validate-release-assets.mjs` |

A link marked absent or planned is not a defect being hidden; it is the reason
this document exists. Nothing downstream may claim a property that an absent
link would have provided.

## Link detail

### 1. Source

Tag format is validated first: `v1.2.3` or `v1.2.3-rc.1`. Anything else fails
before checkout. All release runs share one concurrency group, so re-running an
old tag cannot race the current one.

### 2. CI tests

`ci.yml` runs on every push and pull request to `main`: the Node smoke suites
from `npm test`, the feedback-proxy suites (both the Postgres-backed framework
suite and the legacy no-database suite), and both Windows build targets.

`release.yml` does **not** re-run the test suite. A tag is expected to point at
a commit CI has already validated on `main`.

### 3. Build

`npm ci` from the committed lockfile, then `node scripts/inject-config.js` to
write `src/main/config.generated.js`, then `electron-builder --win --x64 -p never`.

`-p never` is deliberate: the workflow creates the GitHub Release itself, and
letting electron-builder publish as well would produce a duplicate release and
race the asset upload.

`CSC_IDENTITY_AUTO_DISCOVERY: false` is set workflow-wide so electron-builder
cannot pick up an unrelated certificate present on a runner.

The build step then verifies at least two `.exe` files exist, one matching
`*Setup*` and one matching `*Portable*`.

### 4. Security checks

`npm audit --audit-level=high` runs in CI, advisory only.

`scripts/package-inventory.mjs` runs in both CI and the release job. It walks
`dist/win-unpacked`, reads the `resources/app.asar` header, writes
`dist/package-inventory.json`, and fails the build when a file with a denied
extension appears without a path-exact entry in
`build/package-allowlist.json`. Denied: `.exe` `.dll` `.msi` `.sys` `.node`
`.ps1` `.bat` `.cmd` `.key` `.pfx` `.pem` `.p12` `.cer` `.crt` `.env` `.db`
`.sqlite` `.zip` `.7z`.

It also fails when an allowlist entry stops matching anything, so a stale
exception cannot sit there hiding drift.

This matters because `package.json` `build.files` is a broad `**/*` glob with a
deny list, so what ships depends on what happens to be in the working tree at
build time. Two demonstrated consequences, both now fixed and both of a kind
that leaves no diff to review:

- `.cursor/rules/caveman.mdc` shipped inside `app.asar`, because the deny list
  excludes `**/*.md` and that file is `.mdc`.
- `design-system` was a git submodule. Building with submodules initialised
  would have packaged the entire submodule; building without them would not.
  The payload therefore depended on the checkout, not on the code. The
  submodule has since been removed entirely (its gitlink pointed at a commit
  that no longer existed, which broke every recursive clone, Dependabot's
  included). The `!design-system/**` exclusion in `build.files` is kept so a
  future stray directory of that name still cannot ship.

The inventory is the durable control. The `build.files` exclusions are the
specific fix.

### 5. Signing

**No certificate is configured.** `CSC_LINK` and `CSC_KEY_PASSWORD` are not
present as repository secrets, and the build step unsets them when empty so
electron-builder does not try to resolve an empty value as a file path.

Every release published so far is unsigned. See
[`../security/code-signing.md`](../security/code-signing.md) for the state
table, the certificate decision, and the sequence required before
`verifyUpdateCodeSignature` can be enabled.

### 6. Signature verification

`scripts/check-signature-state.mjs` runs after the build and before the release
is created. It records the true Authenticode state of each artifact into
`dist/signature-state.json`, which is attached to the release, and it fails the
run when:

- an artifact is unsigned while `verifyUpdateCodeSignature` is `true` — this
  combination permanently breaks updates for every client on that version;
- a certificate was configured but an artifact is not validly signed — a silent
  signing failure must not ship as an intentional unsigned build;
- a signed artifact's signer `CN` does not match `publisherName`;
- a signed artifact carries no timestamp.

An unsigned build with the flag off passes and prints an explicit unsigned
notice. That is the current, documented state.

### 7. Checksums

SHA-256 of every `dist/*.exe`, written to `checksums-sha256.txt` and attached to
the release.

Scope of the guarantee: this detects corruption and truncation. It is **not**
proof of origin. The checksum file is published on the same release as the
binaries, so anyone able to alter the release can alter both. Only a code
signature makes the origin claim.

### 8. SBOM and provenance

`scripts/generate-sbom.mjs` writes SPDX 2.3 JSON to `dist/sbom.spdx.json` from
`package-lock.json` and the package inventory. It keeps two distinctions
explicit, because collapsing them is how an SBOM ends up lying:

- A package that **ships** is `CONTAINED_BY` the application; a package that
  only **builds** it is a `BUILD_DEPENDENCY_OF`. `electron` is a
  devDependency whose runtime binaries ship, so it is recorded as contained.
  `electron-builder` is recorded as a build dependency.
- Native binaries that electron-builder fetches outside the lockfile are listed
  from the inventory with their real SHA-256, because the lockfile cannot see
  them.

`scripts/generate-provenance.mjs` writes `dist/provenance.json`: commit, ref,
workflow run, runner, toolchain versions, the folded-in signature state, and the
SHA-256 of every artifact.

**`provenance.json` is not an attestation.** Nothing in it is cryptographically
bound to the build, and anyone able to modify the release can modify it —
exactly like `checksums-sha256.txt`. It answers "which commit, which runner,
which toolchain produced this file"; it does not prove origin. The document
carries that disclaimer in its own `disclaimer` field.

A signed build attestation via Sigstore (`actions/attest-build-provenance`)
would give a genuinely verifiable origin claim without needing a code signing
certificate, and is available to public repositories. It is deliberately **not**
adopted here — it introduces a second trust system and another third-party
action, and that is a decision to take on its own merits rather than fold into
this change. Recorded as the obvious next step.

### 9. GitHub Release

`softprops/action-gh-release` creates the release and attaches:

`1132-Fixer-Setup-<version>.exe` · `1132-Fixer-Portable-<version>.exe` ·
`checksums-sha256.txt` · `latest.yml` · `*.blockmap` · `signature-state.json` ·
`package-inventory.json` · `sbom.spdx.json` · `provenance.json`

The Actions artifact upload that follows is a convenience copy only. It is
`continue-on-error: true` because Actions artifact storage is a quota-limited
bucket, and exhausting it must not red a release that has already shipped.

### 10. Updater metadata

`latest.yml` carries the version, the installer filename, its SHA-512, and its
size. `electron-updater` on the client compares the downloaded installer against
that SHA-512. The live feed is this repository:
`https://github.com/1132-Fixer/windows/releases/latest/download/latest.yml`.
`tools/updater-channel-smoke.js` asserts that file's `version` equals
`package.json`. See [`updater-channel.md`](updater-channel.md).

`scripts/validate-release-assets.mjs` then re-reads the published release from
the GitHub API and confirms every filename referenced by `latest.yml` resolves
to an attached asset — catching the case where the metadata promises a file the
release does not actually carry.

Differential (blockmap) downloads are disabled in the client
(`autoUpdater.disableDifferentialDownload = true`) after repeated field reports
of stuck updates. The `.blockmap` is still published; it is simply not on the
critical path.

Portable builds cannot self-update. The app fetches `latest.yml` from the update
feed, compares versions, and shows a download banner instead.

## GitHub Actions supply chain

Every action used by the release workflow is pinned to a **commit SHA**, with
the human-readable tag kept in a trailing comment. A tag is a movable pointer:
whoever controls the action's repository can repoint it, and a repointed tag in
a release workflow runs attacker-controlled code with `contents: write` on a
job that publishes executables to users. A SHA cannot be repointed.

| Action | Pinned SHA | Tag | Party |
| --- | --- | --- | --- |
| `actions/checkout` | `3d3c42e5aac5ba805825da76410c181273ba90b1` | `v7` | GitHub |
| `actions/setup-node` | `820762786026740c76f36085b0efc47a31fe5020` | `v7` | GitHub |
| `actions/upload-artifact` | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` | `v7` | GitHub |
| `softprops/action-gh-release` | `3d0d9888cb7fd7b750713d6e236d1fcb99157228` | `v3.0.2` | third party |

`softprops/action-gh-release` is the only third-party action in the release
path. Audited 2026-08-14: MIT, ~5.7k stars, actively maintained, not archived,
not a fork. It is owned by a **personal account** rather than an organisation,
which makes it the single highest-leverage external dependency in this pipeline
— one account compromise would otherwise reach every release. That is the
specific risk the SHA pin addresses.

Note that `v3.0.2` is an *annotated* tag: it resolves to a tag object
(`fe965f7a…`), not a commit. The pin above is the commit that tag points at.
Pinning the tag object instead is a common and easy mistake.

Dependabot is configured for `github-actions` weekly, so it raises pull
requests to move these pins forward. Review those like any other dependency
bump: check what changed between the two SHAs, not just that the version number
went up.

`ci.yml` is not pinned. It uses only GitHub-owned actions and cannot publish
anything — the trade is deliberate and worth revisiting if CI ever gains write
access to a release.

## Publishing a release

1. Land the change on `main`; CI green.
2. `npm version <patch|minor|major>` or `node scripts/bump-version.js`, then
   commit.
3. Tag and push:

```bash
git tag -a v5.6.1 -m "v5.6.1"
```

```bash
git push origin v5.6.1
```

4. Watch the run. If it stops at the signature-state check, read the failure
   before changing anything — that check exists to prevent an unrecoverable
   update channel, and its failures are not to be worked around by loosening it.
5. After the run completes, confirm on the Releases page: both `.exe` assets,
   `checksums-sha256.txt`, `latest.yml`, `signature-state.json`.

## Rolling back

Publish a higher version. Never re-tag, and never replace an asset in place:
clients cache by version, and rewriting an asset invalidates both
`checksums-sha256.txt` and the SHA-512 in `latest.yml` that users may already
hold.

`allowDowngrade` is not enabled, so the updater will not push a lower version.
Recovery is forward-only, or by manual reinstall from the Releases page.
