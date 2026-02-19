$bytes = [System.IO.File]::ReadAllBytes("C:\Users\justy\Documents\Bot\Local Files\1132-Remover\CleanZoom_extracted\CleanZoom.exe")
$text = [System.Text.Encoding]::ASCII.GetString($bytes)
$matches = [regex]::Matches($text, '[\x20-\x7E]{6,}')
$results = $matches.Value | Where-Object {
    $_ -match 'zoom|Zoom|AppData|Software|HKCU|HKLM|Roaming|Local|Program|Registry|Uninstall|Delete|Remove|\.exe|\.dll|\.msi|CptService|ZoomOutlook'
} | Sort-Object -Unique
$results | ForEach-Object { Write-Host $_ }
