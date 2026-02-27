<#
Zoom-Diff.ps1
Compares two Zoom snapshot JSON files and outputs:
- Diff JSON
- Forensic comparison matrix (CSV + Markdown)

Usage:
  .\Zoom-Diff.ps1 -Before .\Snapshots\ZoomSnapshot_Before_*.json -After .\Snapshots\ZoomSnapshot_After_*.json
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Before,
  [Parameter(Mandatory=$true)][string]$After
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

function Load-Json($p) { Get-Content -LiteralPath $p -Raw | ConvertFrom-Json }

$B = Load-Json $Before
$A = Load-Json $After

$baseDir = Split-Path -Parent $PSCommandPath
$outDir = Join-Path $baseDir "Diff"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$ts = Get-Date -Format "yyyyMMdd_HHmmss"

$diffJson = Join-Path $outDir ("ZoomDiff_{0}.json" -f $ts)
$matrixCsv = Join-Path $outDir ("ZoomMatrix_{0}.csv" -f $ts)
$matrixMd  = Join-Path $outDir ("ZoomMatrix_{0}.md" -f $ts)

function As-Set($arr) {
  if ($null -eq $arr) { return @() }
  return @($arr) | ForEach-Object { "$_" } | Sort-Object -Unique
}

function Diff-Set($before,$after) {
  $b = As-Set $before
  $a = As-Set $after
  [pscustomobject]@{
    Added   = $a | Where-Object { $_ -notin $b }
    Removed = $b | Where-Object { $_ -notin $a }
    Kept    = $a | Where-Object { $_ -in $b }
  }
}

# Build diffs
$Diff = [ordered]@{
  Meta = [ordered]@{
    Before = $Before
    After  = $After
    Timestamp = (Get-Date).ToString("o")
  }
  MsiProducts = [ordered]@{
    Before = $B.MsiProducts
    After  = $A.MsiProducts
  }
  Sets = [ordered]@{
    RegistryKeys   = Diff-Set $B.Registry.Keys $A.Registry.Keys
    Folders        = Diff-Set $B.Paths.Folders $A.Paths.Folders
    Files          = Diff-Set $B.Paths.Files $A.Paths.Files
    PrefetchFiles  = Diff-Set $B.Paths.PrefetchFiles $A.Paths.PrefetchFiles
    Credentials    = Diff-Set $B.Credentials $A.Credentials
    FirewallRules  = Diff-Set ($B.FirewallRules | ForEach-Object {$_.DisplayName}) ($A.FirewallRules | ForEach-Object {$_.DisplayName})
    ScheduledTasks = Diff-Set (($B.ScheduledTasks | ForEach-Object { "$($_.TaskPath)$($_.TaskName)" })) (($A.ScheduledTasks | ForEach-Object { "$($_.TaskPath)$($_.TaskName)" }))
    Services       = Diff-Set (($B.Services | ForEach-Object {$_.Name})) (($A.Services | ForEach-Object {$_.Name}))
  }
}

($Diff | ConvertTo-Json -Depth 10) | Out-File -FilePath $diffJson -Encoding UTF8

# Forensic comparison matrix rows
$rows = New-Object System.Collections.Generic.List[object]
function Add-Row($Category,$Item,$BeforePresent,$AfterPresent,$Notes) {
  $rows.Add([pscustomobject]@{
    Category = $Category
    Item = $Item
    Before = $BeforePresent
    After  = $AfterPresent
    Notes  = $Notes
  }) | Out-Null
}

# Helper membership tests
$B_keys = As-Set $B.Registry.Keys
$A_keys = As-Set $A.Registry.Keys
$B_folders = As-Set $B.Paths.Folders
$A_folders = As-Set $A.Paths.Folders
$B_files = As-Set $B.Paths.Files
$A_files = As-Set $A.Paths.Files
$B_pref = As-Set $B.Paths.PrefetchFiles
$A_pref = As-Set $A.Paths.PrefetchFiles
$B_creds = As-Set $B.Credentials
$A_creds = As-Set $A.Credentials

$B_fw = As-Set ($B.FirewallRules | ForEach-Object {$_.DisplayName})
$A_fw = As-Set ($A.FirewallRules | ForEach-Object {$_.DisplayName})

$B_tasks = As-Set ($B.ScheduledTasks | ForEach-Object { "$($_.TaskPath)$($_.TaskName)" })
$A_tasks = As-Set ($A.ScheduledTasks | ForEach-Object { "$($_.TaskPath)$($_.TaskName)" })

$B_svcs = As-Set ($B.Services | ForEach-Object {$_.Name})
$A_svcs = As-Set ($A.Services | ForEach-Object {$_.Name})

# Add rows for each set item union
foreach ($item in ($B_keys + $A_keys | Sort-Object -Unique)) {
  Add-Row "RegistryKey" $item ($item -in $B_keys) ($item -in $A_keys) ""
}
foreach ($item in ($B_folders + $A_folders | Sort-Object -Unique)) {
  Add-Row "Folder" $item ($item -in $B_folders) ($item -in $A_folders) ""
}
foreach ($item in ($B_files + $A_files | Sort-Object -Unique)) {
  Add-Row "File" $item ($item -in $B_files) ($item -in $A_files) ""
}
foreach ($item in ($B_pref + $A_pref | Sort-Object -Unique)) {
  Add-Row "Prefetch" $item ($item -in $B_pref) ($item -in $A_pref) "Windows-managed; will reappear after execution."
}
foreach ($item in ($B_creds + $A_creds | Sort-Object -Unique)) {
  Add-Row "Credential" $item ($item -in $B_creds) ($item -in $A_creds) "Created after login/auth."
}
foreach ($item in ($B_fw + $A_fw | Sort-Object -Unique)) {
  Add-Row "FirewallRule" $item ($item -in $B_fw) ($item -in $A_fw) "Often re-created on install."
}
foreach ($item in ($B_tasks + $A_tasks | Sort-Object -Unique)) {
  Add-Row "ScheduledTask" $item ($item -in $B_tasks) ($item -in $A_tasks) "Update tasks may be enterprise/installer-dependent."
}
foreach ($item in ($B_svcs + $A_svcs | Sort-Object -Unique)) {
  Add-Row "Service" $item ($item -in $B_svcs) ($item -in $A_svcs) "CPT/Sharing service may be present on some builds."
}

# MSI products
foreach ($p in @($B.MsiProducts)) {
  Add-Row "MSIProduct" ("{0} {1} {2}" -f $p.DisplayName,$p.Version,$p.Guid) $true ($false) "Before snapshot MSI entry"
}
foreach ($p in @($A.MsiProducts)) {
  Add-Row "MSIProduct" ("{0} {1} {2}" -f $p.DisplayName,$p.Version,$p.Guid) ($false) $true "After snapshot MSI entry"
}

$rows | Export-Csv -NoTypeInformation -Path $matrixCsv -Encoding UTF8

# Markdown matrix
$md = New-Object System.Collections.Generic.List[string]
$md.Add("# Zoom Forensic Comparison Matrix") | Out-Null
$md.Add("") | Out-Null
$md.Add("Before: `$Before`") | Out-Null
$md.Add("After:  `$After`") | Out-Null
$md.Add("") | Out-Null
$md.Add("| Category | Item | Before | After | Notes |") | Out-Null
$md.Add("|---|---|---:|---:|---|") | Out-Null
foreach ($r in $rows) {
  $md.Add(("| {0} | {1} | {2} | {3} | {4} |" -f $r.Category, ($r.Item -replace '\|','\|'), ($r.Before -as [int]), ($r.After -as [int]), ($r.Notes -replace '\|','\|'))) | Out-Null
}
$md | Out-File -FilePath $matrixMd -Encoding UTF8

Write-Host "Diff saved:   $diffJson" -ForegroundColor Green
Write-Host "Matrix CSV:  $matrixCsv" -ForegroundColor Green
Write-Host "Matrix MD:   $matrixMd" -ForegroundColor Green
