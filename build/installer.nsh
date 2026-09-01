; 1132 Fixer - Custom NSIS Installer Script
;
; The install is now ONE-CLICK and PER-MACHINE (see package.json "nsis").
; Rationale: the app's exe manifest requires Administrator, so under the old
; per-user install a standard user elevating with a *different* admin account
; got the app (and its HKCU uninstall entry) installed into that admin's
; profile — invisible and un-uninstallable from their own account. That was
; the "uninstall doesn't work" report. Per-machine puts the app in Program
; Files and the Add/Remove entry in HKLM, visible to every account.

!include "LogicLib.nsh"

; ============================================================================
; customInit — runs before INSTALL (fresh install and silent auto-update).
; Kill any running instance so locked files never block the update.
; ============================================================================

!macro customInit
  nsExec::ExecToLog 'taskkill /F /IM "1132 Fixer.exe" /T'
  Sleep 500
!macroend

; ============================================================================
; customUnInit — runs before UNINSTALL.
; The old script had no equivalent, so uninstalling while the app was open
; hit locked files and silently left the install behind.
; ============================================================================

!macro customUnInit
  nsExec::ExecToLog 'taskkill /F /IM "1132 Fixer.exe" /T'
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

  ; electron-builder still copies unsigned elevate.exe into resources for
  ; per-machine NSIS. The uninstaller is now requireAdministrator and must
  ; not spawn that helper. Remove it from the installed tree.
  Delete "$INSTDIR\resources\elevate.exe"

  ; NOTE: deliberately NO Exec of the app here. electron-updater's
  ; quitAndInstall(_, isForceRunAfter=true) already relaunches after a silent
  ; update; the old extra Exec raced it and produced two elevated instances.
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
