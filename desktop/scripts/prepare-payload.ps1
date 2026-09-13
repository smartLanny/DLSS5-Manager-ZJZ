param(
  [Parameter(Mandatory=$true)][string]$NrBuildDir,
  [Parameter(Mandatory=$true)][string]$NeuralRuntime,
  [Parameter(Mandatory=$true)][string]$ReShadeAddonRuntime,
  [string]$NrBuildDirRtx50 = '',
  [string]$NeuralRuntimeRtx50 = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root 'payload\nr-before-sr'
New-Item -ItemType Directory -Path $dest -Force | Out-Null
function Copy-Variant([string]$Family, [string]$BuildDir, [string]$Runtime) {
  $variant = Join-Path $dest $Family
  New-Item -ItemType Directory -Path $variant -Force | Out-Null
  $files = @{
    'nr-before-sr.zh-CN.addon64' = Join-Path $BuildDir 'nr-before-sr.zh-CN.addon64'
    'nrchain_nvngx.dll' = Join-Path $BuildDir 'nrchain_nvngx.dll'
    'nr_before_sr.ini' = Join-Path $BuildDir 'nr_before_sr.ini'
    'nvngx_dlssnr.dll' = $Runtime
    'ReShade64.dll' = $ReShadeAddonRuntime
  }
  foreach ($entry in $files.GetEnumerator()) {
    if (-not (Test-Path -LiteralPath $entry.Value)) { throw "Missing input: $($entry.Value)" }
    Copy-Item -LiteralPath $entry.Value -Destination (Join-Path $variant $entry.Key) -Force
  }
}
if ($NrBuildDirRtx50 -and $NeuralRuntimeRtx50) {
  Copy-Variant 'RTX40' $NrBuildDir $NeuralRuntime
  Copy-Variant 'RTX50' $NrBuildDirRtx50 $NeuralRuntimeRtx50
} else {
  Copy-Variant 'legacy' $NrBuildDir $NeuralRuntime
  $legacy = Join-Path $dest 'legacy'
  Get-ChildItem -LiteralPath $legacy -File | Move-Item -Destination $dest -Force
  Remove-Item -LiteralPath $legacy -Force
}
node (Join-Path $PSScriptRoot 'verify-payload.js') --write
if ($LASTEXITCODE -ne 0) { throw 'Payload verification failed.' }
Write-Host "Payload ready: $dest"
