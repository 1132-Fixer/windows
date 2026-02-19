# Stage 4 — Delete quarantined items (PERMANENT)
# Only run after verifying consolidated copy works.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$main = Join-Path $root "..\src\1132-Remover.ps1"
$cfg  = Join-Path $root "..\config.json"

& $main -Mode Full -ConfigPath $cfg -ForceDelete
