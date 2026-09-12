$ErrorActionPreference = 'Stop'

function Send-Result([bool]$Ok, $Result, [string]$Code, [string]$Message) {
  [Console]::Out.WriteLine((@{ version = 1; ok = $Ok; result = $Result; code = $Code; error = $Message } | ConvertTo-Json -Compress -Depth 8))
}
function Fail([string]$Code, [string]$Message) {
  $errorRecord = New-Object System.Exception($Message)
  $errorRecord.Data['Code'] = $Code
  throw $errorRecord
}
function Validate-Key([string]$Key) {
  if ([string]::IsNullOrWhiteSpace($Key) -or $Key.Length -gt 512 -or $Key -notmatch '^Software\\' -or $Key -match '[\x00-\x1f/]' -or ($Key -split '\\' | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' })) {
    Fail 'REGISTRY_REQUEST_INVALID' 'HKCU registry key is invalid.'
  }
}
function Validate-Name([string]$Name) {
  if ([string]::IsNullOrEmpty($Name) -or $Name.Length -gt 4096 -or $Name -match '[\x00-\x1f]') { Fail 'REGISTRY_REQUEST_INVALID' 'Registry value name is invalid.' }
}
function State($Key, [string]$Name) {
  if ($null -eq $Key) { return @{ exists = $false } }
  $actualName = @($Key.GetValueNames() | Where-Object { $_ -ieq $Name })
  if ($actualName.Count -eq 0) { return @{ exists = $false } }
  if ($actualName.Count -ne 1) { Fail 'REGISTRY_HELPER_PROTOCOL' 'Registry value identity is ambiguous.' }
  $kind = $Key.GetValueKind($actualName[0]).ToString()
  if ($kind -ne 'DWord') { return @{ exists = $true; type = ('REG_' + $kind.ToUpperInvariant()) } }
  $raw = [int64]$Key.GetValue($actualName[0], $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($raw -lt 0) { $raw += 4294967296 }
  return @{ exists = $true; type = 'REG_DWORD'; data = $raw }
}
function Same-State($A, $B) {
  if ([bool]$A.exists -ne [bool]$B.exists) { return $false }
  if (-not [bool]$A.exists) { return $true }
  return ([string]$A.type -ceq [string]$B.type -and [uint64]$A.data -eq [uint64]$B.data)
}
function Validate-State($State) {
  if ($null -eq $State -or $null -eq $State.exists) { Fail 'REGISTRY_REQUEST_INVALID' 'Registry state is invalid.' }
  if (-not [bool]$State.exists) { return }
  if ([string]$State.type -cne 'REG_DWORD' -or $null -eq $State.data -or [decimal]$State.data -lt 0 -or [decimal]$State.data -gt 4294967295 -or [decimal]$State.data % 1 -ne 0) {
    Fail 'REGISTRY_VALUE_TYPE' 'Only REG_DWORD values are supported.'
  }
}

try {
  $text = [Console]::In.ReadToEnd()
  try { $request = $text | ConvertFrom-Json }
  catch { Fail 'REGISTRY_REQUEST_INVALID' 'Request JSON is invalid.' }
  if ($null -eq $request -or [int]$request.version -ne 1 -or [string]$request.view -cne '64') { Fail 'REGISTRY_REQUEST_INVALID' 'Request version or registry view is invalid.' }
  Validate-Key ([string]$request.key)
  if ([string]$request.op -ceq 'listMachine') {
    $machineBase = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
    try {
      $machineKey = $machineBase.OpenSubKey('Software\Khronos\Vulkan\ImplicitLayers', $false)
      try {
        $rows = @()
        if ($null -ne $machineKey) { foreach ($name in $machineKey.GetValueNames()) { $state = State $machineKey $name; $state.name = $name; $rows += $state } }
        Send-Result $true $rows $null $null
      } finally { if ($null -ne $machineKey) { $machineKey.Dispose() } }
    } finally { $machineBase.Dispose() }
    exit 0
  }
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
  try {
    if ([string]$request.op -ceq 'list') {
      $key = $base.OpenSubKey([string]$request.key, $false)
      try {
        $rows = @()
        if ($null -ne $key) { foreach ($name in $key.GetValueNames()) { $state = State $key $name; $state.name = $name; $rows += $state } }
        Send-Result $true $rows $null $null
      } finally { if ($null -ne $key) { $key.Dispose() } }
    } elseif ([string]$request.op -ceq 'read') {
      Validate-Name ([string]$request.name)
      $key = $base.OpenSubKey([string]$request.key, $false)
      try { Send-Result $true (State $key ([string]$request.name)) $null $null }
      finally { if ($null -ne $key) { $key.Dispose() } }
    } elseif ([string]$request.op -ceq 'write') {
      Validate-Name ([string]$request.name); Validate-State $request.expected; Validate-State $request.desired
      $key = $base.OpenSubKey([string]$request.key, $true)
      try {
        $current = State $key ([string]$request.name)
        if ($current.exists -and $current.type -cne 'REG_DWORD') { Fail 'REGISTRY_VALUE_TYPE' 'Existing registry value is not REG_DWORD.' }
        if (-not (Same-State $current $request.expected)) { Fail 'REGISTRY_CAS_MISMATCH' 'Registry value changed before write.' }
        if ([bool]$request.desired.exists) {
          if ($null -eq $key) { $key = $base.CreateSubKey([string]$request.key, $true) }
          $signed = [int64]$request.desired.data
          if ($signed -gt 2147483647) { $signed -= 4294967296 }
          $key.SetValue([string]$request.name, [int32]$signed, [Microsoft.Win32.RegistryValueKind]::DWord)
        } else {
          if ($null -ne $key) { $key.DeleteValue([string]$request.name, $false) }
        }
        if ($null -ne $key) { $key.Flush() }
        $after = State $key ([string]$request.name)
        if (-not (Same-State $after $request.desired)) { Fail 'REGISTRY_WRITE_VERIFY' 'Registry value readback did not match.' }
        Send-Result $true $after $null $null
      } finally { if ($null -ne $key) { $key.Dispose() } }
    } else { Fail 'REGISTRY_REQUEST_INVALID' 'Registry operation is invalid.' }
  } finally { $base.Dispose() }
} catch {
  $exception = $_.Exception
  $denied = $false
  for ($cursor = $exception; $null -ne $cursor; $cursor = $cursor.InnerException) {
    if ($cursor -is [System.UnauthorizedAccessException] -or $cursor -is [System.Security.SecurityException]) { $denied = $true; break }
  }
  $code = if ($exception.Data.Contains('Code')) { [string]$exception.Data['Code'] } elseif ($denied) { 'REGISTRY_ACCESS_DENIED' } else { 'REGISTRY_HELPER_FAILED' }
  Send-Result $false $null $code $_.Exception.Message
  exit 1
}
