# Code signing — 1132 Fixer for Windows

This document describes the signing state of the Windows releases published from
this repository, how it is enforced, and what has to happen before the updater
can be made to verify signatures.

It replaces `.github/CODE_SIGNING.md`, which was written for a different product
and described a setup this repository never had.

---

## 1. Current signing state: UNSIGNED

**1132 Fixer has never shipped a code-signed build.** Verified 2026-08-14 by
reading the Authenticode state of published release assets across the product's
history, and of an installed client:

| Artifact | Published | Authenticode | Signer | Timestamp |
| --- | --- | --- | --- | --- |
| `1132-Fixer-Setup-5.6.0.exe` | 2026-08-10 | `NotSigned` | none | none |
| `1132-Fixer-Portable-5.6.0.exe` | 2026-08-10 | `NotSigned` | none | none |
| `1132-Fixer-Setup-5.5.1.exe` | 2026-07-30 | `NotSigned` | none | none |
| `1132-Fixer-Setup-5.3.6.exe` | 2026-05-29 | `NotSigned` | none | none |
| `1132.Fixer.Setup.5.2.0.exe` | 2026-05-16 | `NotSigned` | none | none |
| `1132.Fixer.Setup.5.0.0.exe` | 2026-03-17 | `NotSigned` | none | none |
| `1132 Fixer.exe` from an installed v5.5.1 client | — | `NotSigned` | none | none |

Four sampled points spanning March to August 2026, plus the current release and
a real installation. No `CSC_LINK` or `CSC_KEY_PASSWORD` secret is configured on
this repository, so every release the pipeline has produced was built without a
certificate.

Releases up to `v5.5.1` were published on `PrimeUpYourLife/1132-Fixer-Windows-Releases`
and are still served from there; `v5.6.0` onward are published here.

What that means, stated plainly:

- Windows SmartScreen warns on download and on first run. That warning is
  correct — it reflects a real absence of a verified publisher.
- The updater **cannot prove** an update came from the publisher. It verifies
  that the downloaded installer matches the SHA-512 recorded in `latest.yml`,
  and nothing more. Both values come from the same GitHub Release, so anyone
  able to modify that release can change both consistently.
- Nothing in this repository, the README, the release notes, or the app UI may
  describe a release as signed, verified, or trusted-publisher until the table
  above says otherwise. There is no signed-build trust badge, and one must not
  be added ahead of the fact.

`package.json` sets `build.win.verifyUpdateCodeSignature: false`. Given the
table above, that is the only correct value — see §4 for why turning it on today
would break the update channel rather than secure it.

## 2. Expected publisher

`package.json` declares `build.win.signtoolOptions.publisherName: "High Texas"`.
(electron-builder 26 moved this key out of `win` into `win.signtoolOptions`;
declaring it there is metadata only and does not enable signing.)

Today that string is **display metadata only**. It is written into the NSIS
installer and the Windows uninstall registry entry; no certificate has ever
bound it to a verified identity. The `Publisher: High Texas` line visible in
Add/Remove Programs is therefore not evidence of a signature.

When signing begins, the certificate's subject `CN` must equal this string
exactly. `scripts/check-signature-state.mjs` enforces that match, because
`electron-updater` compares the signer `CN` against `publisherName` and a
mismatch rejects every update.

## 3. Certificate type

Not yet purchased. Purchase and installation are operator decisions and are not
performed from this repository or by automation. The trade-off:

| | OV / standard | EV |
| --- | --- | --- |
| SmartScreen | reputation accrues over downloads | immediate |
| Key storage | file or cloud HSM | hardware token or cloud HSM |
| Hosted GitHub runner | works, if the CA offers a cloud-signing or file-based option | only with a cloud HSM; a physical token needs a self-hosted runner |
| Cost | lower | higher |

Certificate authorities have moved private keys for publicly trusted code
signing certificates onto hardware or attested cloud key stores. A plain
`.pfx` pasted into a repository secret is no longer generally issuable, so plan
for a **cloud-signing service** if releases are to stay on hosted runners, or
for a **self-hosted Windows runner** with the token attached.

Whichever is chosen, the requirements below do not change: the signature must
carry a timestamp, and the signer `CN` must equal `High Texas`.

## 4. Why the verification flag cannot simply be flipped

`verifyUpdateCodeSignature` is not evaluated by the release that sets it. It is
evaluated by the version **already installed on the user's machine**, against
the installer that version just downloaded.

So the sequence matters:

- Setting the flag to `true` in a release whose own artifacts are unsigned does
  not fail at build time. It fails later, on every client running that version,
  and it fails permanently: the updater refuses each new installer, so no
  subsequent release can repair it. Users would have to reinstall by hand.
- Enabling verification therefore has to happen **in the first release that is
  actually signed**. Clients still on the preceding unsigned version accept that
  release without verification — a one-time, unavoidable gap. Every update from
  that version onward is verified.

`scripts/check-signature-state.mjs` refuses to publish the broken combination.
It also fails the release when a certificate was configured but the artifact
came out unsigned, so a silent signing failure cannot ship as if it were an
intentional unsigned build.

The remaining preconditions, none of which are satisfied yet:

1. A certificate exists and its `CN` is `High Texas`.
2. `CSC_LINK` / `CSC_KEY_PASSWORD` (or the cloud-signing equivalent) are
   configured, and a release produces `Valid`, timestamped artifacts.
3. A signed update has been installed over a previous version on a test machine,
   and the rollback path in §8 has been exercised.

Until all three hold, the flag stays `false` and this document keeps saying
UNSIGNED.

## 5. GitHub secrets — names only

Never commit a certificate, a password, a PIN, or a key file. `.gitignore`
and the packaging allowlist both exclude certificate extensions, but the
primary control is: the certificate never enters the repository, in any branch,
at any time.

Secrets read by the release workflow:

| Name | Purpose | Configured today |
| --- | --- | --- |
| `CSC_LINK` | certificate location or payload, as the CA's signing method requires | no |
| `CSC_KEY_PASSWORD` | certificate password / token PIN | no |

Record secret **names**, presence, and fingerprints only — never values — in
issues, PRs, receipts, or logs.

The workflow sets `CSC_IDENTITY_AUTO_DISCOVERY: false` so electron-builder can
never pick up an unrelated certificate that happens to be present on a runner.

## 6. Verifying a build locally

```powershell
Get-AuthenticodeSignature .\dist\1132-Fixer-Setup-5.6.0.exe |
  Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
```

`Status` must be `Valid`, the signer `CN` must be `High Texas`, and
`TimeStamperCertificate` must not be empty. Today all three fail, and that is
the expected result.

Same check, in the form CI uses:

```bash
node scripts/check-signature-state.mjs --dist dist
```

It writes `dist/signature-state.json` and exits non-zero only when the state is
one that must not be published.

## 7. Verifying in CI

`.github/workflows/release.yml` runs `scripts/check-signature-state.mjs` after
the build and before the GitHub Release is created. The release stops if:

- an artifact is unsigned while `verifyUpdateCodeSignature` is `true`;
- a certificate was configured but an artifact is not validly signed;
- a signed artifact's `CN` does not match `publisherName`;
- a signed artifact carries no timestamp.

An unsigned build with the flag off passes, prints the unsigned notice, and
records `"overall": "UNSIGNED"` in `signature-state.json`. That file is attached
to the release, so the signing state of every published version stays checkable
after the fact.

## 8. Timestamping, renewal, and rollback

**Timestamping.** Always sign with a timestamp server. Without one, every
previously released installer stops validating the moment the certificate
expires. With one, signatures made during the validity window keep verifying
afterwards. The CI check treats a missing timestamp as a failure.

**Renewal.** A code signing certificate typically has a 1–3 year life.

- 60 days before expiry: start renewal. Identity revalidation takes time.
- 30 days before: certificate issued and stored.
- 14 days before: update the repository secrets, cut a release, and confirm
  `signature-state.json` reports `SIGNED` with the new thumbprint.

Renewing usually produces a *new* certificate rather than extending the old one.
As long as the subject `CN` stays `High Texas`, `electron-updater` keeps
accepting updates across the change. **If the `CN` ever changes, updates break
for the whole installed base** — treat a `CN` change as a migration, not a
renewal, and ship a release that accepts both identities before retiring the
old one.

**Rollback.** If a signed release turns out to be broken:

- Publish a higher version. Do not re-tag or replace assets in place — clients
  cache by version, and rewriting an asset invalidates the checksums and the
  `latest.yml` SHA-512 that users may already have downloaded.
- `allowDowngrade` is not enabled, so a lower version will not be pushed to
  clients through the updater. Recovery from a bad release is forward-only,
  or by manual reinstall from the Releases page.
- If the signing identity itself is the problem, revert to an unsigned build
  **only** together with `verifyUpdateCodeSignature: false` in that same
  release. Shipping an unsigned build to clients that expect verification
  strands them.

## 9. Incident response

If a signing key, token PIN, or certificate password is exposed:

1. Stop releasing. Do not push a `v*` tag.
2. Notify the operator. Certificate and credential handling is operator-owned;
   revocation, reissue, and rotation are not performed from this repository or
   by automation.
3. Record the **type** of credential, where it was exposed, and the commit or
   run that exposed it. Never paste the value into an issue, a PR, a log, or a
   receipt.
4. Treat every artifact signed with that key as untrusted from the exposure
   date onward, and say so on the affected releases.
5. After reissue, publish a new signed release and record the new thumbprint in
   `signature-state.json` via the normal release path.

If the exposure is discovered in git history, note the path and commit and hand
it to the operator. Do not rewrite history to hide it.

Vulnerability reports from outside the project go through the process in
[`SECURITY.md`](../../SECURITY.md).

## 10. Unsigned-build policy

Unsigned releases are **permitted** while §1 says UNSIGNED, under these
conditions, all of which are enforced by
`scripts/check-signature-state.mjs`:

1. `verifyUpdateCodeSignature` stays `false`.
2. No certificate is configured. A configured certificate that fails to sign is
   a build failure, not an unsigned release.
3. `signature-state.json` records `"overall": "UNSIGNED"` and ships with the
   release.
4. No repository document, release note, download page, or UI string claims the
   build is signed or that the updater verifies signatures.
5. `checksums-sha256.txt` is published so a user can at least compare what they
   downloaded against what the release records — while understanding that this
   proves integrity against corruption, not authenticity against the publisher.

An honest unsigned release is acceptable. A release that implies a trust
property it does not have is not.
