@echo off
setlocal
cd /d "%~dp0"
REM Dry run: preview only (no deletions)
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process powershell.exe -Verb RunAs -WindowStyle Normal -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-File','%~dp0Zoom-Toolkit.ps1','-DoAll','-WhatIf')"
echo Launched. Approve UAC and use the NEW PowerShell window.
pause
endlocal
