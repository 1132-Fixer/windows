$ErrorActionPreference = 'Continue'
Write-Host '=== Test machine context ==='
Write-Host ('Edition: ' + (Get-CimInstance Win32_OperatingSystem).Caption)
Write-Host ('Build:   ' + [Environment]::OSVersion.Version)
Write-Host ('User:    ' + $env:USERNAME)
$zoomOk = Test-Path 'C:\Program Files\Zoom\bin\Zoom.exe'
Write-Host ('Zoom:    ' + $(if ($zoomOk) { 'present at C:\Program Files\Zoom\bin\Zoom.exe' } else { 'MISSING' }))
Write-Host ''
Write-Host '=== Secondary Logon ==='
Get-Service seclogon | Format-List Name, Status, StartType
Write-Host '=== LanmanServer (required by net.exe session admin check) ==='
Get-Service LanmanServer | Format-List Name, Status, StartType

Write-Host '=== user1 starting state ==='
$sid = ''
try {
    $sid = (New-Object System.Security.Principal.NTAccount('user1')).Translate([System.Security.Principal.SecurityIdentifier]).Value
} catch {}
if ($sid) {
    Write-Host ('user1 SID:        ' + $sid)
    $key = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $sid
    Write-Host ('ProfileList key:  ' + $key)
    $pip = (Get-ItemProperty -Path $key -EA SilentlyContinue).ProfileImagePath
    Write-Host ('ProfileImagePath: ' + $(if ($pip) { $pip } else { '(none)' }))
    Write-Host ('C:\Users\user1:   ' + $(if (Test-Path 'C:\Users\user1') { 'exists' } else { 'absent' }))
    # NTUSER.DAT presence using File.Exists (doesn't throw on access denied)
    try {
        $ntu = [System.IO.File]::Exists('C:\Users\user1\NTUSER.DAT')
        Write-Host ('NTUSER.DAT readable: ' + $ntu)
    } catch {
        Write-Host ('NTUSER.DAT check threw: ' + $_.Exception.Message)
    }
} else {
    Write-Host 'user1 not present (NTAccount.Translate failed)'
}

Write-Host ''
Write-Host '=== Suffixed user1.* folders (if any) ==='
$suf = Get-ChildItem 'C:\Users' -Directory -Force -EA 0 | Where-Object { $_.Name -match '^user1\.' }
if ($suf) { $suf | Format-Table Name, FullName -AutoSize } else { Write-Host '(none)' }

Write-Host ''
Write-Host '=== Admins membership (user1?) ==='
try {
    $members = Get-LocalGroupMember -SID 'S-1-5-32-544' -EA Stop
    $members | Format-Table Name, SID -AutoSize
    $userIn = $false
    foreach ($m in $members) {
        if ($m.Name -ieq 'user1' -or $m.Name -like '*\user1' -or ($m.SID -and $m.SID.Value -eq $sid)) {
            $userIn = $true; break
        }
    }
    Write-Host ('user1 in Admins: ' + $userIn)
} catch {
    Write-Host ('Get-LocalGroupMember failed: ' + $_.Exception.Message)
}
