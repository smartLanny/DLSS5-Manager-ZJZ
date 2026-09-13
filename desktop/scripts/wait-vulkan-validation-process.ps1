param(
  [Parameter(Mandatory=$true)][int]$ProcessIdToWatch,
  [Parameter(Mandatory=$true)][string]$ExpectedExePath,
  [Parameter(Mandatory=$true)][string]$StartedAfter,
  [int]$TimeoutMs = 120000
)
$ErrorActionPreference = 'Stop'
$taskObserved = $null
try {
  if ($ProcessIdToWatch -le 0 -or $TimeoutMs -le 0 -or $TimeoutMs -gt 180000) { throw 'Invalid process observation bounds.' }
  $taskExpected = [IO.Path]::GetFullPath($ExpectedExePath)
  $taskEarliest = [DateTime]::Parse($StartedAfter, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
  $taskObserved = [Diagnostics.Process]::GetProcessById($ProcessIdToWatch)
  # Acquire and retain the OS handle now. PID disappearance or a renderer's
  # own completion text is not evidence of a clean DLL/process teardown.
  $null = $taskObserved.Handle
  $taskActual = [IO.Path]::GetFullPath($taskObserved.MainModule.FileName)
  if (-not [String]::Equals($taskExpected, $taskActual, [StringComparison]::OrdinalIgnoreCase) -or
      $taskObserved.StartTime.ToUniversalTime() -lt $taskEarliest) { throw 'Observed process identity does not match the new validation child.' }
  if (-not $taskObserved.WaitForExit($TimeoutMs)) { throw 'Validation child did not exit within the observation bound.' }
  [ordered]@{ step='process-exit'; pid=$ProcessIdToWatch; exitCode=$taskObserved.ExitCode; observed=$true } | ConvertTo-Json -Compress
  exit 0
} catch {
  [ordered]@{ step='process-exit'; pid=$ProcessIdToWatch; exitCode=$null; observed=$false; error=$_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
} finally {
  if ($null -ne $taskObserved) { $taskObserved.Dispose() }
}
