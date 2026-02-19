@echo off
REM Run the built setup installer
cd /d "%~dp0.."
if exist "dist\1132 Remover Setup.exe" (
    echo Launching installer...
    start "" "dist\1132 Remover Setup.exe"
) else (
    echo ERROR: Setup not found. Run 'npm run build:installer' first.
)
pause
