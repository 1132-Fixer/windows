@echo off
setlocal
cd /d "%~dp0"
REM MSI cleanup + deep wipe + reinstall clean (downloads latest Zoom MSI and installs)
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process powershell.exe -Verb RunAs -WindowStyle Normal -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-File','%~dp0Zoom-Toolkit.ps1','-DoAll','-Reinstall')"
echo Launched. Approve UAC and use the NEW PowerShell window.
pause
endlocal
