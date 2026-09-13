param(
  [string]$Repository = 'https://github.com/rakanki911/DLSS5-Swapper.git',
  [string]$Commit = 'ccb67f4bc92cb5da1d25416dd6b338e12fa432c5'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root 'vendor\DLSS5-Swapper'
if (Test-Path -LiteralPath $target) {
  $entries = @(Get-ChildItem -LiteralPath $target -Force -ErrorAction SilentlyContinue)
  if ($entries.Count -eq 0) {
    Remove-Item -LiteralPath $target -Force
  } elseif (-not (Test-Path -LiteralPath (Join-Path $target '.git'))) {
    throw "Refusing to replace non-git directory: $target"
  }
}
if (-not (Test-Path -LiteralPath $target)) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
  git clone --filter=blob:none --no-checkout $Repository $target
  if ($LASTEXITCODE -ne 0) { throw 'Unable to clone DLSS5-Swapper.' }
}
git -C $target fetch --depth 1 origin $Commit
if ($LASTEXITCODE -ne 0) { throw 'Unable to fetch the pinned upstream commit.' }
git -C $target checkout --detach $Commit
if ($LASTEXITCODE -ne 0) { throw 'Unable to check out the pinned upstream commit.' }
node (Join-Path $PSScriptRoot 'verify-vendor.js')
if ($LASTEXITCODE -ne 0) { throw 'Vendor verification failed.' }
