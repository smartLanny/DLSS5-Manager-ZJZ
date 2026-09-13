$ErrorActionPreference = 'Stop'

function Add-Warning([System.Collections.Generic.List[object]] $warnings, [string] $code, [string] $message) {
  $warnings.Add([pscustomobject]@{ code = $code; message = $message; source = 'dotnet-registry-snapshot' })
}

function Read-RegistrySnapshot {
  $warnings = [System.Collections.Generic.List[object]]::new()
  $steamPath = $null
  $gog = [System.Collections.Generic.List[object]]::new()
  $options = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames

  try {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
      [Microsoft.Win32.RegistryHive]::CurrentUser,
      [Microsoft.Win32.RegistryView]::Registry64)
    try {
      $key = $base.OpenSubKey('Software\Valve\Steam', $false)
      try {
        if ($null -ne $key) { $steamPath = [string]$key.GetValue('SteamPath', $null, $options) }
      } finally { if ($null -ne $key) { $key.Dispose() } }
    } finally { $base.Dispose() }
  } catch { Add-Warning $warnings 'LAUNCHER_STEAM_REGISTRY_FAILED' 'Steam 注册表快照读取失败，继续使用默认目录与已保存路径。' }

  try {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
      [Microsoft.Win32.RegistryHive]::LocalMachine,
      [Microsoft.Win32.RegistryView]::Registry64)
    try {
      $root = $base.OpenSubKey('SOFTWARE\WOW6432Node\GOG.com\Games', $false)
      try {
        if ($null -ne $root) {
          foreach ($name in ($root.GetSubKeyNames() | Select-Object -First 4096)) {
            $key = $root.OpenSubKey($name, $false)
            try {
              if ($null -eq $key) { continue }
              $path = [string]$key.GetValue('path', $null, $options)
              if ([string]::IsNullOrWhiteSpace($path)) { continue }
              $gog.Add([pscustomobject]@{
                id = [string]$name
                name = [string]$key.GetValue('gameName', $name, $options)
                path = $path
              })
            } finally { if ($null -ne $key) { $key.Dispose() } }
          }
        }
      } finally { if ($null -ne $root) { $root.Dispose() } }
    } finally { $base.Dispose() }
  } catch { Add-Warning $warnings 'LAUNCHER_GOG_REGISTRY_FAILED' 'GOG 注册表快照读取失败，保留其它扫描来源。' }

  [pscustomobject]@{
    version = 1
    ok = $true
    steamPath = $steamPath
    gog = @($gog)
    warnings = @($warnings)
  } | ConvertTo-Json -Depth 8 -Compress
}

try { Read-RegistrySnapshot }
catch {
  [pscustomobject]@{
    version = 1
    ok = $false
    steamPath = $null
    gog = @()
    warnings = @([pscustomobject]@{
      code = 'LAUNCHER_REGISTRY_SNAPSHOT_FAILED'
      message = '启动器注册表快照不可用，继续使用默认目录与已保存路径。'
      source = 'dotnet-registry-snapshot'
    })
  } | ConvertTo-Json -Depth 8 -Compress
}
