@echo off
setlocal enabledelayedexpansion

echo ============================================
echo  Zoom Profile Folder Junction Fix
echo  Links zoom folders to main user: %USERNAME%
echo ============================================
echo.

:: Kill Zoom first
echo Killing Zoom processes...
taskkill /F /IM Zoom.exe 2>nul
taskkill /F /IM ZoomWebHost.exe 2>nul
taskkill /F /IM CptHost.exe 2>nul
taskkill /F /IM CptService.exe 2>nul
timeout /t 2 >nul

set "MAIN_USER=%USERNAME%"
set "MAIN_PROFILE=C:\Users\%MAIN_USER%"
set "FOUND=0"

echo.
echo Scanning C:\Users\ for zoom folders...
echo.

:: Find and process all zoom-related folders in C:\Users
for /d %%D in (C:\Users\*zoom*) do (
    set "FOLDER=%%D"
    set "FOLDER_NAME=%%~nxD"

    :: Skip if it's somehow the main user folder
    if /i not "!FOLDER_NAME!"=="%MAIN_USER%" (
        set /a FOUND+=1
        echo FOUND: !FOLDER!
        echo   Linked to user: %MAIN_USER%

        :: Check if it's already a junction
        fsutil reparsepoint query "!FOLDER!" >nul 2>&1
        if !errorlevel!==0 (
            echo   Status: Already a junction link - skipping
        ) else (
            echo   Deleting folder...
            rmdir /s /q "!FOLDER!" 2>nul

            if exist "!FOLDER!" (
                echo   ERROR: Could not delete folder - may be in use
            ) else (
                echo   Creating junction to %MAIN_PROFILE%...
                mklink /J "!FOLDER!" "%MAIN_PROFILE%"

                if exist "!FOLDER!" (
                    echo   SUCCESS: Junction created
                ) else (
                    echo   ERROR: Failed to create junction
                )
            )
        )
        echo.
    )
)

if %FOUND%==0 (
    echo No zoom profile folders found in C:\Users\
    echo.
    echo Your system is clean!
)

echo.
echo ============================================
echo  Done! Found and processed %FOUND% folder(s)
echo ============================================
echo.
pause
