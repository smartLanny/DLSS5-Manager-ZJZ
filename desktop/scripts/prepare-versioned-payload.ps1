param(
  [Parameter(Mandatory = $true)][string]$Legacy40,
  [Parameter(Mandatory = $true)][string]$Legacy50,
  [Parameter(Mandatory = $true)][string]$Stable40,
  [Parameter(Mandatory = $true)][string]$Stable50,
  [Parameter(Mandatory = $true)][string]$CompatAddon,
  [Parameter(Mandatory = $true)][string]$CompatBridge,
  [Parameter(Mandatory = $true)][string]$CompatCarrier,
  [Parameter(Mandatory = $true)][string]$CompatConfig,
  [Parameter(Mandatory = $true)][string]$ReShade64,
  [Parameter(Mandatory = $true)][string]$Legacy02,
  [string]$PayloadRoot = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$payloadParent = Join-Path $root 'payload'
$payload = [IO.Path]::GetFullPath($(if ($PayloadRoot) { $PayloadRoot } else { Join-Path $payloadParent 'nr-before-sr' }))

function Assert-PlainDirectory([string]$path, [string]$scope, [bool]$allowScopeRoot = $false) {
  $full = [IO.Path]::GetFullPath($path)
  $scopeFull = [IO.Path]::GetFullPath($scope).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $prefix = $scopeFull + [IO.Path]::DirectorySeparatorChar
  if ((-not $allowScopeRoot -or $full -ne $scopeFull) -and
      -not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Managed payload path escapes its intended scope: $full"
  }
  if (Test-Path -LiteralPath $full) {
    $item = Get-Item -LiteralPath $full -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Managed payload directory is not a plain directory: $full"
    }
  }
  return $full
}

function Assert-ReviewedFile([string]$path, [string]$expected, [string]$kind) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing reviewed $kind input: $path" }
  $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "Reviewed compatibility input hash mismatch for ${kind}: expected $expected, got $actual" }
}

$reviewed = @(
  @($CompatAddon, 'ffea8e3a92cf07388f71b1855f3157c9c959a7a094b6f1a35cb92c57bf2f06f9', 'Chinese core'),
  @($CompatBridge, '46041a5ff91ae2fd907e310d132aabc3c4a1ecd48dace511b8672909d5d9c2fb', 'nrchain'),
  @($CompatCarrier, 'f825ccc47c2bdf3e365606ba44760371f74ac0ec0fabbc0565ae98864fca05ce', 'carrier'),
  @($CompatConfig, 'cae9227a1d891321194fc7bb7d7e19c43031578349c82d53e9a316fa36118df8', 'INI')
)
# Validate the complete reviewed batch before creating, deleting or copying any
# payload entry. A renamed English/old binary cannot pass this boundary.
foreach ($entry in $reviewed) { Assert-ReviewedFile $entry[0] $entry[1] $entry[2] }

$payloadScope = if ($PayloadRoot) { Split-Path -Parent $payload } else { $payloadParent }
$payloadScope = Assert-PlainDirectory $payloadScope (Split-Path -Parent $payloadScope)
$payload = Assert-PlainDirectory $payload $payloadScope
$versions = Assert-PlainDirectory (Join-Path $payload 'versions') $payload
$fixed = Assert-PlainDirectory (Join-Path $payload 'fixed') $payload
New-Item -ItemType Directory -Path $versions -Force | Out-Null
New-Item -ItemType Directory -Path $fixed -Force | Out-Null

function Copy-Version([string]$id, [string]$source) {
  $target = Join-Path $versions $id
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  $addon = Get-ChildItem -LiteralPath $source -File | Where-Object { $_.Name -ieq 'nr-before-sr.zh-CN.addon64' } | Select-Object -First 1
  if (-not $addon) {
    $addon = Get-ChildItem -LiteralPath $source -File | Where-Object { $_.Name -match '(?i)[.]addon64$' } | Select-Object -First 1
  }
  if (-not $addon) { throw "No addon64 found in $source" }
  Copy-Item -LiteralPath $addon.FullName -Destination (Join-Path $target 'nr-before-sr.zh-CN.addon64') -Force
  Copy-Item -LiteralPath (Join-Path $source 'nr_before_sr.ini') -Destination (Join-Path $target 'nr_before_sr.ini') -Force
}

function Copy-Reviewed([string]$source, [string]$target, [string]$expected, [string]$kind) {
  Assert-ReviewedFile $source $expected $kind
  Copy-Item -LiteralPath $source -Destination $target -Force
  Assert-ReviewedFile $target $expected "copied $kind"
}

function Copy-CompatibilityVersion() {
  $target = Assert-PlainDirectory (Join-Path $versions '0.4.5-ota') $versions
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  New-Item -ItemType Directory -Path $target | Out-Null
  Copy-Reviewed $CompatAddon (Join-Path $target 'nr-before-sr.zh-CN.addon64') $reviewed[0][1] $reviewed[0][2]
  Copy-Reviewed $CompatBridge (Join-Path $target 'nrchain_nvngx.dll') $reviewed[1][1] $reviewed[1][2]
  Copy-Reviewed $CompatCarrier (Join-Path $target 'dlss5-native-carrier-045-dx11-compat.addon64') $reviewed[2][1] $reviewed[2][2]
  Copy-Reviewed $CompatConfig (Join-Path $target 'nr_before_sr.ini') $reviewed[3][1] $reviewed[3][2]
}

function Copy-Fixed([string]$family, [string]$source) {
  $target = Join-Path $fixed $family
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  Copy-Item -LiteralPath $ReShade64 -Destination (Join-Path $target 'ReShade64.dll') -Force
  foreach ($name in @('nrchain_nvngx.dll', 'nvngx_dlssnr.dll')) {
    Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $target $name) -Force
  }
}

Copy-Fixed 'RTX40' $Stable40
Copy-Fixed 'RTX50' $Stable50
Copy-Version '0.2.0-beta.2' $Legacy02
Copy-Version '0.3.3.5' $Legacy40
Copy-CompatibilityVersion

node (Join-Path $PSScriptRoot 'verify-payload.js') --write --dir $payload
if ($LASTEXITCODE -ne 0) { throw 'Versioned payload verification failed.' }
Write-Host "Matched 0.4.5 DX11 compatibility payload prepared under $payload"
