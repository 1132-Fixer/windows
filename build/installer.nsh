; 1132 Fixer - Custom NSIS Installer Script
; Zoom Error 1132 device ban fix tool

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

; ============================================================================
; Custom Welcome Text
; ============================================================================

!define MUI_WELCOMEPAGE_TITLE "Welcome to 1132 Fixer"
!define MUI_WELCOMEPAGE_TEXT "1132 Fixer resets device fingerprints and Zoom artifacts to fix Error 1132 device bans on Windows.$\r$\n$\r$\nFeatures:$\r$\n• Full device fingerprint reset$\r$\n• Registry and artifact cleanup$\r$\n• Clean Zoom reinstall$\r$\n• Auto-launch after fix$\r$\n$\r$\nClick Next to continue."

; ============================================================================
; Custom Finish Text
; ============================================================================

!define MUI_FINISHPAGE_TITLE "Installation Complete"
!define MUI_FINISHPAGE_TEXT "1132 Fixer has been installed successfully.$\r$\n$\r$\nThe app requires Administrator privileges to fix device bans.$\r$\n$\r$\nClick Finish to exit the installer."

; ============================================================================
; Macro: Kill running app before install (fixes auto-update blocking)
; ============================================================================

!macro customInit
  ; Force-kill any running instance so silent updates don't get blocked
  nsExec::ExecToLog 'taskkill /F /IM "1132 Fixer.exe" /T'
  Sleep 500
!macroend

; ============================================================================
; Macro: Custom Installation Section
; ============================================================================

!macro customInstall
  ; Write install location for app reference
  WriteRegStr HKCU "Software\1132Fixer" "InstallPath" "$INSTDIR"

  ; Auto-launch app after silent install (auto-update scenario)
  ; Sleep lets the old process fully exit so single-instance lock is released
  ${if} ${Silent}
    Sleep 3000
    Exec '"$INSTDIR\1132 Fixer.exe"'
  ${endif}
!macroend

; ============================================================================
; Macro: Custom Uninstallation
; ============================================================================

!macro customUnInstall
  ; Remove registry keys
  DeleteRegKey HKCU "Software\1132Fixer"
  ; Legacy key cleanup
  DeleteRegKey HKCU "Software\1132Eliminator"
!macroend
