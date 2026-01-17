# Deep inspection of Zoom user-profile data

Write-Host "=== %APPDATA%\Zoom (Full Tree) ===" -ForegroundColor Cyan
$appdataZoom = "$env:APPDATA\Zoom"
if (Test-Path $appdataZoom) {
    Get-ChildItem -Path $appdataZoom -Recurse -Force -ErrorAction SilentlyContinue |
    Select-Object FullName, Length, LastWriteTime | Format-Table -AutoSize
} else {
    Write-Host "(folder does not exist)" -ForegroundColor Gray
}

Write-Host "`n=== %LOCALAPPDATA%\Zoom (Full Tree) ===" -ForegroundColor Cyan
$localZoom = "$env:LOCALAPPDATA\Zoom"
if (Test-Path $localZoom) {
    Get-ChildItem -Path $localZoom -Recurse -Force -ErrorAction SilentlyContinue |
    Select-Object FullName, Length, LastWriteTime | Format-Table -AutoSize
} else {
    Write-Host "(folder does not exist)" -ForegroundColor Gray
}

Write-Host "`n=== SQLite Journal Files (.db-wal, .db-shm) ===" -ForegroundColor Cyan
Get-ChildItem -Path "$env:APPDATA\Zoom" -Recurse -Force -Include "*.db-wal","*.db-shm","*.db-journal" -ErrorAction SilentlyContinue |
Select-Object FullName, Length | Format-Table -AutoSize

Write-Host "`n=== HKCU\Software\Zoom (All Values) ===" -ForegroundColor Cyan
if (Test-Path "HKCU:\Software\Zoom") {
    Get-ItemProperty -Path "HKCU:\Software\Zoom" -ErrorAction SilentlyContinue
    # Check subkeys
    Write-Host "`n  Subkeys:" -ForegroundColor Yellow
    Get-ChildItem -Path "HKCU:\Software\Zoom" -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "    $($_.PSPath)"
        Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "(key does not exist)" -ForegroundColor Gray
}

Write-Host "`n=== HKCU\Software\CptService ===" -ForegroundColor Cyan
if (Test-Path "HKCU:\Software\CptService") {
    Get-ItemProperty -Path "HKCU:\Software\CptService" | Format-List *
} else {
    Write-Host "(key does not exist)" -ForegroundColor Gray
}

Write-Host "`n=== zoomus.conf Contents ===" -ForegroundColor Cyan
$confPath = "$env:APPDATA\Zoom\data\zoomus.conf"
if (Test-Path $confPath) {
    Get-Content $confPath | Select-Object -First 50
    Write-Host "... (showing first 50 lines)"
} else {
    Write-Host "(file does not exist)" -ForegroundColor Gray
}

Write-Host "`n=== Zoom Credential Manager Entries ===" -ForegroundColor Cyan
cmdkey /list | Select-String -Pattern "zoom" -Context 0,2
