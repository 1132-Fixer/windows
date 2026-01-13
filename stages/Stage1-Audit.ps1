# Stage 1 — Audit (read-only)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$main = Join-Path $root "..\src\1132-Remover.ps1"
$cfg  = Join-Path $root "..\config.json"

& $main -Mode Audit -ConfigPath $cfg
