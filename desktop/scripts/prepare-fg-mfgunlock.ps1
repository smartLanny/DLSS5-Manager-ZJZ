$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$resourceRoot = Join-Path $projectRoot 'resources/fg-mfgunlock'
$manifest = Get-Content -LiteralPath (Join-Path $resourceRoot 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.version -ne 3 -or [string]::IsNullOrWhiteSpace([string]$manifest.defaultProvider)) { throw 'Unsupported MFG resource catalog' }
foreach ($provider in $manifest.providers) {
    $providerRoot = if ($provider.directory) { Join-Path $resourceRoot $provider.directory } else { $resourceRoot }
    New-Item -ItemType Directory -Path $providerRoot -Force | Out-Null
    foreach ($role in $provider.files.PSObject.Properties.Name) {
        $row = $provider.files.$role
        if ([IO.Path]::GetFileName($row.file) -ne $row.file) { throw 'Unsafe MFG resource path' }
        $target = Join-Path $providerRoot $row.file
        if ((Test-Path -LiteralPath $target) -and (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ieq $row.sha256) { continue }
        $temp = Join-Path $providerRoot ([guid]::NewGuid().ToString() + '.download')
        try {
            if ($role -eq 'addon') {
                Invoke-WebRequest -Uri $row.url -OutFile $temp
            } else {
                $url = 'https://raw.githubusercontent.com/mavismmg/MFGAdaUnlock-RenoDx/' + $provider.source.commit + '/' + $row.file
                Invoke-WebRequest -Uri $url -OutFile $temp
            }
            if ((Get-FileHash -LiteralPath $temp -Algorithm SHA256).Hash -ine $row.sha256) { throw "MFG source hash mismatch: $($provider.id)/$role" }
            Move-Item -LiteralPath $temp -Destination $target -Force
        } finally {
            if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp }
        }
    }
}
node (Join-Path $PSScriptRoot 'verify-fg-mfgunlock.js')
if ($LASTEXITCODE -ne 0) { throw 'MFG Unlock resource verification failed' }
