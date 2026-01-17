$bytes = [System.IO.File]::ReadAllBytes("C:\Users\justy\Documents\Bot\Local Files\1132-Remover\CleanZoom_extracted\CleanZoom.exe")
$text = [System.Text.Encoding]::ASCII.GetString($bytes)
$matches = [regex]::Matches($text, '[\x20-\x7E]{8,}')
$results = $matches.Value | Where-Object {
    $_ -match 'Software\\|CLSID|Classes\\|Uninstall|CurrentVersion|Microsoft\\Windows|Schedule|Task'
} | Sort-Object -Unique
$results | ForEach-Object { Write-Host $_ }
