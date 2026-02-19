# Stage 2 — Consolidate (copy-only)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$main = Join-Path $root "..\src\1132-Remover.ps1"
$cfg  = Join-Path $root "..\config.json"

& $main -Mode Consolidate -ConfigPath $cfg
