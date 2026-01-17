@echo off
REM Test #6: Create a corrupt MSI file for testing failure handling
set TEMP_MSI=%TEMP%\ZoomInstallerFull.msi

echo ========================================
echo  TEST #6: Corrupt MSI Failure Test
echo ========================================
echo.

REM Clean recycle bin first
echo [1/2] Emptying Recycle Bin...
powershell -Command "Clear-RecycleBin -Force -ErrorAction SilentlyContinue"

REM Clean any existing MSI
if exist "%TEMP_MSI%" del /f /q "%TEMP_MSI%"

echo [2/2] Creating corrupt MSI at: %TEMP_MSI%
echo This is not a valid MSI file > "%TEMP_MSI%"

echo.
echo ========================================
echo  SETUP COMPLETE
echo ========================================
echo.
echo Now run the app with reinstall enabled.
echo Expected result:
echo   - Fast failure (low durationMs)
echo   - stderr captured in log
echo   - Clean exit with session summary
echo.
pause
