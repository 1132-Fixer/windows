@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process powershell.exe -Verb RunAs -WindowStyle Normal -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-Command','Set-Location '%~dp0'; .\Zoom-Snapshot.ps1 -Label 'After'')"
echo Launched. Approve UAC and use the NEW PowerShell window.
pause
endlocal
