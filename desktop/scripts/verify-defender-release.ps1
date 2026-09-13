param(
  [Parameter(Mandatory = $true)][string[]]$TargetPath,
  [Parameter(Mandatory = $true)][string]$ReportPath
)
$ErrorActionPreference = 'Stop'
$taskStatus = Get-MpComputerStatus
if (!$taskStatus.AntivirusEnabled -or !$taskStatus.RealTimeProtectionEnabled) {
  throw 'Defender must be active for release verification.'
}
$taskPlatform = Get-ChildItem -LiteralPath 'C:\ProgramData\Microsoft\Windows Defender\Platform' -Directory |
  Sort-Object Name -Descending | Select-Object -First 1
$taskScanner = Join-Path $taskPlatform.FullName 'MpCmdRun.exe'
$taskScannerSignature = Get-AuthenticodeSignature -LiteralPath $taskScanner
if ($taskScannerSignature.Status -ne 'Valid' -or $taskScannerSignature.SignerCertificate.Subject -notmatch 'Microsoft') {
  throw 'The installed Defender command-line tool could not be authenticated.'
}
$taskResults = @()
foreach ($taskTarget in $TargetPath) {
  $taskFullPath = (Resolve-Path -LiteralPath $taskTarget).Path
  $taskItem = Get-Item -LiteralPath $taskFullPath -Force
  $taskFiles = if ($taskItem.PSIsContainer) { @(Get-ChildItem -LiteralPath $taskFullPath -Recurse -File -Force) } else { @($taskItem) }
  if ($taskFiles.Count -gt 50000 -or !$taskFiles.Count) { throw 'Invalid release file inventory.' }
  if (@($taskFiles | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Release files must not be links.' }
  $taskBefore = @($taskFiles | ForEach-Object { [ordered]@{ path = $_.FullName; bytes = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } })
  # This documented inspection mode scans archives, ignores file exclusions,
  # and reports detections without modifying the submitted candidate files.
  $taskOutput = @(& $taskScanner -Scan -ScanType 3 -File $taskFullPath -DisableRemediation 2>&1)
  $taskExit = $LASTEXITCODE
  $taskUnchanged = $true
  foreach ($taskFile in $taskBefore) {
    if (!(Test-Path -LiteralPath $taskFile.path -PathType Leaf) -or
      (Get-FileHash -LiteralPath $taskFile.path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskFile.sha256) { $taskUnchanged = $false }
  }
  $taskText = $taskOutput -join "`n"
  $taskDetected = $taskText -match '(?im)found\s+[1-9][0-9]*\s+threats|^\s*Threat\s+:'
  $taskResults += [ordered]@{ path = $taskFullPath; ok = ($taskExit -eq 0 -and !$taskDetected -and $taskUnchanged -and $taskText -match 'Scan finished');
    exitCode = $taskExit; detected = $taskDetected; unchanged = $taskUnchanged; files = $taskBefore; output = $taskText }
}
$taskReport = [ordered]@{ schema = 1; checkedAt = [DateTime]::UtcNow.ToString('o');
  ok = (@($taskResults | Where-Object { !$_.ok }).Count -eq 0);
  engine = $taskStatus.AMEngineVersion; signatures = $taskStatus.AntivirusSignatureVersion;
  signaturesUpdatedAt = $taskStatus.AntivirusSignatureLastUpdated; antivirusEnabled = $taskStatus.AntivirusEnabled;
  realTimeProtectionEnabled = $taskStatus.RealTimeProtectionEnabled; fileExclusionsIgnored = $true; archivesScanned = $true;
  scope = 'This Microsoft Defender scan only; not a guarantee for other security products or future definitions.'; results = $taskResults }
$taskReport | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $ReportPath -Encoding utf8NoBOM
[pscustomobject]$taskReport | Select-Object ok, engine, signatures, checkedAt | ConvertTo-Json
if (!$taskReport.ok) { exit 2 }
