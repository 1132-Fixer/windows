# Stage 0 — Preflight (no changes)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "Preflight checks..." -ForegroundColor Cyan

# Execution policy for this session only
try {
  Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force | Out-Null
} catch {}

# Confirm admin
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Warning "Not running as Administrator. Audit can still run, but Consolidate/Cleanup may fail on protected paths."
}

# Confirm script files exist
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$main = Join-Path $root "..\src\1132-Remover.ps1"
$cfg  = Join-Path $root "..\config.json"

if (!(Test-Path -LiteralPath $main)) { throw "Missing main script: $main" }
if (!(Test-Path -LiteralPath $cfg))  { throw "Missing config: $cfg" }

Write-Host "OK: main script and config found." -ForegroundColor Green
Write-Host "Next: run Stage1-Audit.ps1" -ForegroundColor Yellow
