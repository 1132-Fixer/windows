# Check Zoom processes, services, tasks, and firewall rules

Write-Host "=== 1. RUNNING PROCESSES ===" -ForegroundColor Cyan
Get-Process | Where-Object { $_.ProcessName -match "zoom|zupdater|cpt|airhost|cef|webview" } |
Select-Object ProcessName, Id, Path | Format-Table -AutoSize

Write-Host "`n=== 2. SERVICES ===" -ForegroundColor Cyan
Get-CimInstance Win32_Service |
Where-Object { $_.Name -match "zoom" -or $_.DisplayName -match "zoom" } |
Select-Object Name, DisplayName, State, PathName | Format-Table -AutoSize

Write-Host "`n=== 3. SCHEDULED TASKS ===" -ForegroundColor Cyan
Get-ScheduledTask |
Where-Object { $_.TaskName -match "zoom" -or $_.TaskPath -match "zoom" } |
Select-Object TaskName, TaskPath, State | Format-Table -AutoSize

Write-Host "`n=== 4. FIREWALL RULES ===" -ForegroundColor Cyan
Get-NetFirewallRule |
Where-Object { $_.DisplayName -match "zoom" -or $_.Description -match "zoom" } |
Select-Object DisplayName, Enabled, Direction, Action | Format-Table -AutoSize
