@echo off
REM Create a test scheduled task in \Zoom\ folder for Test #3
REM Must run as admin

echo ========================================
echo  TEST #3: Foldered Scheduled Task Test
echo ========================================
echo.

REM Clean recycle bin first
echo [1/3] Emptying Recycle Bin...
powershell -Command "Clear-RecycleBin -Force -ErrorAction SilentlyContinue"

REM Clean temp files
echo [2/3] Cleaning temp files...
if exist "%TEMP%\Zoom" rmdir /s /q "%TEMP%\Zoom" 2>nul
if exist "%TEMP%\ZoomInstallerFull.msi" del /f /q "%TEMP%\ZoomInstallerFull.msi" 2>nul

echo [3/3] Creating test scheduled task: \Zoom\ZoomGifCollector
schtasks /create /tn "\Zoom\ZoomGifCollector" /tr "notepad.exe" /sc daily /st 12:00 /f
if %errorlevel% equ 0 (
    echo.
    echo ========================================
    echo  SUCCESS: Task created
    echo ========================================
    schtasks /query /tn "\Zoom\ZoomGifCollector"
    echo.
    echo Now run the app cleanup and verify:
    echo   - Task discovered via TaskPath
    echo   - Deletion attempt logged
    echo   - WARN only if blocked
) else (
    echo.
    echo ========================================
    echo  FAILED: Run this script as administrator
    echo ========================================
)
pause
