# Tooling methods

These are project execution methods. Their acceptance status is recorded on
issue #252 and PR #254. Source or mocked proof does not establish a repaired
installed Windows application.

| Work | Method | Required proof |
| --- | --- | --- |
| Windows device work | Inspect the live computer/executor inventory and use the existing authorized Windows binding. Keep account permission, connection state and the current task's execution target separate. | Read-only host identity and PowerShell version from the selected Windows executor. A cloud shell or cloud desktop is not that evidence. |
| Native test commands | Use `tools/native-powershell.js` and PowerShell 7 at its standard path on the verified Windows volume. | Version/edition guard before fixtures. Missing PowerShell 7 blocks native checks; no 5.1 or PATH fallback. |
| Private design fetch | Use `.github/scripts/fetch-design-system.js` with the existing `DESIGN_SYSTEM_TOKEN` contract. | Canonical URL, exact consumer pin and fetched-head readback. No persisted header, command-line credential, anonymous fallback or substitute design source. |
| Updater checks | Verify canonical Windows releases, the retained broker and recorded canonical recovery-asset hashes. | HTTPS and expected hashes. The intentionally deleted legacy repository is documented as requiring manual recovery. |
| Helper cleanup | Bind processes, account and profile paths to the exact local SID; prove the profile unloaded before termination and recheck before mutations. | Failed, timed-out, busy or unknown evidence refuses continuation. No forced hive unload or shared profile-service restart. |
| Repository integration | Preserve existing work and merge ancestry on the repair branch. | Exact head, focused regression tests and required checks. No force push or overwrite of another source branch. |
| Release and installed repair | Follow the existing release-evidence contract after independent review and disposable Windows acceptance. | Tested final artifact, truthful native evidence, published checksums and verification of the installed build. A draft PR is not a deployed fix. |

If a connection or credential check fails, record the specific operation and
result. Do not infer that permission was revoked, fabricate a new connection,
repeat an unchanged denied action, or weaken a required check. Continue work
that does not depend on that failure and retain custody in the canonical issue.
