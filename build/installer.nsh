; CleanState Sentinel - Custom NSIS Installer Script
; This script provides custom installation options and professional UX

!include "MUI2.nsh"
!include "FileFunc.nsh"

; ============================================================================
; Installer Attributes
; ============================================================================

!define PRODUCT_NAME "CleanState Sentinel"
!define PRODUCT_PUBLISHER "High Texas"
!define PRODUCT_WEB_SITE "https://github.com/hightexas/cleanstate-sentinel"
!define PRODUCT_UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"

; ============================================================================
; Custom Page - Installation Options
; ============================================================================

Var PostRebootCheckbox
Var DesktopShortcutCheckbox
Var StartMenuCheckbox

; Custom page for installation options
Function customOptionsPage
  !insertmacro MUI_HEADER_TEXT "Installation Options" "Choose additional features for CleanState Sentinel"

  nsDialogs::Create 1018
  Pop $0

  ${If} $0 == error
    Abort
  ${EndIf}

  ; Information text
  ${NSD_CreateLabel} 0 0 100% 36u "CleanState Sentinel is a local forensic remediation platform. Select which optional features to enable during installation."
  Pop $0

  ; Desktop shortcut checkbox (checked by default)
  ${NSD_CreateCheckbox} 0 50u 100% 12u "Create desktop shortcut"
  Pop $DesktopShortcutCheckbox
  ${NSD_Check} $DesktopShortcutCheckbox

  ; Start menu checkbox (checked by default)
  ${NSD_CreateCheckbox} 0 66u 100% 12u "Create Start Menu entry"
  Pop $StartMenuCheckbox
  ${NSD_Check} $StartMenuCheckbox

  ; Divider
  ${NSD_CreateHLine} 0 90u 100% 1u
  Pop $0

  ; Advanced options label
  ${NSD_CreateLabel} 0 100u 100% 12u "Advanced Options (require administrative privileges when used):"
  Pop $0

  ; Post-reboot verification checkbox (unchecked by default)
  ${NSD_CreateCheckbox} 0 116u 100% 12u "Enable post-reboot verification support (creates scheduled task capability)"
  Pop $PostRebootCheckbox
  ; Unchecked by default - user must opt-in

  ; Note about elevation
  ${NSD_CreateLabel} 0 140u 100% 36u "Note: CleanState Sentinel will always request explicit consent before performing any privileged operations. No background services are installed."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function customOptionsPageLeave
  ; Save checkbox states to variables for use in installation
  ${NSD_GetState} $DesktopShortcutCheckbox $1
  ${NSD_GetState} $StartMenuCheckbox $2
  ${NSD_GetState} $PostRebootCheckbox $3

  ; Store in installer variables
  StrCpy $R1 $1 ; Desktop shortcut
  StrCpy $R2 $2 ; Start menu
  StrCpy $R3 $3 ; Post-reboot support
FunctionEnd

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
  ; Handle desktop shortcut based on user selection
  ${If} $R1 != ${BST_CHECKED}
    Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  ${EndIf}

  ; Handle start menu based on user selection
  ${If} $R2 != ${BST_CHECKED}
    RMDir /r "$SMPROGRAMS\${PRODUCT_NAME}"
  ${EndIf}

  ; Write post-reboot support flag if enabled
  ${If} $R3 == ${BST_CHECKED}
    WriteRegDWORD HKCU "Software\CleanStateSentinel" "PostRebootEnabled" 1
  ${Else}
    WriteRegDWORD HKCU "Software\CleanStateSentinel" "PostRebootEnabled" 0
  ${EndIf}

  ; Write install location for app reference
  WriteRegStr HKCU "Software\CleanStateSentinel" "InstallPath" "$INSTDIR"
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
  ; A separate "Remove all data" checkbox could be added if desired
!macroend

; ============================================================================
; Insert Custom Page
; ============================================================================

!macro customPageAfterDirectory
  Page custom customOptionsPage customOptionsPageLeave
!macroend
