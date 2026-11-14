# Startup check: failure handling

This page records the 6.4.0 startup failure, what the evidence shows, and how
6.5.0 handles a failed startup check.

## What users saw

- **Unable to complete**
- "The startup check did not finish in time. Nothing has been changed on this
  computer."
- **View details**: "9 checks could not be verified. 0 of 9 checks passed."

## What the evidence shows

| Question | Finding | Evidence |
| --- | --- | --- |
| Affected version | 6.4.0 | version in the screenshot footer |
| Current published version | 6.4.0, published 2026-09-05 | GitHub Releases |
| Did a recent app change reach users? | No. No release was published after 6.4.0. The 6.4.1 changes on `main` were never released. | release list, tags |
| Which code path shows this screen? | The scan-failure path, not the 8 second administrator-check timeout. | The screenshot has **Try again** and **View details** but no **Close**. The timeout path shows **Close**; the scan-failure path does not. |
| Was it a timeout? | Not established. 6.4.0 shows the same sentence for every failure. | `renderer.js` at `v6.4.0`: the `catch` of `runEnvironmentScan` uses `WIZARD.UNABLE_SUB` for any error |
| Did all nine checks fail? | No. They were not verified. One rejected operation discarded every result. | `main.js` at `v6.4.0`: `Promise.all([preflightCheck(), probePromise])` with no guard |
| Exact trigger on the affected computers | **Not established.** | No support report or app log from an affected computer was available. The in-app feedback endpoint has returned 404 since 2026-10-17 (issue 238), so reports could not arrive. |
| Reproduced? | The failure path: yes, by fault injection against the released 6.4.0 code. The field trigger: no. 6.4.0 scanned normally on the development computer. | `tools/startup-scan-smoke.js` covers the same injection against current code |

A regression from a recent change in this repository is **not confirmed**.
The defect was already in 6.4.0 as released. A change outside the app (a
Windows or security-software change, for example) can make one operation fail
and so expose it, but that is a hypothesis with no evidence yet.

## Is "nothing has been changed" true?

- **6.4.0:** not always. When the app ran elevated and Secondary Logon was
  stopped, the startup check started that service (`sc.exe start seclogon`).
  That is a change to the computer made by a check the message called
  change-free.
- **6.5.0:** the startup check is read-only. It starts no service and writes
  no registry value or file outside the app's own log.
  `tools/startup-scan-smoke.js` asserts that the scan contains no service
  start. The message now says why: "The check only reads settings".

## Behaviour in 6.5.0

The scan has two inputs that run at the same time:

| Operation | Code | Feeds these checks |
| --- | --- | --- |
| Windows tools, Zoom and Secondary Logon | `windows-checks` | Administrator, Zoom Workplace, Secondary Logon |
| Helper account, privacy policies and camera service | `account-and-policy` | Helper account, Helper profile, Camera policy, Microphone policy, Camera Frame Server, User registry hive |

Rules (`src/main/startup-scan.js`):

1. The scan request never rejects. A failed input becomes a named issue:
   operation, kind (`timeout` or `error`) and a short code. The code is never
   a path, a user name or a stack trace.
2. Results from the input that completed are kept.
3. A check whose input failed is **unknown** ("could not be verified"). It is
   not shown as failed and not shown as passed.
4. Any unknown check keeps **Fix now** unavailable.
5. A worker that returns no output is an error. In 6.4.0 an empty answer was
   parsed as `{}` and reported as ready.
6. One scan runs at a time. **Try again**, the focus re-check and the first
   scan share the scan that is already running, so a retry cannot start a
   second set of PowerShell workers.
7. The window ignores the answer of a scan that a newer scan replaced.

Deadlines:

| What | Limit | Why this value |
| --- | --- | --- |
| Administrator check (`startup-status`) | 8 s | Unchanged from 6.4.0. |
| Each worker in main | 10 s to 20 s | Unchanged. A timeout is a result, not an exception. |
| Whole scan, seen from the window | 60 s | New. Every worker is already bounded, so a healthy scan cannot reach it. It only stops **Checking…** from staying on screen without end if the app itself stops answering. |

No existing limit was raised.

What the user sees:

- Timeout: "The startup check stopped because *operation* did not finish in
  time."
- Error: "The startup check stopped because *operation* could not run."
- Partial: "*n* of 9 checks could not be verified because *operation* …. The
  other results are shown in View details."
- **View details** and the app log carry one line per issue with its code.

## Tests

- `tools/startup-scan-smoke.js`: loads the real `main.js` with a stubbed
  Electron and stubbed worker processes. Cases: healthy computer, a worker with
  no output, an operation that throws, three overlapping retries, a retry
  after completion, and the copy for each kind of failure.
- CI packaged acceptance (`tools/packaged-acceptance.js`) covers the rendered
  window on the packaged build.
