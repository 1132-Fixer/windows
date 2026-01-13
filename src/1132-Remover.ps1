<#
.SYNOPSIS
  1132 Remover — Audit → Consolidate → Cleanup (safe by default)

.DESCRIPTION
  - Audit: read-only scan + report
  - Consolidate: copies Required items into a consolidated directory under FinalRoot
  - Cleanup: moves CandidateRemove items into quarantine (reversible)
  - Full: Consolidate + Cleanup; can also delete quarantined items if -ForceDelete is supplied

  No registry edits. Conservative exclusions for system folders unless allowlisted.

.PARAMETER Mode
  Audit (default), Consolidate, Cleanup, Full

.PARAMETER ConfigPath
  Path to config.json

.PARAMETER ForceDelete
  If set with Mode Full, permanently deletes quarantined items for the current run.

.PARAMETER WhatIf
  Standard PowerShell WhatIf behavior for any potentially-changing operation.

.EXAMPLE
  .\1132-Remover.ps1 -Mode Audit

.EXAMPLE
  .\1132-Remover.ps1 -Mode Consolidate

.EXAMPLE
  .\1132-Remover.ps1 -Mode Full -ForceDelete
#>

[CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact='High')]
param(
  [ValidateSet("Audit","Consolidate","Cleanup","Full")]
  [string]$Mode = "Audit",

  [string]$ConfigPath = "$(Join-Path $PSScriptRoot '..\config.json')",

  [switch]$ForceDelete
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Read-Config([string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) { throw "Config not found: $Path" }
  return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}

function New-RunContext($cfg) {
  $ts = (Get-Date).ToString("yyyyMMdd_HHmmss")
  $ctx = [ordered]@{
    Timestamp = $ts
    LogDir = Join-Path $cfg.LogRoot $ts
    QuarantineDir = Join-Path $cfg.QuarantineRoot $ts
    ConsolidatedDir = Join-Path (Join-Path $cfg.FinalRoot $cfg.ConsolidatedSubdir) $ts
    ActionsLog = $null
    AuditCsv = $null
    SummaryTxt = $null
  }
  New-Item -ItemType Directory -Force -Path $ctx.LogDir | Out-Null
  New-Item -ItemType Directory -Force -Path $ctx.QuarantineDir | Out-Null
  New-Item -ItemType Directory -Force -Path $ctx.ConsolidatedDir | Out-Null

  $ctx.ActionsLog = Join-Path $ctx.LogDir "actions.log"
  $ctx.AuditCsv   = Join-Path $ctx.LogDir "audit.csv"
  $ctx.SummaryTxt = Join-Path $ctx.LogDir "summary.txt"
  return [pscustomobject]$ctx
}

function Write-Log($ctx, [string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date).ToString("s"), $msg
  Add-Content -LiteralPath $ctx.ActionsLog -Value $line
}

function Resolve-Shortcut([string]$lnkPath) {
  try {
    $wsh = New-Object -ComObject WScript.Shell
    $sc = $wsh.CreateShortcut($lnkPath)
    return [pscustomobject]@{
      TargetPath = $sc.TargetPath
      Arguments  = $sc.Arguments
      WorkingDir = $sc.WorkingDirectory
      IconLocation = $sc.IconLocation
    }
  } catch {
    return $null
  }
}

function Get-HashSafe([string]$path) {
  try {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash
  } catch { return $null }
}

function Should-ExcludePath($cfg, [string]$fullPath) {
  # Exclude system roots by default, unless path starts with an allowlisted path.
  foreach ($allow in $cfg.AllowlistPaths) {
    if ($fullPath.StartsWith($allow, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $false
    }
  }
  foreach ($ex in $cfg.ExcludeRoots) {
    if ($fullPath.StartsWith($ex, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

function Matches-Interest($cfg, [string]$fullPath) {
  $lp = $fullPath.ToLowerInvariant()
  foreach ($k in $cfg.Keywords) {
    $kk = $k.ToLowerInvariant()
    if ($lp.Contains($kk)) { return $true }
  }
  $ext = [System.IO.Path]::GetExtension($fullPath).ToLowerInvariant()
  if ($cfg.Extensions -contains $ext) { return $true }
  return $false
}

function Get-InventoryItem($cfg, $ctx, [string]$path) {
  $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  if (-not $item) { return $null }

  $type = if ($item.PSIsContainer) { "Directory" } else { "File" }
  $ext  = if ($type -eq "File") { $item.Extension } else { "" }

  $shortcut = $null
  $shortcutTarget = $null
  if ($type -eq "File" -and $ext -ieq ".lnk") {
    $shortcut = Resolve-Shortcut $item.FullName
    if ($shortcut) { $shortcutTarget = $shortcut.TargetPath }
  }

  $hash = $null
  if ($type -eq "File") {
    $e = $ext.ToLowerInvariant()
    if ($e -in @(".exe",".msi",".dll",".ps1",".bat",".cmd",".sys")) {
      $hash = Get-HashSafe $item.FullName
    }
  }

  return [pscustomobject]@{
    FullPath       = $item.FullName
    Type           = $type
    SizeBytes      = if ($type -eq "File") { $item.Length } else { 0 }
    LastWriteTime  = $item.LastWriteTime
    Extension      = $ext
    HashSHA256     = $hash
    MatchReason    = ""
    ShortcutTarget = $shortcutTarget
    Classification = "Unknown"
    RecommendedAction = "Review"
  }
}

function Classify($cfg, $inv) {
  # Conservative classification:
  # Required: starting paths, shortcut targets, newest within duplicated groups (handled later), final root items
  # CandidateRemove: obvious caches/logs/tmp + duplicates in non-final paths
  # Unknown: everything else
  $path = $inv.FullPath.ToLowerInvariant()

  # Required if inside FinalRoot
  if ($path.StartsWith(($cfg.FinalRoot.ToLowerInvariant()))) {
    $inv.Classification = "Required"
    $inv.RecommendedAction = "Keep"
    $inv.MatchReason = "Inside FinalRoot"
    return $inv
  }

  # Required if is a starting path match (exact or within starting folder)
  foreach ($sp in $cfg.StartingPaths) {
    $spLow = $sp.ToLowerInvariant()
    if ($path -eq $spLow -or $path.StartsWith($spLow + "\") ) {
      $inv.Classification = "Required"
      $inv.RecommendedAction = "Keep"
      $inv.MatchReason = "StartingPath"
      return $inv
    }
  }

  # Required if it is a shortcut target
  if ($inv.ShortcutTarget) {
    $inv.Classification = "Required"
    $inv.RecommendedAction = "Keep"
    $inv.MatchReason = "ShortcutTarget"
    return $inv
  }

  # CandidateRemove if clearly temp/cache/log
  if ($path -match "\\temp\\" -or $path -match "\\cache\\" -or $path.EndsWith(".tmp") -or $path.EndsWith(".log")) {
    $inv.Classification = "CandidateRemove"
    $inv.RecommendedAction = "Quarantine"
    $inv.MatchReason = "Temp/Cache/Log"
    return $inv
  }

  # Otherwise Unknown until dedupe pass
  return $inv
}

function Scan-Paths($cfg, $ctx) {
  $results = New-Object System.Collections.Generic.List[object]

  $roots = @()
  $roots += $cfg.StartingPaths
  $roots += "C:\"

  foreach ($root in $roots) {
    if (!(Test-Path -LiteralPath $root)) {
      Write-Log $ctx "Missing path: $root"
      continue
    }

    Write-Log $ctx "Scanning root: $root"

    if ((Get-Item -LiteralPath $root -Force).PSIsContainer) {
      Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
        $p = $_.FullName
        if (Should-ExcludePath $cfg $p) { return }
        if (-not (Matches-Interest $cfg $p)) { return }
        $inv = Get-InventoryItem $cfg $ctx $p
        if ($inv) { $results.Add($inv) }
      }
    } else {
      $p = (Get-Item -LiteralPath $root -Force).FullName
      if (-not (Should-ExcludePath $cfg $p) -and (Matches-Interest $cfg $p)) {
        $inv = Get-InventoryItem $cfg $ctx $p
        if ($inv) { $results.Add($inv) }
      }
    }
  }

  return $results
}

function Dedupe-And-Refine($cfg, $inventory) {
  # If same hash appears multiple times, mark older copies outside FinalRoot as CandidateRemove.
  $byHash = $inventory | Where-Object { $_.HashSHA256 } | Group-Object HashSHA256
  foreach ($g in $byHash) {
    if ($g.Count -lt 2) { continue }
    $items = $g.Group | Sort-Object LastWriteTime -Descending
    $keep = $items[0]
    foreach ($it in $items) {
      if ($it.FullPath -eq $keep.FullPath) { continue }
      $p = $it.FullPath.ToLowerInvariant()
      if (-not $p.StartsWith($cfg.FinalRoot.ToLowerInvariant())) {
        if ($it.Classification -ne "Required") {
          $it.Classification = "CandidateRemove"
          $it.RecommendedAction = "Quarantine"
          $it.MatchReason = "DuplicateHash"
        }
      }
    }
  }
  return $inventory
}

function Write-Reports($ctx, $inventory) {
  $inventory | Sort-Object Classification, FullPath | Export-Csv -NoTypeInformation -LiteralPath $ctx.AuditCsv

  $counts = $inventory | Group-Object Classification | Sort-Object Name
  $largest = $inventory | Where-Object { $_.Type -eq "File" } | Sort-Object SizeBytes -Descending | Select-Object -First 15
  $dupes = $inventory | Where-Object { $_.MatchReason -eq "DuplicateHash" } | Group-Object HashSHA256 | Where-Object { $_.Count -gt 1 }

  $sb = New-Object System.Text.StringBuilder
  $null = $sb.AppendLine("1132 Remover — Summary")
  $null = $sb.AppendLine(("Timestamp: {0}" -f $ctx.Timestamp))
  $null = $sb.AppendLine("")
  $null = $sb.AppendLine("Counts by classification:")
  foreach ($c in $counts) {
    $null = $sb.AppendLine(("  {0}: {1}" -f $c.Name, $c.Count))
  }
  $null = $sb.AppendLine("")
  $null = $sb.AppendLine("Top 15 largest files:")
  foreach ($l in $largest) {
    $null = $sb.AppendLine(("  {0}  {1} bytes  {2}" -f $l.FullPath, $l.SizeBytes, $l.LastWriteTime))
  }
  $null = $sb.AppendLine("")
  $null = $sb.AppendLine(("Duplicate hash groups: {0}" -f $dupes.Count))
  $null = $sb.AppendLine("")
  Set-Content -LiteralPath $ctx.SummaryTxt -Value $sb.ToString()
}

function Ensure-Dir([string]$path) {
  if (!(Test-Path -LiteralPath $path)) { New-Item -ItemType Directory -Force -Path $path | Out-Null }
}

function Copy-Required($cfg, $ctx, $inventory) {
  Write-Log $ctx "Consolidating Required items into: $($ctx.ConsolidatedDir)"
  Ensure-Dir $ctx.ConsolidatedDir

  $required = $inventory | Where-Object { $_.Classification -eq "Required" -and $_.Type -eq "File" }
  foreach ($r in $required) {
    $rel = $r.FullPath.TrimStart("\").Replace(":", "")
    $dest = Join-Path $ctx.ConsolidatedDir $rel
    $destDir = Split-Path -Parent $dest
    Ensure-Dir $destDir

    if ($PSCmdlet.ShouldProcess($r.FullPath, "Copy to $dest")) {
      Copy-Item -LiteralPath $r.FullPath -Destination $dest -Force
    }
  }
}

function Quarantine-Candidates($cfg, $ctx, $inventory) {
  Write-Log $ctx "Quarantining CandidateRemove items into: $($ctx.QuarantineDir)"
  Ensure-Dir $ctx.QuarantineDir

  $cands = $inventory | Where-Object { $_.Classification -eq "CandidateRemove" }
  foreach ($c in $cands) {
    if (!(Test-Path -LiteralPath $c.FullPath)) { continue }

    $rel = $c.FullPath.TrimStart("\").Replace(":", "")
    $dest = Join-Path $ctx.QuarantineDir $rel
    $destDir = Split-Path -Parent $dest
    Ensure-Dir $destDir

    if ($PSCmdlet.ShouldProcess($c.FullPath, "Move to quarantine $dest")) {
      try {
        Move-Item -LiteralPath $c.FullPath -Destination $dest -Force
      } catch {
        Write-Log $ctx "FAILED to quarantine: $($c.FullPath) :: $($_.Exception.Message)"
      }
    }
  }
}

function Delete-Quarantine($ctx) {
  Write-Log $ctx "Force deleting quarantine folder: $($ctx.QuarantineDir)"
  if ($PSCmdlet.ShouldProcess($ctx.QuarantineDir, "Remove-Item -Recurse -Force")) {
    Remove-Item -LiteralPath $ctx.QuarantineDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# --- Main ---
$cfg = Read-Config $ConfigPath
$ctx = New-RunContext $cfg
Write-Log $ctx "Mode: $Mode"
Write-Log $ctx "Config: $ConfigPath"

$inventory = Scan-Paths $cfg $ctx
$inventory = $inventory | ForEach-Object { Classify $cfg $_ }
$inventory = Dedupe-And-Refine $cfg $inventory

Write-Reports $ctx $inventory
Write-Log $ctx "Wrote reports: $($ctx.AuditCsv), $($ctx.SummaryTxt)"

switch ($Mode) {
  "Audit" { Write-Log $ctx "Audit complete (no changes)." }
  "Consolidate" { Copy-Required $cfg $ctx $inventory }
  "Cleanup" { Quarantine-Candidates $cfg $ctx $inventory }
  "Full" {
    Copy-Required $cfg $ctx $inventory
    Quarantine-Candidates $cfg $ctx $inventory
    if ($ForceDelete) { Delete-Quarantine $ctx }
    else { Write-Log $ctx "ForceDelete not set; quarantine retained for rollback." }
  }
  default { throw "Unknown mode: $Mode" }
}

Write-Log $ctx "Done."
Write-Output "Run complete. Logs: $($ctx.LogDir)"
