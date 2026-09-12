$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$resourceRoot = Join-Path $projectRoot 'resources/fg-components'
$cacheRoot = Join-Path $projectRoot 'build/fg-component-downloads'
$manifest = Get-Content -LiteralPath (Join-Path $resourceRoot 'manifest.json') -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
for ($index = 0; $index -lt $manifest.sources.Count; $index++) {
  $source = $manifest.sources[$index]
  $zipFile = Join-Path $cacheRoot "source-$index.zip"
  if (-not (Test-Path -LiteralPath $zipFile) -or (Get-FileHash -LiteralPath $zipFile -Algorithm SHA256).Hash -ine $source.sha256) {
    Invoke-WebRequest -Uri $source.url -OutFile $zipFile
  }
  if ((Get-FileHash -LiteralPath $zipFile -Algorithm SHA256).Hash -ine $source.sha256) { throw 'FG source archive hash mismatch' }
  $archive = [IO.Compression.ZipFile]::OpenRead($zipFile)
  try {
    foreach ($entry in $archive.Entries) {
      $name = $entry.FullName
      $allowed = if ($index -eq 0) { @('RTX40MFGCore.dll', 'RTX40MFG.asi', 'RTX40MFG-UI.addon64', 'global.ini', 'LICENSE', 'MINHOOK-LICENSE.txt') } else { @('dinput8.dll') }
      if ($allowed -notcontains $name) { continue }
      $targetName = if ($index -eq 1) { 'ual-x64.dll' } else { $name }
      $target = Join-Path $resourceRoot $targetName
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
    }
  } finally { $archive.Dispose() }
}
node (Join-Path $PSScriptRoot 'verify-fg-components.js')
if ($LASTEXITCODE -ne 0) { throw 'FG component verification failed' }
