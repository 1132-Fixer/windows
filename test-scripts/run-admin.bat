@echo off
REM Run app elevated (requires UAC prompt)
cd /d "%~dp0.."
powershell -Command "Start-Process -Verb RunAs -FilePath 'npm' -ArgumentList 'run','dev' -WorkingDirectory '%cd%'"
