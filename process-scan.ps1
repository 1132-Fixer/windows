# Deep Process & Alias Scanner for Zoom
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  DEEP SCAN: ZOOM PROCESSES & ALIASES      " -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan

# === ZOOM EXECUTABLES ===
Write-Host "`n=== ZOOM EXECUTABLES (C:\Program Files\Zoom\bin) ===" -ForegroundColor Yellow
Get-ChildItem "C:\Program Files\Zoom\bin" -Filter "*.exe" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  $($_.Name)" -ForegroundColor Green
}

Write-Host "`n=== COMMON FILES EXECUTABLES ===" -ForegroundColor Yellow
Get-ChildItem "C:\Program Files\Common Files\Zoom" -Recurse -Filter "*.exe" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  $($_.Name) - $($_.FullName)" -ForegroundColor Green
}

# === RUNNING PROCESSES ===
Write-Host "`n=== RUNNING ZOOM PROCESSES ===" -ForegroundColor Yellow
$zoomProcs = @("Zoom", "ZoomWebHost", "CptHost", "CptService", "airhost", "aomhost64",
               "zCrashReport", "zCrashReport64", "ZoomDocConverter", "ZoomHybridConf",
               "ZoomOutlookIMPlugin", "Zoom_launcher", "zSafeChecker", "zTscoder",
               "zUpdater", "zWebview2Agent", "ZoomOutlookMAPI", "CptControl", "CptInstall")
foreach ($proc in $zoomProcs) {
    $running = Get-Process -Name $proc -ErrorAction SilentlyContinue
    if ($running) {
        Write-Host "  RUNNING: $proc (PID: $($running.Id))" -ForegroundColor Red
    }
}

# === SERVICES ===
Write-Host "`n=== ZOOM SERVICES ===" -ForegroundColor Yellow
$services = Get-Service -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -like "*Zoom*" -or $_.Name -like "*Cpt*" -or $_.DisplayName -like "*Zoom*"
}
if ($services) {
    $services | ForEach-Object {
        Write-Host "  $($_.Name) - $($_.DisplayName) [$($_.Status)]" -ForegroundColor Green
    }
} else {
    Write-Host "  No Zoom services found" -ForegroundColor Gray
}

# === STARTUP PROGRAMS ===
Write-Host "`n=== STARTUP ENTRIES ===" -ForegroundColor Yellow
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
if (Test-Path $runKey) {
    $props = Get-ItemProperty $runKey
    $props.PSObject.Properties | Where-Object { $_.Value -like "*zoom*" -or $_.Value -like "*cpt*" } | ForEach-Object {
        Write-Host "  $($_.Name): $($_.Value)" -ForegroundColor Green
    }
}
$runKeyLM = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run"
if (Test-Path $runKeyLM) {
    $props = Get-ItemProperty $runKeyLM
    $props.PSObject.Properties | Where-Object { $_.Value -like "*zoom*" -or $_.Value -like "*cpt*" } | ForEach-Object {
        Write-Host "  $($_.Name): $($_.Value)" -ForegroundColor Green
    }
}

# === PROTOCOL HANDLERS ===
Write-Host "`n=== PROTOCOL HANDLERS ===" -ForegroundColor Yellow
$protocols = @("zoommtg", "zoomus", "zoomphonecall", "zoomrc", "zoomlocal", "zoompbx")
foreach ($proto in $protocols) {
    if (Test-Path "HKCU:\Software\Classes\$proto") {
        Write-Host "  FOUND: ${proto}://" -ForegroundColor Green
    }
    if (Test-Path "HKLM:\Software\Classes\$proto") {
        Write-Host "  FOUND: ${proto}:// (HKLM)" -ForegroundColor Green
    }
}

# === DLL FILES ===
Write-Host "`n=== ZOOM DLL FILES ===" -ForegroundColor Yellow
$dllCount = (Get-ChildItem "C:\Program Files\Zoom" -Recurse -Filter "*.dll" -ErrorAction SilentlyContinue).Count
Write-Host "  Total DLLs in Zoom folder: $dllCount" -ForegroundColor Green

# Key DLLs
$keyDlls = @("CptControl.dll", "CptCore.dll", "libcef.dll", "avcoding.dll", "audiohook.dll",
             "zbookmark.dll", "zzhost.dll", "zmmeetingres.dll", "zWebView2Loader.dll")
foreach ($dll in $keyDlls) {
    $found = Get-ChildItem "C:\Program Files\Zoom" -Recurse -Filter $dll -ErrorAction SilentlyContinue
    if ($found) {
        Write-Host "  $dll" -ForegroundColor Green
    }
}

# === DRIVERS ===
Write-Host "`n=== ZOOM DRIVERS ===" -ForegroundColor Yellow
Get-ChildItem "C:\Windows\System32\drivers" -Filter "*zoom*" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  $($_.Name)" -ForegroundColor Green
}
Get-ChildItem "C:\Windows\System32\drivers" -Filter "*cpt*" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  $($_.Name)" -ForegroundColor Green
}

# === VIRTUAL AUDIO/VIDEO DEVICES ===
Write-Host "`n=== ZOOM VIRTUAL DEVICES ===" -ForegroundColor Yellow
Get-PnpDevice -FriendlyName "*zoom*" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  $($_.FriendlyName) [$($_.Status)]" -ForegroundColor Green
}

# === COM OBJECTS ===
Write-Host "`n=== COM REGISTRATIONS ===" -ForegroundColor Yellow
Get-ChildItem "HKLM:\Software\Classes\CLSID" -ErrorAction SilentlyContinue | ForEach-Object {
    $default = (Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue).'(default)'
    if ($default -like "*zoom*") {
        Write-Host "  $default" -ForegroundColor Green
    }
}

# === SHELL EXTENSIONS ===
Write-Host "`n=== CONTEXT MENU / SHELL EXTENSIONS ===" -ForegroundColor Yellow
$shellExts = @(
    "HKLM:\Software\Classes\*\shellex\ContextMenuHandlers",
    "HKLM:\Software\Classes\Directory\shellex\ContextMenuHandlers",
    "HKCU:\Software\Classes\*\shellex\ContextMenuHandlers"
)
foreach ($ext in $shellExts) {
    if (Test-Path $ext) {
        Get-ChildItem $ext -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "*zoom*" } | ForEach-Object {
            Write-Host "  $($_.Name)" -ForegroundColor Green
        }
    }
}

# === BROWSER EXTENSIONS ===
Write-Host "`n=== BROWSER EXTENSION DATA ===" -ForegroundColor Yellow
$chromeExt = "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Extensions"
if (Test-Path $chromeExt) {
    Get-ChildItem $chromeExt -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $manifest = Join-Path $_.FullName "*\manifest.json"
        $content = Get-Content $manifest -Raw -ErrorAction SilentlyContinue
        if ($content -like "*zoom*") {
            Write-Host "  Chrome extension: $($_.Name)" -ForegroundColor Green
        }
    }
}

# === OFFICE ADDINS ===
Write-Host "`n=== OFFICE ADD-INS ===" -ForegroundColor Yellow
$outlookAddins = "HKCU:\Software\Microsoft\Office\Outlook\Addins"
if (Test-Path $outlookAddins) {
    Get-ChildItem $outlookAddins -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "*zoom*" } | ForEach-Object {
        Write-Host "  Outlook: $($_.Name)" -ForegroundColor Green
    }
}

# === NETWORK ===
Write-Host "`n=== NETWORK ENTRIES ===" -ForegroundColor Yellow
# Hosts file
$hosts = Get-Content "C:\Windows\System32\drivers\etc\hosts" -ErrorAction SilentlyContinue
$zoomHosts = $hosts | Where-Object { $_ -like "*zoom*" }
if ($zoomHosts) {
    Write-Host "  Hosts file entries:" -ForegroundColor Green
    $zoomHosts | ForEach-Object { Write-Host "    $_" }
}

# === SUMMARY ===
Write-Host "`n============================================" -ForegroundColor Cyan
Write-Host "           EXECUTABLE ALIAS LIST           " -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Main Zoom Processes:" -ForegroundColor White
Write-Host "  - Zoom.exe (main app)" -ForegroundColor Gray
Write-Host "  - Zoom_launcher.exe (launcher)" -ForegroundColor Gray
Write-Host "  - airhost.exe (screen sharing)" -ForegroundColor Gray
Write-Host "  - aomhost64.exe (audio optimization)" -ForegroundColor Gray
Write-Host ""
Write-Host "CPT (Companion) Processes:" -ForegroundColor White
Write-Host "  - CptHost.exe (device fingerprint host)" -ForegroundColor Gray
Write-Host "  - CptService.exe (background service)" -ForegroundColor Gray
Write-Host "  - CptControl.exe (control interface)" -ForegroundColor Gray
Write-Host "  - CptInstall.exe (installer)" -ForegroundColor Gray
Write-Host ""
Write-Host "Utility Processes:" -ForegroundColor White
Write-Host "  - zUpdater.exe (auto-update)" -ForegroundColor Gray
Write-Host "  - zCrashReport.exe (crash reporter)" -ForegroundColor Gray
Write-Host "  - zWebview2Agent.exe (browser component)" -ForegroundColor Gray
Write-Host "  - zTscoder.exe (transcoder)" -ForegroundColor Gray
Write-Host "  - zSafeChecker.exe (security check)" -ForegroundColor Gray
Write-Host "  - ZoomDocConverter.exe (document converter)" -ForegroundColor Gray
Write-Host ""
Write-Host "Office Integration:" -ForegroundColor White
Write-Host "  - ZoomOutlookIMPlugin.exe (Outlook plugin)" -ForegroundColor Gray
Write-Host "  - ZoomOutlookMAPI.exe (MAPI integration)" -ForegroundColor Gray
Write-Host "  - ZoomHybridConf.exe (hybrid conferencing)" -ForegroundColor Gray
Write-Host ""
