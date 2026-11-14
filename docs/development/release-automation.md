# Release preparation and approval

Release preparation changes version records. Publication remains a separate,
gated operation described in [release-process.md](release-process.md). This
workflow does not publish an update or establish native acceptance.

## Automatic version PR

`.github/workflows/release-prepare.yml` uses the SHA-pinned release-please
action on trusted `main` pushes or a manual run on `main`. The Node strategy
keeps `package.json`, `package-lock.json` and `CHANGELOG.md` together in one
pending release PR. The configuration uses `always-bump-patch` and the
existing `vX.Y.Z` tag scheme. Releasable changes need Conventional Commit
messages, for example `fix: bound repair startup`; a documentation-only
commit does not necessarily produce a release PR. A major or minor release
needs an explicit, reviewed version decision.

The manifest starts at the currently published `6.4.0`. It is bootstrap
evidence, not a claim that the repair is released. Do not run the local bump
helper and the automatic PR for the same release. Reconcile an existing
manual candidate before enabling the automatic path; never create duplicate
version PRs or replace an already published version.

The action uses only the repository `GITHUB_TOKEN`, with job-scoped contents,
issues and pull-request write permissions. It does not reuse `RELEASES_PAT`,
create a credential, change repository settings, approve reviews, auto-merge,
create tags or create GitHub releases. Its `skip-github-release: true` input
is mandatory. A merged, pending release PR stops further version PRs until
the corresponding release has been resolved.

## Activation remains blocked by repository policy

The read-only inspection on 2026-11-05 found:

- default workflow permissions: `read`;
- `can_approve_pull_request_reviews: false`.

GitHub's **Allow GitHub Actions to create and approve pull requests** setting
controls PR creation as well as approval. A repository or organization owner
must make an explicit decision about allowing the required PR-creation
capability or identify an existing approved automation identity. This change
does not alter that setting or route around it. Until the capability is
approved and verified, automatic version PR creation is **blocked**. A
workflow file on disk is not proof that automation is operational. Even if
creation is allowed, this workflow never calls review approval or auto-merge.

Current GitHub documentation says `opened`, `synchronize` and `reopened`
pull-request events caused by `GITHUB_TOKEN` create workflow runs that require
a write-capable user's approval. Approve the required CI runs through the
supported mechanism, then obtain the required independent code-owner review.
Run approval does not replace code review. Preserve all branch rules,
required checks and exact-head verification.

## Local preparation helper

For a deliberately manual release, first add truthful release notes under
`## [Unreleased]`, then run in PowerShell 7:

```powershell
node scripts/bump-version.js          # patch, the default
node scripts/bump-version.js minor    # explicit reviewed version decision
node tools/version-bump-smoke.js      # isolated temporary fixtures only
```

The helper requires regular `package.json`, `package-lock.json` and
`CHANGELOG.md` files. Stable SemVer, package identity, both lockfile versions
and the changelog's latest release must agree. It supports npm lockfile
versions 2 and 3 with a `packages[""]` root. It rejects unknown bump types,
prereleases, missing or malformed records, empty release notes and duplicate
changelog releases before writing any of these files. Application version
display already comes from package metadata; no obsolete source/header or
HTML string is rewritten.

It stages the three outputs, checks for changes by another writer, and rolls
back replacements if an ordinary write or rename fails. A concurrent helper
is refused by `.version-bump.lock`. These checks support one execution owner;
they do not provide a filesystem compare-and-swap against other editors.
An interrupted process or power loss is not a multi-file atomic transaction:
inspect the lock, the three version records and any `.version-bump-*.bak`
files before recovery. Do not delete a lock owned by a running process.
Preserve another writer's edits. A failed rollback leaves backups and an
explicit error; a retry refuses inconsistent versions. Review the resulting
diff before committing. The helper never runs Git, creates a tag, uploads an
asset or publishes a release.

## Publication and updater gates

After preparation, keep all required checks green on the final reviewed
source, merge through the normal protected path, and retain independent
review and packaged/native acceptance evidence. Publication must bind the
version and exact source SHA to the verified Setup, Portable, updater
metadata and checksums. A build pass alone does not prove an installed
repair, a successful update or readiness to publish.

Do not depend on a `GITHUB_TOKEN`-created tag starting `release.yml`:
GitHub suppresses that follow-up push event. Use the approved explicit
publication workflow call or an authorized maintainer's normal tag flow,
after its gates pass. `workflow_dispatch` is a supported trigger exception;
this preparation unit does not dispatch it or change the publication
workflow. After verified publication, reconcile the release PR's
`autorelease: pending` / `autorelease: tagged` state through the supported
release-please completion path or an evidenced closeout. Do not remove a
pending label to conceal an unreleased candidate.

Installed **Setup** clients need verified download, checksum validation,
installer handoff, relaunch and persistence evidence. **Portable** clients
receive a download notice and require manual replacement; they do not
self-update. Preserve the current product identity, unsigned-release
policy, canonical `1132-Fixer/windows` feed and legacy manual recovery path.
Never recreate the intentionally deleted legacy release repository.

Primary references:

- [Release-please configuration](https://github.com/googleapis/release-please/blob/main/docs/customizing.md)
- [Manifest and pending release behavior](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md)
- [Pinned action interface](https://github.com/googleapis/release-please-action/blob/5c625bfb5d1ff62eadeeb3772007f7f66fdcf071/action.yml)
- [GitHub Actions repository policy](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)
- [GITHUB_TOKEN event behavior](https://docs.github.com/en/actions/concepts/security/github_token)
