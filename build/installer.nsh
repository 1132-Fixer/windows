; 1132 Eliminator - Custom NSIS Installer Script
; Zoom Error 1132 elimination tool

!include "MUI2.nsh"
!include "FileFunc.nsh"

; ============================================================================
; Custom Welcome Text
; ============================================================================

!define MUI_WELCOMEPAGE_TITLE "Welcome to 1132 Eliminator"
!define MUI_WELCOMEPAGE_TEXT "1132 Eliminator is a forensic-grade Zoom error elimination tool that purges all device fingerprints and Zoom artifacts to resolve Error 1132 device bans.$\r$\n$\r$\nKey Features:$\r$\n• Complete Zoom fingerprint purge$\r$\n• Registry and artifact elimination$\r$\n• Clean reinstall with hardened settings$\r$\n• Persistence monitoring$\r$\n$\r$\nAll operations occur locally on your device.$\r$\n$\r$\nClick Next to continue."

; ============================================================================
; Custom Finish Text
; ============================================================================

!define MUI_FINISHPAGE_TITLE "Installation Complete"
!define MUI_FINISHPAGE_TEXT "1132 Eliminator has been installed successfully.$\r$\n$\r$\nImportant: Some operations require administrative privileges. 1132 Eliminator will always request explicit consent before performing privileged actions.$\r$\n$\r$\nClick Finish to exit the installer."

; ============================================================================
; Macro: Custom Installation Section
; ============================================================================

!macro customInstall
  ; Write install location for app reference
  WriteRegStr HKCU "Software\1132Eliminator" "InstallPath" "$INSTDIR"
  WriteRegDWORD HKCU "Software\1132Eliminator" "PostRebootEnabled" 0
!macroend

; ============================================================================
; Macro: Custom Uninstallation
; ============================================================================

!macro customUnInstall
  ; Remove scheduled tasks created by the app
  nsExec::ExecToLog 'schtasks /Delete /TN "\1132Eliminator\1132Eliminator_PostRebootVerify_*" /F'
  nsExec::ExecToLog 'schtasks /Delete /TN "\1132Eliminator\1132Eliminator_Monitor" /F'

  ; Remove task folder if empty
  nsExec::ExecToLog 'schtasks /Delete /TN "\1132Eliminator" /F'

  ; Remove registry keys (not app data - user may want to preserve reports)
  DeleteRegKey HKCU "Software\1132Eliminator"

  ; Note: We deliberately do NOT delete %LOCALAPPDATA%\1132Eliminator
  ; User's reports and session data should be preserved
!macroend
