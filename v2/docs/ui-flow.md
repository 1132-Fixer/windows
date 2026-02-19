# UI Flow Documentation

## Overview

The application follows a 5-screen wizard flow that guides users through the remediation process with full transparency and explicit approval at each step.

```
┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐
│  AUDIT  │ ──▶ │  PLAN   │ ──▶ │ APPROVE │ ──▶ │ EXECUTE │ ──▶ │ VERIFY  │
└─────────┘     └─────────┘     └─────────┘     └─────────┘     └─────────┘
```

---

## Screen 1: Audit

### Purpose
Read-only scan to discover all vendor-owned artifacts on the system.

### UI Components

```
┌─────────────────────────────────────────────────────────────────────────┐
│  WINDOWS APP REMEDIATOR                                    [─] [□] [×]  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  SELECT APPLICATION                                              │   │
│  │  ┌─────────────────────────────────────────────────────────────┐│   │
│  │  │ Zoom Meetings                                           [▼] ││   │
│  │  └─────────────────────────────────────────────────────────────┘│   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  SCAN OPTIONS                                                    │   │
│  │                                                                  │   │
│  │  [✓] Include all user profiles (read-only)                      │   │
│  │  [ ] Include network configuration observer                     │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│                        ┌──────────────────────┐                        │
│                        │     RUN AUDIT        │                        │
│                        └──────────────────────┘                        │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  SCAN RESULTS                                                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────┬──────────────┬────────────────────────────────────┐   │
│  │ CATEGORY    │ COUNT        │ STATUS                             │   │
│  ├─────────────┼──────────────┼────────────────────────────────────┤   │
│  │ Files       │ 247          │ ● Found                            │   │
│  │ Registry    │ 34           │ ● Found                            │   │
│  │ Processes   │ 3            │ ● Running                          │   │
│  │ Services    │ 2            │ ● Running                          │   │
│  │ Tasks       │ 4            │ ● Found                            │   │
│  └─────────────┴──────────────┴────────────────────────────────────┘   │
│                                                                         │
│  ISSUES DETECTED                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ ⚠ Service "CptService" references missing binary                │   │
│  │ ⚠ Registry key references non-existent path                     │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌────────────────────┐                    ┌────────────────────────┐   │
│  │   VIEW DETAILS     │                    │   PROCEED TO PLAN  ▶   │   │
│  └────────────────────┘                    └────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Data Displayed
- Artifact counts by category
- High-confidence ownership list
- Issues found (orphaned references, broken paths)

### Actions
- **Run Audit**: Triggers `ipcRenderer.invoke('audit', request)`
- **View Details**: Opens artifact table modal
- **Proceed to Plan**: Navigate to Plan screen

---

## Screen 2: Plan

### Purpose
Select remediation mode and preview the generated plan.

### UI Components

```
┌─────────────────────────────────────────────────────────────────────────┐
│  WINDOWS APP REMEDIATOR                                    [─] [□] [×]  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  REMEDIATION MODE                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │  ○ Repair      Fix orphaned references and broken state         │   │
│  │  ○ Clean       Remove residual files and registry entries       │   │
│  │  ● Uninstall   Complete removal of application                  │   │
│  │  ○ Reinstall   Uninstall and install fresh                      │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  OPTIONS                                                                │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  [ ] Preserve user settings (zoomus.conf)                       │   │
│  │  [✓] Preview only (dry run)                                     │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│                        ┌──────────────────────┐                        │
│                        │   GENERATE PLAN      │                        │
│                        └──────────────────────┘                        │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  PLANNED STEPS                                              Risk: LOW   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  1. [🟢 LOW]  Stop Process: Zoom.exe                            │   │
│  │     Reason: Process holds locks on application files            │   │
│  │                                                                  │   │
│  │  2. [🟢 LOW]  Stop Service: CptService                          │   │
│  │     Reason: Service must be stopped before file removal         │   │
│  │                                                                  │   │
│  │  3. [🟡 MED]  Run Uninstaller: Zoom                             │   │
│  │     Reason: Use official uninstall to remove components         │   │
│  │                                                                  │   │
│  │  4. [🟡 MED]  Remove Folder: %APPDATA%\Zoom                     │   │
│  │     Reason: Clean residual user data                            │   │
│  │                                                                  │   │
│  │  5. [🟡 MED]  Delete Registry: HKCU\Software\Zoom               │   │
│  │     Reason: Remove user preferences and settings                │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  BOUNDARIES (What will NOT be touched)                                  │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  ✓ System files (C:\Windows\...)                                │   │
│  │  ✓ Other applications                                           │   │
│  │  ✓ User documents                                               │   │
│  │  ✓ Browser data                                                 │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌────────────────────┐                    ┌────────────────────────┐   │
│  │   ◀ BACK           │                    │   REVIEW & APPROVE ▶   │   │
│  └────────────────────┘                    └────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Data Displayed
- Step timeline with risk badges
- Allowed paths/registry prefixes (boundaries)
- Explicit "What will NOT be touched" reassurance

### Actions
- **Generate Plan**: Triggers `ipcRenderer.invoke('build-plan', request)`
- **Review & Approve**: Navigate to Approve screen

---

## Screen 3: Approve

### Purpose
Final review and explicit user consent before execution.

### UI Components

```
┌─────────────────────────────────────────────────────────────────────────┐
│  WINDOWS APP REMEDIATOR                                    [─] [□] [×]  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │  ⚠️  REVIEW BEFORE PROCEEDING                                   │   │
│  │                                                                  │   │
│  │  The following actions will be performed:                       │   │
│  │                                                                  │   │
│  │  • Stop 3 processes                                             │   │
│  │  • Stop 2 services                                              │   │
│  │  • Run official uninstaller                                     │   │
│  │  • Delete 5 folders (247 files, 156 MB)                        │   │
│  │  • Delete 34 registry keys                                      │   │
│  │  • Remove 4 scheduled tasks                                     │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  BACKUP INFORMATION                                                     │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Registry backup: C:\Users\...\AppData\Local\WinRemediator\    │   │
│  │                   backups\zoom_2024-01-16_1030.reg             │   │
│  │                                                                  │   │
│  │  Transaction log: C:\Users\...\AppData\Local\WinRemediator\    │   │
│  │                   logs\plan_8c21.json                          │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │  [✓] I understand this will modify files and registry within   │   │
│  │      the allowed scope for Zoom                                 │   │
│  │                                                                  │   │
│  │  [✓] I have reviewed the planned steps                         │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌────────────────────┐                    ┌────────────────────────┐   │
│  │   ◀ BACK           │                    │   APPROVE & RUN ▶      │   │
│  └────────────────────┘                    └────────────────────────┘   │
│                                                                         │
│                           (Requires Admin)                              │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Requirements
- Both checkboxes must be checked to enable "Approve & Run"
- Shows admin requirement if needed

### Actions
- **Approve & Run**:
  - Generates approval token
  - Triggers `ipcRenderer.invoke('execute-plan', { planId, approveToken })`
  - Navigates to Execute screen

---

## Screen 4: Execute

### Purpose
Real-time progress display during remediation.

### UI Components

```
┌─────────────────────────────────────────────────────────────────────────┐
│  WINDOWS APP REMEDIATOR                                    [─] [□] [×]  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  EXECUTING REMEDIATION                                                  │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  ████████████████████████████████░░░░░░░░░░░░░░  Step 4 of 8   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  STEP TIMELINE                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │  ✓ Stop Process: Zoom.exe                          [COMPLETE]   │   │
│  │    └─ Terminated PID 4420, 9184                                 │   │
│  │                                                                  │   │
│  │  ✓ Stop Process: CptHost.exe                       [COMPLETE]   │   │
│  │    └─ Terminated PID 2156                                       │   │
│  │                                                                  │   │
│  │  ✓ Stop Service: CptService                        [COMPLETE]   │   │
│  │    └─ Service stopped successfully                              │   │
│  │                                                                  │   │
│  │  ● Run Uninstaller: Zoom                           [RUNNING]    │   │
│  │    └─ Executing: Installer.exe /uninstall /silent               │   │
│  │                                                                  │   │
│  │  ○ Remove Folder: %APPDATA%\Zoom                   [PENDING]    │   │
│  │                                                                  │   │
│  │  ○ Delete Registry: HKCU\Software\Zoom             [PENDING]    │   │
│  │                                                                  │   │
│  │  ○ Delete Registry: HKLM\Software\Zoom             [PENDING]    │   │
│  │                                                                  │   │
│  │  ○ Remove Scheduled Tasks                          [PENDING]    │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  EXECUTION LOG                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  10:30:12 [INFO] Starting remediation plan_8c21                 │   │
│  │  10:30:12 [INFO] Step 1: Stopping process Zoom.exe              │   │
│  │  10:30:13 [INFO] Process Zoom.exe (PID 4420) terminated         │   │
│  │  10:30:13 [INFO] Process Zoom.exe (PID 9184) terminated         │   │
│  │  10:30:14 [INFO] Step 2: Stopping process CptHost.exe           │   │
│  │  ...                                                            │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌────────────────────┐                                                │
│  │   CANCEL           │    (Will stop after current step)             │
│  └────────────────────┘                                                │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Real-time Updates
- Progress bar
- Step status icons (✓ complete, ● running, ○ pending, ✗ failed)
- Per-step before/after summary
- Live execution log (scrolling)

### Actions
- **Cancel**: Stops execution after current step completes

---

## Screen 5: Verify

### Purpose
Independent verification and report generation.

### UI Components

```
┌─────────────────────────────────────────────────────────────────────────┐
│  WINDOWS APP REMEDIATOR                                    [─] [□] [×]  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  VERIFICATION RESULTS                                                   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │     ████████████████████████████████████████████████████████    │   │
│  │     ██                                                      ██   │   │
│  │     ██              ✓ VERIFICATION PASSED                  ██   │   │
│  │     ██                                                      ██   │   │
│  │     ████████████████████████████████████████████████████████    │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  VERIFICATION CHECKS                                                    │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │  ✓ No Zoom processes running                                    │   │
│  │  ✓ No Zoom services remain                                      │   │
│  │  ✓ All target files removed                                     │   │
│  │  ✓ All target registry keys removed                             │   │
│  │  ✓ No orphaned references detected                              │   │
│  │  ✓ Scheduled tasks removed                                      │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  BEFORE/AFTER COMPARISON                                                │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  ┌───────────────────┬───────────────────┐                      │   │
│  │  │ BEFORE            │ AFTER             │                      │   │
│  │  ├───────────────────┼───────────────────┤                      │   │
│  │  │ Files: 247        │ Files: 0          │                      │   │
│  │  │ Registry: 34      │ Registry: 0       │                      │   │
│  │  │ Processes: 3      │ Processes: 0      │                      │   │
│  │  │ Services: 2       │ Services: 0       │                      │   │
│  │  │ Tasks: 4          │ Tasks: 0          │                      │   │
│  │  └───────────────────┴───────────────────┘                      │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  POST-REBOOT VERIFICATION                                               │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  [ ] Schedule verification after next reboot                    │   │
│  │      (Recommended for complete confirmation)                    │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌────────────────────┐  ┌──────────────────┐  ┌───────────────────┐   │
│  │   VIEW FULL LOG    │  │  EXPORT REPORT   │  │       DONE        │   │
│  └────────────────────┘  └──────────────────┘  └───────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Verification Display
- Pass/Warn/Fail status for each check
- Before/After diff summary
- Option for post-reboot verification

### Actions
- **View Full Log**: Opens log file
- **Export Report**:
  - Format selection (JSON, HTML, TXT)
  - Username redaction option
  - Triggers `ipcRenderer.invoke('export-report', request)`
- **Done**: Close wizard or return to Audit screen

---

## IPC Channels

```typescript
// Main IPC channels used by the UI
const IPC_CHANNELS = {
  // Request/Response (invoke)
  AUDIT: 'audit',
  BUILD_PLAN: 'build-plan',
  EXECUTE_PLAN: 'execute-plan',
  VERIFY: 'verify',
  EXPORT_REPORT: 'export-report',

  // Events (on)
  PROGRESS: 'remediation-progress',
  LOG: 'remediation-log',
};
```

---

## State Management

### Application State

```typescript
interface AppState {
  // Current screen
  currentScreen: 'audit' | 'plan' | 'approve' | 'execute' | 'verify';

  // Selected product
  productId: string | null;

  // Audit results
  auditSnapshot: Snapshot | null;
  auditIssues: AuditIssue[];

  // Plan
  currentPlan: Plan | null;
  planWarnings: string[];

  // Execution
  executionStatus: ExecutionStatus | null;
  executionResults: StepResult[];

  // Verification
  verificationResult: VerificationResult | null;
  postRebootScheduled: boolean;

  // UI state
  isLoading: boolean;
  error: string | null;
}
```

### Screen Transitions

```
START
  │
  ▼
AUDIT ──────────────────────┐
  │                         │
  │ [Run Audit]             │ (Can always return)
  ▼                         │
PLAN ◀──────────────────────┤
  │                         │
  │ [Generate Plan]         │
  ▼                         │
APPROVE ◀───────────────────┤
  │                         │
  │ [Approve & Run]         │
  ▼                         │
EXECUTE ────────────────────│
  │                         │
  │ (Auto-advance)          │
  ▼                         │
VERIFY ─────────────────────┘
  │
  │ [Done]
  ▼
END (or back to AUDIT)
```

---

## Accessibility

- All interactive elements have keyboard navigation
- Screen reader labels for status icons
- High contrast mode support
- Focus management between screens
