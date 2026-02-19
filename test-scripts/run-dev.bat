@echo off
REM Run app in development mode (no admin)
cd /d "%~dp0.."
npm run dev
pause
