@echo off
REM Pre-test cleanup: Empty recycle bin and clear temp files
REM Run this before each test for clean baseline

echo ========================================
echo  PRE-TEST CLEANUP
echo ========================================
echo.

echo [1/3] Emptying Recycle Bin...
powershell -Command "Clear-RecycleBin -Force -ErrorAction SilentlyContinue"
echo Done.

echo.
echo [2/3] Cleaning Zoom temp files...
if exist "%TEMP%\Zoom" rmdir /s /q "%TEMP%\Zoom" 2>nul
if exist "%TEMP%\zoomus" rmdir /s /q "%TEMP%\zoomus" 2>nul
if exist "%TEMP%\zoom_installer" rmdir /s /q "%TEMP%\zoom_installer" 2>nul
if exist "%TEMP%\ZoomInstaller" rmdir /s /q "%TEMP%\ZoomInstaller" 2>nul
if exist "%TEMP%\ZoomInstallerFull.msi" del /f /q "%TEMP%\ZoomInstallerFull.msi" 2>nul
echo Done.

echo.
echo [3/3] Cleaning test artifacts...
if exist "%TEMP%\1132-test-*" del /f /q "%TEMP%\1132-test-*" 2>nul
echo Done.

echo.
echo ========================================
echo  CLEANUP COMPLETE - Ready for testing
echo ========================================
pause
