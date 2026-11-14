# Windows repository disposition ledger

Review snapshot: 2026-11-05. Canonical scope is `1132-Fixer/windows` only.
This ledger records unfinished work; it does not close issues, accept reviews,
merge PRs, delete branches or authorize another writer.

The exhausted remote baseline contained 98 actual issues (five open), 151 PRs
(12 open, 109 merged, 30 closed without merge), and 12 non-main branches. Every
non-main branch mapped to exactly one open PR and matched its head. Historical
enumeration is discovery coverage, not a claim that every historical diff has
been substantively reviewed. Content comparisons, active-writer/dependency
readback and exact-head checks remain prerequisites for disposition.

The dependency/PR246 review below read actual changes, approvals, inline
threads and failed job logs. All ten had zero submitted approvals and zero
unresolved inline threads. Recorded green checks are not combined-candidate,
native, package or installed acceptance. Source publication and independent
review are still outstanding.

| Open PR | Reviewed head | Content disposition and remaining action |
| --- | --- | --- |
| [233](https://github.com/1132-Fixer/windows/pull/233) | `e9082605609bc58be73c2822063ad0eb8e42eb0b` | Preserve broad safety/support/release candidate and its custody. Contains useful process/SID/handle work, cache4.3.0 and other unique changes; also old dependency graph and superseded backend direction. Compare deliberately; never copy its old lock or competing backend wholesale. Main repair, loaded-profile and bounded-custody concerns need independent verification. |
| [235](https://github.com/1132-Fixer/windows/pull/235) | `f6f0fbf2683e608e9ee0391eb100f1e0a762b6a9` | Preserve pending canonical backend migration. Updates embedded feedback-proxy pg8.23.0 to8.23.1. That backend is excluded from the Windows payload and is not canonical support source. Identify deployed consumers and preserve unique behavior/history before closure or retirement. |
| [239](https://github.com/1132-Fixer/windows/pull/239) | `6872f1b4b343c2c9c2d002130a40d1a9a88c18ec` | Retain useful cache4.3.0 and actual proxy/TLS/checksum regression coverage. Root selectively resolved cache4.3.0 and updater6.8.11; proxy driver is being integrated separately. Other lock changes are largely covered/surpassed. No current-head checks were present. Final combined checks, independent review and merged replacement evidence are needed before supersession. |
| [240](https://github.com/1132-Fixer/windows/pull/240) | `aab5eae6f5b29d41b07e03b699ae17779c181165` | Supersession candidate: current graph contains brace-expansion1.1.21/2.1.7/5.0.12. Preserve until final graph content-equivalence, checks, review and merge establish replacement. |
| [241](https://github.com/1132-Fixer/windows/pull/241) | `7aa5630243cf48a8f30e3eb71f820fcbaf764bb6` | Useful unintegrated harness upgrade1.62.1 to1.64.1, including Electron first-window behavior. Current no-browser/desktop-control restriction remains effective; package/source checks cannot stand in for running the UI harness. |
| [244](https://github.com/1132-Fixer/windows/pull/244) | `6c0d63baea79b80fb4e9d06a745636f52ead3157` | Preserve draft candidate: product website, private design checkout and deleted legacy-feed coverage. Its recorded exact-head required checks were green, but it is unapproved/unmerged. Reuse reviewed shared checkout correction, preserve canonical design pin and owner-selected manual legacy recovery; do not recreate the deleted release repository. |
| [246](https://github.com/1132-Fixer/windows/pull/246) | `191e027135383bb5874b6b1287efd3315fb9e3fb` | Retain supported manual Copilot command configuration. On integration explicitly disable automatic browser opening, automatic issue sessions and remote control. Actual client acceptance remains unverified. Latest failures are private design checkout, not execution of its commands. |
| [247](https://github.com/1132-Fixer/windows/pull/247) | `daca8a780d2e42a331cf758e28689d8743660675` | Separate major runtime candidate Electron45.0.0; current44.10.2 does not supersede it. Static preload review is insufficient: preserve security boundaries and obtain package/startup/preload/IPC/lifecycle compatibility before an upgrade decision. |
| [248](https://github.com/1132-Fixer/windows/pull/248) | `40e43a4efa742bce7692223f102b2c14ba992b18` | Useful shipped updater6.8.11 cache-filename correction. Selectively resolved in the current source graph; actual cache-helper refusals, final library/controller checks and installed A-to-B acceptance still matter. No issue/PR closure yet. |
| [249](https://github.com/1132-Fixer/windows/pull/249) | `3915fe5cb7f948ed61d5224c15645f3fcf24c750` | Useful build26.18.0 candidate; regenerate a combined graph. Its old lock would restore undici7.29.0 over7.30.2, and app-builder-lib26.18.0 would no longer match the current26.15.3 minimatch override. Reconcile consumer-scoped overrides, measured globs and packaging before adoption. |
| [250](https://github.com/1132-Fixer/windows/pull/250) | `77b0fdf942b4d41b797d5321478dadb280c85934` | Supersession candidate: local fast-uri3.1.9 matches version/integrity. Preserve until combined source is tested, independently reviewed and merged; retain replacement link/content evidence. |
| [251](https://github.com/1132-Fixer/windows/pull/251) | `5eba7d635af5eb78483715a3b26d8392ec825aea` | Supersession candidate: current undici6.29.1 matches and7.30.2 is newer than this PR's7.30.1. Preserve until combined replacement coverage and merge are verified. |

For PR246 through251, all twelve failed Build & Test/brand-assets job logs
were read individually. Each stopped cloning private `1132-Fixer/design-system`
with `Repository not found` and exit1. Tests/build/brand guard never started.
For example, [PR246 Build](https://github.com/1132-Fixer/windows/actions/runs/39280588447/job/118153760012)
and [Brand](https://github.com/1132-Fixer/windows/actions/runs/39280588551/job/118153759868)
tested merge `41fea1efb7b482026be3f59964881b97f403b5aa` and failed at checkout.
The shared approved checkout/secret-scope correction must precede fresh checks;
changing assertions would not repair this failure.

| Open issue | Current disposition and owner/exit |
| --- | --- |
| [252](https://github.com/1132-Fixer/windows/issues/252) | Open, first priority; this existing execution lane owns repair. Native integration, full profile purge, supported phase recovery, standalone consumers and disposable Windows Home acceptance remain unfinished. Installed6.4.0 is unchanged; source archive halted. |
| [238](https://github.com/1132-Fixer/windows/issues/238) | Open; Windows client strict acknowledgement prepared. Existing backend owner must deliver canonical support-reporting source/deployment/bot/destination and approved endpoint, then verify real acknowledgement/delivery. Legacy service liveness is insufficient. |
| [243](https://github.com/1132-Fixer/windows/issues/243) | Open; retain owner decision that the legacy release repository was intentionally deleted. Complete PR244 replacement coverage and actual documented manual recovery, current feed and installed update acceptance. |
| [245](https://github.com/1132-Fixer/windows/issues/245) | Open; local private pinned design checkout was recovered and pin guards passed. CI secret scopes and final combined shared checkout still need verified readback. Local access or PR244's earlier green check alone does not close every CI context. |
| [229](https://github.com/1132-Fixer/windows/issues/229) | Open; owner ruleset decisions and recovered local-only files still require preservation/disposition. Older always-bypass actor snapshots are stale; preserve current required checks and independent safety reviews. No protection setting changed. |

All twelve remote branches remain preserved under their associated PR heads.
No branch is proved ready for deletion. Before any deletion, refresh its exact
head, compare content/behavior after squash or cherry-pick, preserve unique
commits and dirty work, verify dependent branches/worktrees and actual current
writer custody, and record the merged/preserved replacement. Do not infer
writer release from a stale comment or infer integration from ancestry alone.

Local dependency readback after selective updates: lock SHA256
`EB281D5395FE7219EB2FD666830520DD159CC95A76508511C415187A932A4991`;
Electron44.10.2, updater6.8.11, http-cache-semantics4.3.0, builder26.15.3,
undici7.30.2 and existing scoped minimatch11.0.1 overrides. `npm ci` and fresh
audit completed successfully with zero findings. This is dependency-source
evidence, not approval, merged replacement, package or installed proof.

Primary compatibility references: [Playwright1.64.1](https://github.com/microsoft/playwright/releases/tag/v1.64.1),
[Electron45](https://github.com/electron/electron/releases/tag/v45.0.0),
[updater6.8.11](https://github.com/electron-userland/electron-builder/releases/tag/electron-updater@6.8.11),
[builder26.18.0](https://github.com/electron-userland/electron-builder/releases/tag/electron-builder@26.18.0),
[Copilot app configuration](https://docs.github.com/en/copilot/reference/github-copilot-app-reference/repository-configuration).
Substantive source/check findings have reasoned confidence0.99. Electron45
compatibility remains unverified; its source-only estimate0.65 cannot satisfy
package/runtime acceptance. The final inventory/counts must be refreshed after
actual integrations and closeout; current counts remain five open issues,
12 open PRs and12 non-main remote branches, with no remote mutation by this lane.
