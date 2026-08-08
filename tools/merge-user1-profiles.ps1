#requires -RunAsAdministrator
# Merge stale user1 profile folders into canonical C:\Users\user1, then clean up.
# Run from elevated PowerShell.

[CmdletBinding()]
param(
    [string]$Canonical = 'C:\Users\user1',
    [string[]]$Stragglers = @(
        'C:\Users\user1.DESKTOP-71EGFND',
        'C:\Users\TEMP.DESKTOP-71EGFND.002'
    ),
    [string]$LogPath = "$env:TEMP\user1-merge.log"
)

$ErrorActionPreference = 'Continue'

function Write-Section($t) {
    Write-Host ''
    Write-Host ('=' * 70) -ForegroundColor Cyan
    Write-Host $t -ForegroundColor Cyan
    Write-Host ('=' * 70) -ForegroundColor Cyan
}

# Junction-safe recursive listing (W4-HANG): Windows PowerShell 5.1's
# Get-ChildItem -Recurse FOLLOWS directory reparse points, and default
# profiles contain cyclic ones (AppData\Local\Application Data ->
# AppData\Local), so a plain -Recurse over a profile can loop forever — and
# worse, treat junction TARGETS as if they lived inside the profile. Walks
# without entering reparse points; the reparse-point entries themselves are
# still returned.
function Get-ProfileItemsNoReparse([string]$Root) {
    $out = New-Object System.Collections.Generic.List[object]
    $stack = New-Object System.Collections.Generic.Stack[string]
    $stack.Push($Root)
    while ($stack.Count -gt 0) {
        $dir = $stack.Pop()
        foreach ($it in @(Get-ChildItem -LiteralPath $dir -Force -EA 0)) {
            $out.Add($it)
            if ($it.PSIsContainer -and (($it.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)) {
                $stack.Push($it.FullName)
            }
        }
    }
    return ,$out
}

function Get-FolderSizeMB($path) {
    try {
        $sum = (Get-ProfileItemsNoReparse $path | Where-Object { -not $_.PSIsContainer } |
                Measure-Object Length -Sum).Sum
        if ($null -eq $sum) { return '0.0' }
        return '{0:N1}' -f ($sum / 1MB)
    } catch { return '?' }
}

# ===== STEP 1: Inventory ====================================================
Write-Section 'STEP 1: Inventory'
foreach ($p in @($Canonical) + $Stragglers) {
    if (-not (Test-Path $p)) {
        Write-Host "MISSING: $p" -ForegroundColor Yellow
        continue
    }
    Write-Host ''
    Write-Host "--- $p ---"
    $rows = foreach ($entry in (Get-ChildItem $p -Force -EA 0)) {
        $size = if ($entry.PSIsContainer) { Get-FolderSizeMB $entry.FullName }
                else { '{0:N2}' -f ($entry.Length / 1MB) }
        [PSCustomObject]@{
            Name          = $entry.Name
            LastWriteTime = $entry.LastWriteTime
            SizeMB        = $size
        }
    }
    $rows | Format-Table -AutoSize
}

# ===== STEP 2: Confirm no live holders ======================================
Write-Section 'STEP 2: Verify no live user1 holders'
$procs = Get-Process -IncludeUserName -EA 0 | Where-Object { $_.UserName -like '*\user1' }
if ($procs) {
    Write-Host 'LIVE user1 processes found - aborting:' -ForegroundColor Red
    $procs | Select-Object Name, Id, UserName | Format-Table -AutoSize
    throw 'Kill user1 processes before re-running.'
}
$loadedHives = Get-ChildItem 'Registry::HKEY_USERS' | Where-Object { $_.Name -match '1098' }
if ($loadedHives) {
    Write-Host 'HKU\<1098> hive still loaded - aborting:' -ForegroundColor Red
    $loadedHives | Format-Table -AutoSize
    throw 'Unload HKU\<1098> (or reboot) before re-running.'
}
Write-Host 'OK: no live user1 processes, no loaded SID-1098 hive.' -ForegroundColor Green

# ===== STEP 3: Additive merge ===============================================
Write-Section 'STEP 3: Additive merge into canonical'
if (Test-Path $LogPath) { Remove-Item $LogPath -Force }

$hiveExcl = @(
    'NTUSER.DAT*', 'UsrClass.dat*', 'ntuser.ini', 'ntuser.dat.LOG*',
    'UsrClass.dat.LOG*', '*.regtrans-ms', '*.blf'
)

foreach ($src in $Stragglers) {
    if (-not (Test-Path $src)) {
        Write-Host "Skip (missing): $src"
        continue
    }
    Write-Host "Merging  $src  ->  $Canonical"
    # /E include subdirs; /COPY:DT data+time only; /XJ skip junctions;
    # /XO newest-wins additive; /XF skip hives; /R:1 /W:1 fail fast.
    & robocopy.exe $src $Canonical /E /COPY:DT /XJ /XO /XF $hiveExcl /R:1 /W:1 /NP /NDL /NJH /NJS /LOG+:$LogPath
    $rc = $LASTEXITCODE
    if ($rc -ge 8) {
        Write-Host "  robocopy failed (exit $rc) - see $LogPath" -ForegroundColor Red
    } else {
        Write-Host "  robocopy OK (exit $rc)" -ForegroundColor Green
    }
}
Write-Host ''
Write-Host "Merge log: $LogPath"

# ===== STEP 4: Spot-check data folders ======================================
Write-Section 'STEP 4: Spot-check'
$checks = 'Desktop', 'Documents', 'Downloads', 'Pictures', 'AppData\Roaming\Zoom', 'AppData\Local\Zoom'
foreach ($sub in $checks) {
    Write-Host ''
    Write-Host $sub
    foreach ($p in @($Canonical) + $Stragglers) {
        $f = Join-Path $p $sub
        if (-not (Test-Path $f)) { continue }
        $files = @(Get-ProfileItemsNoReparse $f | Where-Object { -not $_.PSIsContainer })
        $count = $files.Count
        $sumBytes = ($files | Measure-Object Length -Sum).Sum
        $size = '{0:N1}' -f ((@($sumBytes, 0) | Select-Object -First 1) / 1MB)
        '  {0,-55} files={1,-6} sizeMB={2}' -f $f, $count, $size
    }
}

# ===== STEP 5: Remove stragglers ============================================
Write-Section 'STEP 5: Remove stragglers'

$csharp = '[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true, CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern bool MoveFileEx(string lpExistingFileName, string lpNewFileName, int dwFlags);'
if (-not ('W.N' -as [type])) {
    Add-Type -Namespace 'W' -Name 'N' -MemberDefinition $csharp
}

foreach ($p in $Stragglers) {
    if (-not (Test-Path $p)) {
        Write-Host "Already gone: $p"
        continue
    }
    Write-Host ''
    Write-Host "Removing $p"
    try {
        # Delete reparse points first (junction entry only, never the target):
        # PS 5.1's Remove-Item -Recurse follows junctions, and a profile
        # junction can point outside the straggler being removed.
        Get-ProfileItemsNoReparse $p |
            Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 } |
            ForEach-Object {
                try {
                    if ($_.PSIsContainer) { [System.IO.Directory]::Delete($_.FullName, $false) }
                    else { [System.IO.File]::Delete($_.FullName) }
                } catch {}
            }
        Remove-Item $p -Recurse -Force -EA Stop
        Write-Host '  REMOVED' -ForegroundColor Green
    } catch {
        Write-Host "  LOCKED - scheduling reboot-time delete: $($_.Exception.Message)" -ForegroundColor Yellow
        $all = Get-ProfileItemsNoReparse $p
        $all | Where-Object { -not $_.PSIsContainer } | ForEach-Object {
            [W.N]::MoveFileEx($_.FullName, $null, 4) | Out-Null
        }
        $all | Where-Object { $_.PSIsContainer } | Sort-Object FullName -Descending | ForEach-Object {
            [W.N]::MoveFileEx($_.FullName, $null, 4) | Out-Null
        }
        [W.N]::MoveFileEx($p, $null, 4) | Out-Null
        Write-Host '  Pending-delete scheduled. Reboot to finalize.' -ForegroundColor Yellow
    }
}

# ===== STEP 6: Final verify =================================================
Write-Section 'STEP 6: Final verify'
Write-Host ''
Write-Host 'C:\Users entries:'
Get-ChildItem 'C:\Users' -Force | Select-Object Name, LastWriteTime | Format-Table -AutoSize

Write-Host 'Win32_UserProfile:'
Get-CimInstance Win32_UserProfile | Select-Object LocalPath, SID, Status, Loaded | Format-Table -AutoSize

Write-Host 'ProfileList registry:'
Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList' | ForEach-Object {
    [PSCustomObject]@{
        SID   = $_.PSChildName
        Path  = (Get-ItemProperty $_.PSPath -EA 0).ProfileImagePath
        State = (Get-ItemProperty $_.PSPath -EA 0).State
    }
} | Format-Table -AutoSize

Write-Section 'DONE'
$pfro = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -EA 0).PendingFileRenameOperations
Write-Host 'PendingFileRenameOperations (deleted on next reboot):'
if ($pfro) {
    $real = $pfro | Where-Object { $_ -and $_ -notmatch '^$' }
    $real | Select-Object -First 30 | ForEach-Object { "  $_" }
    if ($real.Count -gt 30) { Write-Host ('  ... ({0} total entries)' -f $real.Count) }
} else {
    Write-Host '  (none)'
}
