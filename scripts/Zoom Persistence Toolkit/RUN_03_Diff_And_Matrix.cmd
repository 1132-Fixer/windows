@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process powershell.exe -Verb RunAs -WindowStyle Normal -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-Command','Set-Location '%~dp0'; $b=(Get-ChildItem .\Snapshots\ZoomSnapshot_Before_*.json | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName; $a=(Get-ChildItem .\Snapshots\ZoomSnapshot_After_*.json | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName; .\Zoom-Diff.ps1 -Before $b -After $a')"
echo Launched. Approve UAC and use the NEW PowerShell window.
pause
endlocal
