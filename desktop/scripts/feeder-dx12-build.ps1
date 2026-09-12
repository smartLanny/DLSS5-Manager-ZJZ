param(
    [Parameter(Mandatory=$true)][string]$StageRoot,
    [Parameter(Mandatory=$true)][string]$DependencyStage,
    [Parameter(Mandatory=$true)][string]$LabRoot,
    [Parameter(Mandatory=$true)][string]$OutputRoot,
    [string]$VcVarsAll = 'C:\BuildTools\VS2022\VC\Auxiliary\Build\vcvarsall.bat'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$stagePath = (Resolve-Path -LiteralPath $StageRoot).Path
$dependencyPath = (Resolve-Path -LiteralPath $DependencyStage).Path
$labPath = (Resolve-Path -LiteralPath $LabRoot).Path
if ($stagePath -eq $dependencyPath) { throw 'Dependency input and output stage must differ.' }
$manifest = Get-Content -Raw -LiteralPath (Join-Path $stagePath 'feeder-external-nr-manifest.json') | ConvertFrom-Json
if (!$manifest.dx12_sdr_candidate -or $manifest.feeder_commit_actual -ne '26c002d5156d178c2db438327194077c9ad94418') { throw 'Expected the fixed DX12 candidate stage.' }
foreach ($name in @('reshade','ngx','vulkan','imgui','minhook')) {
    $source = Join-Path $dependencyPath "external/$name"
    $destination = Join-Path $stagePath "external/$name"
    if (!(Test-Path -LiteralPath $source -PathType Container)) { throw "Missing dependency: $name" }
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $destination -Recurse -Force
}
$pins = Get-Content -Raw -LiteralPath (Join-Path $labPath 'docs/interop/FEEDER_BUILD_DEPENDENCIES.json') | ConvertFrom-Json
foreach ($entry in $pins.nvidia_dlss.sha256.PSObject.Properties) {
    $relative = if ($entry.Name.StartsWith('include/')) { $entry.Name.Substring(8) } else { 'libs/nvsdk_ngx_d.lib' }
    $file = Join-Path $stagePath "external/ngx/$relative"
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value) { throw "Official NGX dependency mismatch: $relative" }
}
$dependencyHashes = Get-ChildItem -LiteralPath (Join-Path $stagePath 'external') -File -Recurse | ForEach-Object {
    [ordered]@{ path = [IO.Path]::GetRelativePath($stagePath, $_.FullName).Replace('\','/'); sha256 = (Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant() }
}
$dependencyHashes | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $stagePath 'dx12-dependencies.json') -Encoding utf8
& (Join-Path $labPath 'scripts/build-feeder-recovery-msvc.ps1') -FeederStageRoot $stagePath -VcVarsAll $VcVarsAll -OutputRoot $OutputRoot
if ($LASTEXITCODE -ne 0) { throw 'DX12 Feeder compile/link failed.' }
