# Post-clean Zoom validation checklist

Write-Host "=== 4.1 RUNNING PROCESSES ===" -ForegroundColor Cyan
Get-Process | Where-Object { $_.ProcessName -match "zoom|cpt|airhost" } |
Select-Object ProcessName, Path | Format-Table -AutoSize

Write-Host "`n=== 4.2 SERVICES ===" -ForegroundColor Cyan
Get-CimInstance Win32_Service |
Where-Object { $_.Name -match "zoom" } |
Select-Object Name, DisplayName, State, PathName | Format-Table -AutoSize

Write-Host "`n=== 4.3 SCHEDULED TASKS ===" -ForegroundColor Cyan
$tasks = Get-ScheduledTask | Where-Object { $_.TaskName -match "Zoom" }
if ($tasks) {
    $tasks | ForEach-Object {
        Write-Host "Task: $($_.TaskName)" -ForegroundColor Yellow
        $_.Actions | Select-Object Execute, Arguments | Format-Table -AutoSize
    }
} else {
    Write-Host "(none)" -ForegroundColor Green
}

Write-Host "`n=== 4.4 FIREWALL RULES ===" -ForegroundColor Cyan
Get-NetFirewallRule |
Where-Object { $_.DisplayName -match "Zoom" } |
Get-NetFirewallApplicationFilter |
Select-Object Program | Format-Table -AutoSize

Write-Host "`n=== 4.5 FOLDER CHECK ===" -ForegroundColor Cyan
$paths = @(
    "C:\Program Files (x86)\Zoom",
    "C:\Program Files (x86)\Common Files\Zoom\Support",
    "$env:APPDATA\Zoom",
    "$env:LOCALAPPDATA\Zoom"
)
foreach ($p in $paths) {
    if (Test-Path $p) {
        Write-Host "[EXISTS] $p" -ForegroundColor Green
    } else {
        Write-Host "[MISSING] $p" -ForegroundColor Gray
    }
}
