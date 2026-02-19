; CleanState Sentinel - Custom NSIS Installer Script
; This script provides custom installation options and professional UX

!include "MUI2.nsh"
!include "FileFunc.nsh"

; ============================================================================
; Custom Welcome Text
; ============================================================================

!define MUI_WELCOMEPAGE_TITLE "Welcome to CleanState Sentinel"
!define MUI_WELCOMEPAGE_TEXT "CleanState Sentinel is a forensic-grade software remediation platform for inspecting, cleaning, and verifying Windows systems.$\r$\n$\r$\nKey Features:$\r$\n• Read-only system discovery$\r$\n• Auditable remediation with rollback$\r$\n• Post-reboot verification$\r$\n• Attestation reporting$\r$\n$\r$\nNo system data is transmitted. All analysis and remediation occurs locally on your device.$\r$\n$\r$\nClick Next to continue."

; ============================================================================
; Custom Finish Text
; ============================================================================

!define MUI_FINISHPAGE_TITLE "Installation Complete"
!define MUI_FINISHPAGE_TEXT "CleanState Sentinel has been installed successfully.$\r$\n$\r$\nImportant: Some remediation and verification features require administrative privileges when used. CleanState Sentinel will always request explicit consent before performing such actions.$\r$\n$\r$\nClick Finish to exit the installer."

; ============================================================================
; Macro: Custom Installation Section
; ============================================================================

!macro customInstall
  ; Write install location for app reference
  WriteRegStr HKCU "Software\CleanStateSentinel" "InstallPath" "$INSTDIR"
  WriteRegDWORD HKCU "Software\CleanStateSentinel" "PostRebootEnabled" 0
!macroend

; ============================================================================
; Macro: Custom Uninstallation
; ============================================================================

!macro customUnInstall
  ; Remove scheduled tasks created by the app
  nsExec::ExecToLog 'schtasks /Delete /TN "\CleanStateSentinel\CleanStateSentinel_PostRebootVerify_*" /F'
  nsExec::ExecToLog 'schtasks /Delete /TN "\CleanStateSentinel\CleanStateSentinel_Monitor" /F'

  ; Remove task folder if empty
  nsExec::ExecToLog 'schtasks /Delete /TN "\CleanStateSentinel" /F'

  ; Remove registry keys (not app data - user may want to preserve reports)
  DeleteRegKey HKCU "Software\CleanStateSentinel"

  ; Note: We deliberately do NOT delete %LOCALAPPDATA%\CleanStateSentinel
  ; User's reports and session data should be preserved
!macroend
