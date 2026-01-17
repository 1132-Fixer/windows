# Extract Unicode strings (more common in Windows executables)
$bytes = [System.IO.File]::ReadAllBytes("C:\Users\justy\Documents\Bot\Local Files\1132-Remover\CleanZoom_extracted\CleanZoom.exe")
$text = [System.Text.Encoding]::Unicode.GetString($bytes)
$matches = [regex]::Matches($text, '[\x20-\x7E]{6,}')
$results = $matches.Value | Where-Object {
    $_ -match 'Zoom|zoom|AppData|Software|Roaming|Program|\.exe|\.dll|cpt|ZCS|service'
} | Sort-Object -Unique
Write-Host "=== Unicode Strings ===" -ForegroundColor Cyan
$results | ForEach-Object { Write-Host $_ }
