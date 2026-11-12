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
; and then quits. Our read-only process gate waits for the
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
; customCheckAppRunning below waits for an app-owned exit and refuses if it
; cannot prove the app is closed. Installers never terminate repair processes.
; ============================================================================

!macro customInit
  ; The builder otherwise invokes a legacy HKCU uninstaller automatically.
  ; Its account/path/process ownership has not been proved. Preserve it and
  ; refuse this automatic migration rather than execute an unknown teardown.
  ReadRegStr $R1 HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  ${If} $R1 != ""
    DetailPrint "A legacy per-user installation needs a separate verified migration. Setup stopped and preserved it."
    IfSilent +2
    MessageBox MB_OK|MB_ICONEXCLAMATION "A legacy per-user 1132 Fixer installation needs review before migration. Setup has preserved it. Use Support Report before trying again."
    SetErrorLevel 2
    Quit
  ${EndIf}
  ; Releases 6.3.1-6.3.3 shipped an uninstaller whose NSIS integrity check
  ; fails (afterPack re-stamped its manifest after makensis had computed the
  ; CRC). Running it aborts with exit code 2, so the "uninstall old version"
  ; step of this installer would stop at "Failed to uninstall old application
  ; files ... : 2" and the update would never apply. For those versions skip
  ; that uninstaller. Version 6.4.0 also shipped an uninstaller that force-kills
  ; same-name app processes, so do not execute that hook during recovery.
  ; The new files overwrite the old ones in the same
  ; directory and this installer registers a fresh, valid uninstaller.
  ReadRegStr $R0 HKLM "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${If} $R0 == "6.3.1"
  ${OrIf} $R0 == "6.3.2"
  ${OrIf} $R0 == "6.3.3"
  ${OrIf} $R0 == "6.4.0"
    DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY}" "QuietUninstallString"
  ${EndIf}
!macroend

; ============================================================================
; Override electron-builder's shared install/uninstall process gate. Its
; default can escalate to forced termination. A repair may already have made
; irreversible changes, so only the application owns its shutdown boundary.
; nsProcess is already supplied by electron-builder; 603 alone means absent.
; Same-name processes in another account conservatively block installation.
; ============================================================================

!macro customCheckAppRunning
  Push $R0
  Push $R1
  StrCpy $R1 0
  ${Do}
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 603
      ${ExitDo}
    ${EndIf}
    ${If} $R0 != 0
      DetailPrint "Could not verify that 1132 Fixer is closed. Setup stopped without closing programs."
      SetErrorLevel 2
      Quit
    ${EndIf}
    IntOp $R1 $R1 + 1
    ${If} $R1 >= 20
      DetailPrint "1132 Fixer is still running. Finish the repair and close the app before running Setup again."
      IfSilent +2
      MessageBox MB_OK|MB_ICONEXCLAMATION "Finish any repair, then close 1132 Fixer and run Setup again. Setup will not close a repair for you."
      SetErrorLevel 2
      Quit
    ${EndIf}
    Sleep 500
  ${Loop}
  Pop $R1
  Pop $R0
!macroend

; ============================================================================
; customInstall
; ============================================================================

!macro customInstall
  ; Install location for app reference — SHCTX resolves to HKLM per-machine.
  WriteRegStr SHCTX "Software\1132Fixer" "InstallPath" "$INSTDIR"

  ; Preserve legacy per-user files and registration. An elevated installer
  ; may run as a different account; a folder/name alone cannot prove ownership
  ; or that an older copy has no pending repair. Removal needs a separate
  ; verified migration rather than recursive deletion during installation.

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
