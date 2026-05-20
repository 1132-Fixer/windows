@echo off
setlocal EnableDelayedExpansion

REM ============================================================
REM  Auto-elevate to Administrator
REM ============================================================
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -Command "Start-Process 'cmd.exe' -ArgumentList '/k \"%~f0\"' -Verb RunAs"
    exit /b
)

REM ============================================================
REM  Variables
REM ============================================================
set "username=user1"
set "password=user1"
set "zoomPath=C:\Program Files\Zoom\bin\Zoom.exe"
set "sourceProfile=C:\Users\user1"
set "currentUser=%USERPROFILE%"
set "currentDownloads=%currentUser%\Downloads"
set "sourceDownloads=%sourceProfile%\Downloads"

REM ============================================================
REM  PRE-CLEANUP: Remove any leftover suffixed profile folders
REM ============================================================
echo.
echo [PRE] Cleaning up leftover suffixed profile folders...
for /f "tokens=*" %%D in ('powershell -NoProfile -Command "Get-ChildItem 'C:\Users' | Where-Object{$_.Name -like '%username%.*'} | Select-Object -ExpandProperty FullName"') do (
    echo Removing: %%D
    rd /s /q "%%D" >nul 2>&1
)
echo Pre-cleanup done.

REM ============================================================
REM  STEP 1: Copy Downloads from user1 -> current user (skip dupes)
REM ============================================================
echo.
echo [1/5] Copying Downloads from %sourceDownloads% to %currentDownloads%...

if exist "%sourceDownloads%" (
    robocopy "%sourceDownloads%" "%currentDownloads%" /E /XC /XN /XO /NP /NFL /NDL /R:3 /W:5
    if !errorlevel! leq 7 (
        echo Done copying Downloads.
    ) else (
        echo WARNING: Some files may not have copied. Robocopy exit code: !errorlevel!
    )
) else (
    echo WARNING: Source Downloads folder not found at %sourceDownloads%. Skipping copy.
)

REM ============================================================
REM  STEP 2: Delete the old user1 profile folder
REM ============================================================
echo.
echo [2/5] Deleting profile folder: %sourceProfile%...

if exist "%sourceProfile%" (
    rd /s /q "%sourceProfile%"
    if errorlevel 1 (
        echo ERROR: Failed to delete %sourceProfile%. It may be in use.
        pause
        exit /b 1
    )
    echo Deleted %sourceProfile%.
) else (
    echo NOTE: %sourceProfile% does not exist. Nothing to delete.
)

REM ============================================================
REM  STEP 3: Capture old SID, delete user, wipe ALL stale registry
REM          entries and leftover folders, then recreate clean
REM ============================================================
echo.
echo [3/5] Removing existing user account '%username%' (if present)...

REM Grab SID BEFORE deleting
for /f "tokens=*" %%S in ('powershell -NoProfile -Command "try{(New-Object System.Security.Principal.NTAccount('%username%')).Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{''}"') do set "oldSID=%%S"

net user %username% /delete >nul 2>&1

REM Remove ALL stale ProfileList registry entries whose ProfileImagePath
REM contains the username
echo Cleaning all stale profile registry entries for '%username%'...
powershell -NoProfile -Command ^
    "Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList' | " ^
    "Where-Object { (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).ProfileImagePath -like '*%username%*' } | " ^
    "Remove-Item -Recurse -Force -ErrorAction SilentlyContinue"
echo Registry cleaned.

REM Remove any remaining leftover user1.MACHINENAME folders
for /f "tokens=*" %%D in ('powershell -NoProfile -Command "Get-ChildItem 'C:\Users' | Where-Object{$_.Name -like '%username%*' -and $_.Name -ne '%username%'} | Select-Object -ExpandProperty FullName"') do (
    echo Removing leftover folder: %%D
    rd /s /q "%%D" >nul 2>&1
)

echo Creating user '%username%'...
net user %username% %password% /add
if errorlevel 1 (
    echo ERROR: Failed to create user %username%.
    pause
    exit /b 1
)

echo Adding '%username%' to Administrators group...
net localgroup administrators %username% /add
if errorlevel 1 (
    echo ERROR: Failed to add %username% to administrators group.
    pause
    exit /b 1
)

echo User %username% created with password: %password%

REM ============================================================
REM  STEP 4: Copy all .gif files — skip junctions and system dirs
REM ============================================================
echo.
echo [4/5] Copying .gif files from current user to %username%'s profile...

set "newUserProfile=C:\Users\%username%"
echo Destination profile: %newUserProfile%

if not exist "%newUserProfile%" mkdir "%newUserProfile%"

for %%F in (Desktop Documents Downloads Pictures Videos Music) do (
    if exist "%currentUser%\%%F" (
        robocopy "%currentUser%\%%F" "%newUserProfile%\%%F" *.gif /S /XC /XN /XO /NP /NFL /NDL /R:3 /W:5 /XJ ^
            /XD "%currentUser%\Documents\My Music" ^
            /XD "%currentUser%\Documents\My Pictures" ^
            /XD "%currentUser%\Documents\My Videos"
        if !errorlevel! leq 7 (
            echo Copied .gif files from %%F
        ) else (
            echo WARNING: Issue copying from %%F - exit code !errorlevel!
        )
    )
)
echo Done copying .gif files.

REM ============================================================
REM  STEP 5: Launch Zoom as the new user
REM ============================================================
echo.
echo [5/5] Launching Zoom as %username%...

if exist "%zoomPath%" (
    runas /user:%username% "%zoomPath%"
) else (
    echo ERROR: Zoom not found at %zoomPath%.
    pause
    exit /b 1
)

echo.
echo All steps completed successfully.
pause