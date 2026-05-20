# Live mirror of the preflight PS that main.js builds and runs at runtime.
# Non-destructive: probes tools and reads service state only.
$tools = @('powershell.exe','taskkill.exe','robocopy.exe','icacls.exe','takeown.exe','net.exe','reg.exe','quser.exe','logoff.exe')
$r = @{}
foreach ($t in $tools) {
    try { $r[$t] = [bool](Get-Command $t -EA SilentlyContinue) } catch { $r[$t] = $false }
}
$svc = Get-Service seclogon -EA SilentlyContinue
if ($svc) {
    $r['seclogon_status']    = [string]$svc.Status
    $r['seclogon_starttype'] = [string]$svc.StartType
} else {
    $r['seclogon_status']    = 'MISSING'
    $r['seclogon_starttype'] = 'MISSING'
}
$r | ConvertTo-Json -Compress
