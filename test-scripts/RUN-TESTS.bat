@echo off
REM ========================================
REM  1132 REMOVER - ONE-CLICK TEST RUNNER
REM ========================================
REM
REM This runs the FULLY AUTOMATED test matrix.
REM No interaction needed - just click and watch.
REM
REM Results are saved to: test-results\
REM ========================================

echo.
echo ========================================
echo   1132 REMOVER - AUTOMATED TEST SUITE
echo ========================================
echo.
echo This will run all tests automatically.
echo Make sure you have admin privileges.
echo.

REM Check for admin
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Administrator privileges required.
    echo.
    echo Right-click this file and select "Run as administrator"
    echo.
    pause
    exit /b 1
)

echo Running tests as administrator...
echo.

cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File "run-all-tests.ps1" -SkipConfirmation

echo.
echo Test run complete. Check the test-results folder for logs.
pause
