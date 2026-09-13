param(
  [Parameter(Mandatory = $true)][string]$DeliveryDir
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Path $DeliveryDir -Force | Out-Null

$managerVersion = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$sourceCommit = (& git -C $root rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[0-9a-f]{40}$') { throw 'Cannot resolve exact Manager source commit.' }
$bundle = Get-Content -LiteralPath (Join-Path $root 'payload\nr-before-sr\bundle.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$compat = $bundle.versions.'0.4.5-ota'
if (-not $compat -or $compat.label -ne '0.4.5-DX11-兼容增强') { throw 'Unified 0.4.5 payload label is missing.' }
$setup = Join-Path $root "dist\DLSS5-Manager-Setup-$managerVersion.exe"
$portable = Join-Path $root "dist\DLSS5-Manager-$managerVersion-portable.exe"
Copy-Item -LiteralPath $setup -Destination $DeliveryDir -Force
Copy-Item -LiteralPath $portable -Destination $DeliveryDir -Force
Copy-Item -LiteralPath (Join-Path $root 'docs\INSTALL-GUIDE-0.2.0-BETA.md') -Destination (Join-Path $DeliveryDir '安装说明-装机宅版Beta.md') -Force

$items = Get-ChildItem -LiteralPath $DeliveryDir -File | Where-Object { $_.Extension -in @('.exe', '.md', '.txt') } | ForEach-Object {
  [ordered]@{
    name = $_.Name
    size = $_.Length
    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}
[ordered]@{
  product = 'dlss5-manager-装机宅版'
  managerVersion = $managerVersion
  sourceBranch = 'codex/manager-045-dx11-compat'
  sourceCommit = $sourceCommit
  bundledAddon = [ordered]@{
    id = '0.4.5-ota'
    label = $compat.label
    machineVersion = 'beta0.4.5-dx11-compat'
    sourceCommit = 'dccb5b398ccc540723f84a6ef789dd70dbda5cd3'
    files = $compat.files
  }
  addonVersions = @('0.2.0-beta.2', '0.3.3.5', '0.4.5-ota')
  defaultAddonVersion = '0.3.3.5'
  note = '本管理器内置的 0.4.5-ota 已直接替换为 0.4.5-DX11-兼容增强：只含中文核心，并成套校验核心、nrchain 与 carrier；保留 INI。支持已有原生/模组 DLSS 的 DX11-x64 及 D3D12 SR/RR 路线，不包含无 DLSS/Feeder、Vulkan 或 Legacy；旧核心和旧 carrier 不叠加。历史版本仍可独立选择。'
  files = @($items)
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $DeliveryDir 'RELEASE-CONTENTS.json') -Encoding UTF8

Get-ChildItem -LiteralPath $DeliveryDir -File | Where-Object { $_.Extension -in @('.exe', '.md', '.json') } | ForEach-Object {
  "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($_.Name)"
} | Set-Content -LiteralPath (Join-Path $DeliveryDir 'SHA256SUMS.txt') -Encoding UTF8
Write-Host "Delivery ready: $DeliveryDir"
