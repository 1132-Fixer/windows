# Create ZIP of 1132-Remover project
$source = "C:\Users\justy\Documents\Bot\Local Files\1132-Remover"
$dest = "C:\Users\justy\Desktop\1132-Remover-Complete.zip"

# Remove old zip if exists
if (Test-Path $dest) { Remove-Item $dest -Force }

# Get all items except problematic ones
$items = Get-ChildItem $source -Force | Where-Object {
    $_.Name -ne 'nul' -and
    $_.Name -notlike 'tmpclaude*' -and
    $_.Name -ne 'create-zip.ps1'
}

# Create temp folder, copy items, zip it
$temp = "$env:TEMP\1132-Remover-temp"
if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }
New-Item $temp -ItemType Directory | Out-Null

foreach ($item in $items) {
    Copy-Item $item.FullName $temp -Recurse -Force
}

Compress-Archive -Path "$temp\*" -DestinationPath $dest -Force
Remove-Item $temp -Recurse -Force

Write-Host "ZIP created at: $dest"
