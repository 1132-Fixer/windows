# Release process and trust chain

A release of 1132 Fixer for Windows is produced by pushing a `v*` tag on the
exact current `main` commit. That runs
[`.github/workflows/release.yml`](../../.github/workflows/release.yml). The
read-only authorization job must pass before the write-capable publication job
can start.

This document describes the chain a user's download depends on, link by link,
and states honestly which links exist today.

---

## The chain

```
source/review  ->  required checks  ->  exact CI candidate
               ->  native Setup + Portable acceptance
               ->  support clearance  ->  draft upload/readback
               ->  GitHub Release/latest
```

| # | Link | Status | Where |
| --- | --- | --- | --- |
| 1 | Source and review | present | tag is the current protected `main`; exact reviewed PR head/base and independent code-owner approval are read back |
| 2 | Required checks | present | all seven repository-rule contexts, with their required GitHub Actions integration, are green on the exact SHA |
| 3 | Build | present | `ci.yml` builds and retains one exact-SHA candidate; `release.yml` does not rebuild accepted packages |
| 4 | Security checks | present | blocking `npm audit --audit-level=high`; packaging inventory + allowlist enforced while producing the CI candidate |
| 5 | Signing | **absent** | no certificate configured — see [`../security/code-signing.md`](../security/code-signing.md) |
| 6 | Signature verification | present, and currently reports UNSIGNED | `scripts/check-signature-state.mjs` |
| 7 | Checksums | present | `checksums-sha256.txt`, generated from `dist/*.exe` |
| 8 | SBOM | present | `scripts/generate-sbom.mjs` — SPDX 2.3 JSON, attached to the release |
| 9 | GitHub Release | present | `scripts/publish-release.mjs`, draft-first with per-asset digest readback before publication/latest |
| 10 | Updater metadata | present | `latest.yml`, bound into the exact candidate by `scripts/release-candidate.mjs` and checked again before draft publication |
| 11 | Native acceptance | external release gate | disposable Windows receipts bind both package hashes to installed/extracted runtime hashes and unmodified UAC accept/cancel behavior |
| 12 | Support clearance | external release gate | immutable backend revision, destination/acknowledgement fingerprints, and six Setup/Portable live journeys |

A link marked absent or planned is not a defect being hidden; it is the reason
this document exists. Nothing downstream may claim a property that an absent
link would have provided.

## Link detail

### 1. Source

Tag format is validated first: `v1.2.3` or `v1.2.3-rc.1`. Anything else fails
before checkout. The push must create a new tag: `created=true`, `forced=false`,
and an all-zero before SHA. The preflight reads `git/ref/tags/<tag>`, requires
an annotated tag object, dereferences it through `git/tags/<object-sha>`, and
requires its commit to equal current `main`. It does not use a Release object's
`target_commitish` as tag identity.

The preflight also requires `package.json` to equal the tag version, the active
branch rules to retain all seven named checks and every review control,
including required thread resolution, and each check to be green on that SHA
under its required integration. It paginates reviews and review threads to
exhaustion. Every thread must be resolved. No current blocking review can
remain. Exact-head approval must come from a code owner who is not the PR
author. GitHub must also return the PR's current `reviewDecision` as `APPROVED`;
that provider decision enforces the last-PR-push rule. The tag pusher is not
treated as the last PR pusher. All release runs share one concurrency group.

### 2. CI tests

`ci.yml` runs on every push and pull request to `main`: the Node smoke suites
from `npm test` and both Windows build targets. On a push to `main`, it also
writes `release-candidate.json` and uploads the exact executables, updater
metadata, checksum manifest, inventory, signature state, SBOM and provenance
as `release-candidate-<SHA>`. Artifact upload failure fails the check.

`release.yml` does **not** re-run the suite or rebuild. It reads the exact-SHA
required checks, downloads the one candidate artifact named in the native
acceptance receipt, verifies the artifact archive digest and every candidate
file, and refuses any different package hash.

Native and support evidence is not accepted from JSON-valued release
variables. An independent code owner uses the `Release evidence issuer`
workflow on protected `main`. That workflow validates the exact non-secret
receipt bytes and stores one immutable Actions artifact. The release variables
contain only those artifact IDs. Preflight fetches each artifact and its
workflow run, checks the issuer, source SHA, workflow, event and archive digest,
then hashes and validates the retrieved receipt bytes. It binds the source
head, both package hashes, installed or extracted runtime hashes, UAC evidence,
support deployment revision, destination and acknowledgement fingerprints,
and all six support journeys. Support issue #2 must be closed or carry the
explicit durable supersession marker. Preflight fetches every referenced issue
in a bounded chain and requires the final issue to be closed before it reads
candidate metadata. Preflight and the publisher also require immutable releases
to be enabled before either can create a draft.

### 3. Build

The CI Build & Test job runs `npm ci`, writes the validated public support
configuration, and runs the Portable and NSIS electron-builder targets. The
tag workflow reuses those accepted bytes. It never invokes electron-builder.

`CSC_IDENTITY_AUTO_DISCOVERY: false` is set workflow-wide so electron-builder
cannot pick up an unrelated certificate present on a runner.

The build step then verifies at least two `.exe` files exist, one matching
`*Setup*` and one matching `*Portable*`.

### 4. Security checks

`npm audit --audit-level=high` is a required Security job. A high or critical
finding fails the check and therefore fails release preflight.

`scripts/package-inventory.mjs` runs while CI creates the exact release
candidate. It walks
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

SHA-256 of every `dist/*.exe`, written to `checksums-sha256.txt` by
`scripts/generate-checksums.mjs` and attached to the release. The manifest is
deterministic and directly compatible with the standard tool:

- coreutils format, one record per line: `<64 lowercase hex>  <asset name>`
- LF (`\n`) separators and a final LF; UTF-8 without a byte-order mark
- records sorted by filename (code-point order)

```bash
sha256sum -c checksums-sha256.txt
```

Three gates enforce this. `tools/release-checksums-smoke.js` (in `npm test`)
inspects the generated bytes (CR count, BOM, final LF, hex, order, hash
match), runs `sha256sum -c` on the unmodified file, and proves that a wrong
digest or changed binary fails that real tool. `ci.yml` generates and verifies
the manifest against the built output. `release.yml` verifies the retained
manifest and every accepted package again before it creates a draft.
`scripts/validate-release-assets.mjs` remains a read-only audit tool for an
already published release. Releases up to 6.3.3 were written with
CRLF by a PowerShell cmdlet. [GNU Coreutils 9.0 added CRLF checksum support](https://lists.gnu.org/archive/html/coreutils-announce/2021-09/msg00000.html);
older tools can require removing carriage returns
(`tr -d '\r' < checksums-sha256.txt | sha256sum -c -`). The repository verifier
requires LF bytes on every supported platform, even when an installed tool
accepts CRLF. Published assets are immutable, so 6.3.3 is not re-cut for this.

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

`scripts/publish-release.mjs` creates a non-latest draft and uploads this exact
machine-checked set:

<!-- release-assets:start -->
`1132-Fixer-Setup-<version>.exe` · `1132-Fixer-Portable-<version>.exe` ·
`checksums-sha256.txt` · `latest.yml` · `*.blockmap` · `signature-state.json` ·
`package-inventory.json` · `sbom.spdx.json` · `provenance.json` ·
`release-candidate.json` · `native-acceptance.json` · `support-clearance.json`
<!-- release-assets:end -->

The script downloads each draft asset and checks its SHA-256, then checks the
complete asset set. Only after all readbacks pass does it publish the release
and, for a stable version, mark it latest. A failed upload or readback leaves a
draft and cannot change the public update feed. The workflow also retains the
complete transaction inputs as an Actions artifact before any draft is
created. That retention step is mandatory; storage failure stops publication.

### 10. Updater metadata

`latest.yml` carries the version, the installer filename, its SHA-512, and its
size. The client re-hashes the downloaded installer against that SHA-512 and
size before it will install it. The feed is this repository:
`https://github.com/1132-Fixer/windows/releases/latest/download/latest.yml`;
every install from v6.1.0 on polls it (v5.6.0 installs poll the
`botify-network.com` broker and `<=5.5.1` installs poll the old Releases repo,
because the feed is fixed by `build.publish` in the commit each build came
from). `tools/updater-channel-smoke.js` asserts that file's `version` equals
`package.json`, and that the broker has not diverged from it. See
[`updater-channel.md`](updater-channel.md).

`scripts/finalize-update-metadata.mjs` runs right after the build, before any
checksum or release step. It strips the `isAdminRightsRequired: true` flag
electron-builder writes for per-machine installers — this package ships no
`resources/elevate.exe`, and with the flag present the 6.3.1–6.3.3 clients
tried to run that missing helper and never installed anything — and it fails
the run if `latest.yml`'s version, installer name, size or SHA-512 disagree
with the bytes in `dist/` or with the tag.

Before publication, `scripts/release-candidate.mjs` confirms every filename
referenced by `latest.yml` is in the accepted candidate, that the flag is
absent, that the version equals the tag, and that the installer hashes to the
SHA-512 in `latest.yml` at the recorded size. The draft publisher then reads
back the exact bytes of every uploaded asset. The separate
`scripts/validate-release-assets.mjs` command can audit the same contract on an
already published release.

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
| `actions/setup-node` | `949feb2413d6458794dcd2491c4babbbce0c15c1` | `v7` | GitHub |
| `actions/upload-artifact` | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` | `v7` | GitHub |

The release path uses only GitHub-owned actions. Publication uses the checked-in
Node script and the GitHub API instead of a third-party release action.
All release REST callers use the shared `scripts/github-rest.mjs` transport,
send API version `2026-03-10`, follow pagination links to exhaustion, and read
back each mutation. Ordinary JSON and metadata REST calls reject redirects.
Only bounded artifact-archive and release-asset byte downloads follow redirects
to GitHub download storage; the caller limits their size and verifies their
recorded digest. Review threads use a cursor-paginated GraphQL query and fail
closed on any incomplete page.

Dependabot is configured for `github-actions` weekly, so it raises pull
requests to move these pins forward. Review those like any other dependency
bump: check what changed between the two SHAs, not just that the version number
went up.

`ci.yml`, `release.yml`, and the other operational workflows pin every action
to a full commit SHA. The regression suite compares this inventory to the
workflow bytes and rejects a tag or abbreviated SHA.

## Publishing a release

1. Land the version change on protected `main`; all seven required checks must
   be green and the exact merged head must retain independent code-owner
   approval.
2. `npm version <patch|minor|major>` or `node scripts/bump-version.js`, then
   commit.
3. Let CI retain the exact candidate. Complete disposable native Windows Setup
   and Portable acceptance for those package hashes. Complete the six live
   support journeys against the immutable backend revision. Close support
   issue #2 or record its explicit supersession.
4. Have an independent code owner run `Release evidence issuer` on protected
   `main` once for `native` and once for `support`. Put only the resulting
   immutable artifact IDs in `NATIVE_ACCEPTANCE_ARTIFACT_ID` and
   `SUPPORT_CLEARANCE_ARTIFACT_ID`. Do not put receipt JSON in a variable.
5. Create a new annotated tag on the exact current `main` commit and push it:

```bash
git tag -a v5.6.1 -m "v5.6.1"
```

```bash
git push origin v5.6.1
```

6. Watch the run. A preflight failure means no build, draft, or publication has
   started. Do not work around it by weakening a required check or evidence
   receipt.
7. After the run completes, confirm on the Releases page: both `.exe` assets,
   `checksums-sha256.txt`, `latest.yml`, `signature-state.json`.
8. Confirm the published `latest.yml` carries no `isAdminRightsRequired` line
   and that its `version` is the tag. The candidate and draft-readback gates
   fail before publication if either condition is false.

The version is bumped in exactly one place, `package.json` (`npm version` or
`scripts/bump-version.js`); the packaged executable, `latest.yml`, the
installer filename and the Add/Remove entry all derive from it. The workflow
uses a private draft as a transaction boundary. It publishes only after every
asset readback succeeds. A prerelease tag (`v6.4.0-rc.1`) is published as a
prerelease and is not marked latest; stable clients refuse its `latest.yml`.

## Rolling back

Publish a higher version. Never re-tag, and never replace an asset in place:
clients cache by version, and rewriting an asset invalidates both
`checksums-sha256.txt` and the SHA-512 in `latest.yml` that users may already
hold.

`allowDowngrade` is not enabled, so the updater will not push a lower version.
Recovery is forward-only, or by manual reinstall from the Releases page.
