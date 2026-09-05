; 1132 Fixer - Custom NSIS Installer Script
;
; The install is ONE-CLICK and PER-MACHINE (see package.json "nsis").
; Rationale: the app's exe manifest requires Administrator, so under the old
; per-user install a standard user elevating with a *different* admin account
; got the app (and its HKCU uninstall entry) installed into that admin's
; profile — invisible and un-uninstallable from their own account. That was
; the "uninstall doesn't work" report. Per-machine puts the app in Program
; Files and the Add/Remove entry in HKLM, visible to every account.
;
; Silent update handoff (September 2026). The running app starts this
; installer itself with:
;
;     --updated /S --fixer-relaunch /D=<its own install directory>
;
; and then quits. electron-builder's stock install section waits for the
; app to exit (CHECK_APP_RUNNING), runs the previous version's uninstaller
; with --keep-shortcuts / KEEP_APP_DATA, extracts the new files into $INSTDIR,
; refreshes the registry records and shortcuts, and then customInstall below
; relaunches the installed executable. Because this installer already runs
; elevated (it inherits the elevated app's token), the relaunch needs no
; second Windows approval prompt and opens in the same interactive session
; as the app that asked for the update.

!include "LogicLib.nsh"

; ============================================================================
; customInit — runs before INSTALL (fresh install and silent auto-update).
;
; Deliberately NO `taskkill /IM "1132 Fixer.exe" /T` here. During a silent
; update this installer is a descendant of the still-exiting app process, so
; `/T` (kill the process TREE) could terminate the installer itself while
; the app was shutting down — the update then silently never happened.
; electron-builder's install section already waits for the app to exit and
; ends it without touching this process (allowOnlyOneInstallerInstance.nsh).
; ============================================================================

!macro customInit
!macroend

; ============================================================================
; customUnInit — runs before UNINSTALL.
; Uninstalling while the app is open used to hit locked files and silently
; leave the install behind. No /T: the uninstaller is itself launched by the
; next version's installer during an update, and must never kill its parent.
; ============================================================================

!macro customUnInit
  nsExec::ExecToLog 'taskkill /F /IM "1132 Fixer.exe"'
  Sleep 500
!macroend

; ============================================================================
; customInstall
; ============================================================================

!macro customInstall
  ; Install location for app reference — SHCTX resolves to HKLM per-machine.
  WriteRegStr SHCTX "Software\1132Fixer" "InstallPath" "$INSTDIR"

  ; Migration from pre-5.4 per-user installs: remove the old copy and its
  ; per-user Add/Remove entry so the machine doesn't end up with two apps.
  ; ${UNINSTALL_REGISTRY_KEY} is the same GUID-derived key name electron-builder
  ; used for the per-user install (deterministic from appId).
  RMDir /r "$LOCALAPPDATA\Programs\1132 Fixer"
  DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
  DeleteRegKey HKCU "Software\1132Fixer"

  ; Belt-and-suspenders: afterPack strips elevate.exe from win-unpacked
  ; before the 7z is built. Delete it here if a future packer copies it again.
  ; The updater does not use it (see src/main/updater.js).
  Delete "$INSTDIR\resources\elevate.exe"

  ; Relaunch after a silent update, and only then. The app passes
  ; --fixer-relaunch; a fresh interactive install still uses electron-builder's
  ; own run-after-finish path, and an installer started by an older client
  ; (which passes --force-run instead) is launched by electron-builder's
  ; StartApp, never twice. Exec from this elevated installer keeps the same
  ; account and session as the app that requested the update; the app checks
  ; the relaunch against its handoff record (--updated --fixer-relaunch).
  ${StdUtils.TestParameter} $R0 "fixer-relaunch"
  ${If} $R0 == "true"
    SetOutPath "$INSTDIR"
    Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --updated --fixer-relaunch'
  ${EndIf}
!macroend

; ============================================================================
; customUnInstall
; ============================================================================

!macro customUnInstall
  DeleteRegKey SHCTX "Software\1132Fixer"
  ; Legacy key cleanup (old per-user installs / old app name)
  DeleteRegKey HKCU "Software\1132Fixer"
  DeleteRegKey HKCU "Software\1132Eliminator"
!macroend
