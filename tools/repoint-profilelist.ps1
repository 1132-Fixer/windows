#requires -RunAsAdministrator
# Repoint SID-1098 ProfileImagePath to canonical C:\Users\user1.

$sid = 'S-1-5-21-3871918341-4223071879-2733581169-1098'
$base = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList'
$key = Join-Path $base $sid

Write-Host "Key path: $key"
Write-Host ''
Write-Host 'Subkeys under ProfileList that look like SID-1098 (incl. junk):'
Get-ChildItem $base | Where-Object { $_.PSChildName -like "*1098*" } |
    ForEach-Object {
        [PSCustomObject]@{
            Name             = $_.PSChildName
            ProfileImagePath = (Get-ItemProperty $_.PSPath -EA 0).ProfileImagePath
            State            = (Get-ItemProperty $_.PSPath -EA 0).State
        }
    } | Format-Table -AutoSize

if (-not (Test-Path $key)) {
    Write-Host "Target key MISSING: $key" -ForegroundColor Red
    return
}

Write-Host 'Before:'
Get-ItemProperty $key | Select-Object ProfileImagePath, State, Flags, RefCount | Format-List

Set-ItemProperty -Path $key -Name ProfileImagePath -Value 'C:\Users\user1' -Type ExpandString -Force

Write-Host 'After:'
Get-ItemProperty $key | Select-Object ProfileImagePath, State, Flags, RefCount | Format-List

Write-Host ''
Write-Host 'Cleanup: removing any spurious *1098* subkeys with empty ProfileImagePath...'
Get-ChildItem $base | Where-Object {
    $_.PSChildName -like "*1098*" -and $_.PSChildName -ne $sid
} | ForEach-Object {
    $p = (Get-ItemProperty $_.PSPath -EA 0).ProfileImagePath
    # Only delete keys whose ProfileImagePath is EMPTY (the stated intent).
    # The original code read $p but never tested it, so it hard-deleted every
    # *1098* key that wasn't exactly $sid — including legitimate profile
    # registrations with a valid non-empty path.
    if ([string]::IsNullOrWhiteSpace($p)) {
        Write-Host "  Found spurious (empty ProfileImagePath): $($_.PSChildName)"
        Remove-Item $_.PSPath -Recurse -Force
        Write-Host "    REMOVED"
    } else {
        Write-Host "  Keeping $($_.PSChildName)  ->  ProfileImagePath='$p' (non-empty)"
    }
}

Write-Host ''
Write-Host 'Final ProfileList:'
Get-ChildItem $base | ForEach-Object {
    [PSCustomObject]@{
        SID   = $_.PSChildName
        Path  = (Get-ItemProperty $_.PSPath -EA 0).ProfileImagePath
        State = (Get-ItemProperty $_.PSPath -EA 0).State
    }
} | Format-Table -AutoSize
