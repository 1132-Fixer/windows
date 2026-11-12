# Tooling methods

These are project execution methods. Their acceptance status is recorded on
issue #252 and PR #254. Source or mocked proof does not establish a repaired
installed Windows application.

| Work | Method | Required proof |
| --- | --- | --- |
| Windows device work | Check the actual command executor first. Verify hostname, Windows edition, PowerShell version and elevation. Inspect existing supported SSH routes when the task spans devices. Keep account permission, connection state and the current task's execution target separate. | Read-only identity from each selected Windows executor. A cloud desktop result does not establish that local commands or an existing SSH route are unavailable. Never change credentials or host-key checks to make a route work. |
| Native test commands | Use `tools/native-powershell.js`, its native argument list and PowerShell 7 at its standard path on the verified Windows volume. The fixed command reads the complete UTF-8 script from stdin. | Version/edition guard before fixtures. No 5.1 or PATH fallback, `cmd.exe` orchestration, or execution-policy override. Embedded child fixtures must use the same native host. Static tests of the separate product compatibility contract do not execute that host. |
| Private design fetch | CI uses `.github/scripts/fetch-design-system.js` with the existing `DESIGN_SYSTEM_TOKEN` contract. Local qualification may use the existing authorized Git credential manager and canonical submodule, with exact-pin readback. | Canonical URL, exact consumer pin and fetched-head readback. No persisted header, command-line credential, anonymous fallback or substitute design source. Local read access does not prove that the CI credential has access. Git diagnostics are classified without printing raw output; private-repository 404 responses do not distinguish absence from denied access. |
| Updater checks | Verify canonical Windows releases, the retained broker and recorded canonical recovery-asset hashes. | HTTPS and expected hashes. The intentionally deleted legacy repository is documented as requiring manual recovery. |
| Helper cleanup | Bind processes, account and profile paths to the exact local SID; prove the profile unloaded before termination and recheck before mutations. Preserve a private quarantine ACL. Open each child relative to its retained parent handle, without following reparse entries. Retain ancestors until their children are removed; delete only through object handles. | Failed, timed-out, busy, readonly, sharing-conflicted or unknown evidence refuses continuation. Deterministic post-inspection parent-swap and outside-sentinel fixtures are required. No path-recursive deletion, recursive ownership retry, forced hive unload or shared profile-service restart. |
| Media and settings | Require the recreated local helper SID and its canonical profile before per-user effects. Bind each receipt to its invocation. Use only an already-loaded helper hive; first-run settings require the helper token and its Zoom session. | No automatic HKLM privacy writes, service changes, hive load/unload or untargeted keystrokes. Missing identity or machine privacy restrictions remain unresolved outcomes. |
| Operator identity | Compare the current token SID with the WTS user SID in the process's own Windows session, then compare both with the independently resolved local helper SID. Repeat before repair and launcher mutations. | Session zero, alternate administrator, missing identity, helper identity and ambiguous receipts refuse mutation. A username or console-session guess is not proof. |
| Helper file settings | Deploy first-run files and set Zoom dark mode in a verified standard helper token. No elevated helper-descendant writes, recursive ACL grants, operator preference/database copy or Windows desktop theme change. | Parent owns the credential-launched process handle, output files and bounded wait. The fixed stdin bootstrap keeps the logon command below Windows' 1024-character limit; only noncredential UTF8 script data enters a parent-owned input file. Passwords stay in stdin/SecureString. Quiet invocation-bound success and separate exit proof are required. Unknown exit retains the app's repair/update/shutdown latch. |
| Installer migration | Override the builder's shared process gate with a bounded read-only check; refuse running/unknown processes. Skip the known unsafe 6.4.0 uninstaller and refuse automatic legacy HKCU migration. | Compile both installer modes, then qualify upgrade/uninstall on a disposable target. No image-name termination or name-only recursive deletion. Legacy files stay preserved pending ownership proof. |
| Cancellation and updates | Use explicit engine checkpoints. Keep normal close/quit from terminating an active repair. Route exit-time and explicit updates through the same asynchronous admission and confirmed spawn. | Completed changes remain after cancellation. Failure requires a fresh read-only check. Busy/unknown child custody blocks update handoff, including after asynchronous probes. |
| Repository integration | Preserve existing work and merge ancestry on the repair branch. | Exact head, focused regression tests and required checks. No force push or overwrite of another source branch. |
| Release and installed repair | Follow the existing release-evidence contract after independent review and disposable Windows acceptance. | Tested final artifact, truthful native evidence, published checksums and verification of the installed build. A draft PR is not a deployed fix. |

If a connection or credential check fails, record the specific operation and
result. Do not infer that permission was revoked, fabricate a new connection,
repeat an unchanged denied action, or weaken a required check. Continue work
that does not depend on that failure and retain custody in the canonical issue.

Native smoke tests may create disposable directories and owned fixture processes.
Inspect those effects before execution. Retain process handles, bound waits, and
clean up only verified fixture paths in `finally`. Mocked account/profile effects
and temporary directory tests do not qualify a real helper reset. Destructive
acceptance still requires an identified disposable Windows target and rollback.

`npm test` runs `test:core` then `test:design`; together they retain every
required suite. CI runs core/native tests before the private design fetch, so
credential failure cannot hide independent repair failures. The design gate
still blocks all builds. A local `packaged-runtime-smoke --mocked-only` run
must report native fixtures not-run; it cannot qualify a release.

Process drain inventory skips only metadata-verified PID 0 (Idle) and PID 4
(System), which do not have user tokens. All other unknown owners still block.
An elevated read-only IRIO inventory took 21.9 seconds, exceeding the previous
20-second capture. Full drains now have a 60-second loop deadline and a
90-second outer capture bound. Neither timing adjustment permits an uncertain
owner or unverified termination to pass.

Ordinary push/PR CI does not run UI automation. An operator may request the
separate disposable diagnostic through `workflow_dispatch.run_packaged_ui`.
That diagnostic uses an altered test copy and never supplies native release
acceptance. Skipped diagnostics emit a not-run, release-ineligible record.
