[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$AppPath,
  [switch]$InspectOnly,
  [switch]$AcceptNoSandbox,
  [string]$LogDirectory
)

$ErrorActionPreference = 'Stop'
$script:CompatibleLogFile = $null

function Write-CompatibleLaunchEvent {
  param([string]$Stage, [hashtable]$Details = @{})
  try {
    if (-not $script:CompatibleLogFile) {
      $roots = @()
      if ($LogDirectory) { $roots = @($LogDirectory) }
      else {
        if ($env:LOCALAPPDATA) { $roots += Join-Path $env:LOCALAPPDATA 'xiaofeng-dlss5-manager\startup' }
        $roots += Join-Path ([IO.Path]::GetTempPath()) 'xiaofeng-dlss5-manager\startup'
      }
      foreach ($root in $roots) {
        try {
          $directory = [IO.Path]::GetFullPath($root)
          $null = New-Item -ItemType Directory -Path $directory -Force
          if (((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
          $candidate = Join-Path $directory ('startup-' + [guid]::NewGuid().ToString() + '.log')
          $stream = [IO.File]::Open($candidate, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
          $stream.Dispose(); $script:CompatibleLogFile = $candidate; break
        } catch { }
      }
    }
    if (-not $script:CompatibleLogFile) { return }
    $row = [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); stage = $Stage }
    foreach ($key in $Details.Keys) {
      $value = $Details[$key]
      if ($value -is [string]) {
        $value = [regex]::Replace($value, '(?i)(?:[a-z]:[\\/]|\\\\)[^\r\n\t"<>|]*', '<路径>')
        if ($value.Length -gt 1600) { $value = $value.Substring(0, 1600) }
      }
      $row[$key] = $value
    }
    if ((Get-Item -LiteralPath $script:CompatibleLogFile).Length -lt 16384) {
      [IO.File]::AppendAllText($script:CompatibleLogFile, (($row | ConvertTo-Json -Compress) + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
    }
  } catch { }
}

function Resolve-CompatibleTarget {
  param([string]$Requested, [string]$Directory = $PSScriptRoot)
  if (-not [string]::IsNullOrWhiteSpace($Requested)) {
    $item = Get-Item -LiteralPath $Requested -ErrorAction Stop
    if ($item.PSIsContainer -or $item.Extension -ine '.exe') { throw '请选择管理器 EXE，不能选择文件夹、快捷方式或游戏。' }
    if ($item.Name -match '(?i)setup|uninstall|unins|安装版|卸载') { throw '请选择便携版或已安装的管理器主程序，不能选择 Setup 安装器。' }
    return $item.FullName
  }
  $candidates = @(Get-ChildItem -LiteralPath $Directory -File -Filter '*.exe' | Where-Object {
    ($_.Name -eq 'DLSS 5 AI 超分管理器.exe' -or $_.Name -match '(?i)DLSS5-Manager-.+-portable[.]exe$') -and
    $_.Name -notmatch '(?i)setup|uninstall|unins|安装版|卸载'
  })
  if ($candidates.Count -ne 1) {
    throw '没有找到唯一的管理器。请把要启动的便携版或已安装主程序 EXE 拖到“兼容启动.cmd”上。不要拖 Setup 安装器。'
  }
  return $candidates[0].FullName
}

function Get-CompatibleTargetInfo {
  param([string]$File)
  $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($File)
  if ($version.ProductName -ne 'DLSS 5 AI 超分管理器') {
    throw '所选文件的产品信息不是 DLSS 5 AI 超分管理器，已停止启动。'
  }
  # NSIS Setup and portable wrappers can share a product name. The known
  # portable leaf is required unless this is the unpacked Electron main EXE.
  $name = [IO.Path]::GetFileName($File)
  if ($name -ne 'DLSS 5 AI 超分管理器.exe' -and $name -notmatch '(?i)DLSS5-Manager-.+-portable[.]exe$') {
    throw '请保留发行包的原始便携版文件名，或选择已安装的“DLSS 5 AI 超分管理器.exe”。'
  }
  return [pscustomobject]@{ File = $name; Product = $version.ProductName; Version = $version.FileVersion; Mode = 'temporary-no-sandbox' }
}

function Invoke-CompatibleStartup {
  param([string]$Requested, [switch]$Inspect, [switch]$Accepted)
  $script:CompatibleLogFile = $null
  try {
  $target = Resolve-CompatibleTarget $Requested
  $info = Get-CompatibleTargetInfo $target
  if ($Inspect) { Write-Host ($info | ConvertTo-Json -Compress); return 0 }
  Write-CompatibleLaunchEvent 'compatibility-helper-start' @{ product = $info.Product; version = $info.Version }

  Write-Host ''
  Write-Host 'DLSS 5 AI 超分管理器 · 临时兼容启动' -ForegroundColor Cyan
  Write-Host ('文件：{0}  版本：{1}' -f $info.File, $info.Version)
  Write-Host '仅用于普通启动失败的排障。本次将关闭管理器所有 Chromium 子进程的沙箱，降低进程隔离保护。' -ForegroundColor Yellow
  Write-Host '不会修改游戏、系统策略或快捷方式；直接打开原 EXE 仍使用正常启动。'
  Write-Host '请先关闭已打开的管理器。此入口不会结束任何现有进程。'
  if (-not $Accepted) {
    $answer = Read-Host '输入 Y 同意本次兼容启动，其他输入取消'
    if ($answer -notmatch '^[Yy]$') { Write-CompatibleLaunchEvent 'compatibility-launch-cancelled'; Write-Host '已取消，未启动程序。'; return 2 }
  }
  Write-CompatibleLaunchEvent 'compatibility-consent' @{ noSandbox = $true; persistent = $false }

  # Pass only the fixed opt-in switch. Never copy environment flags, launch a
  # shell command built from the EXE path, persist flags, or retry automatically.
  $launched = Start-Process -FilePath $target -ArgumentList '--no-sandbox' -WorkingDirectory ([IO.Path]::GetDirectoryName($target)) -WindowStyle Normal -PassThru
  Write-CompatibleLaunchEvent 'compatibility-process-started' @{ pid = $launched.Id; rendererReady = $false }
  Write-Host ('已发起兼容启动（启动进程 {0}）。这不代表界面已经加载成功。' -f $launched.Id)
  Write-Host '请确认管理器窗口正常出现；若仍打不开，运行“启动诊断.cmd”并提供本次报告。'
  if ($script:CompatibleLogFile) { Write-Host ('启动记录：' + $script:CompatibleLogFile) }
  return 0
  } catch {
    Write-CompatibleLaunchEvent 'compatibility-launch-failed' @{ message = $_.Exception.Message }
    if ($script:CompatibleLogFile) { Write-Host ('失败记录：' + $script:CompatibleLogFile) }
    throw
  }
}

# Dot-sourcing exposes the same target validation and launch functions to the
# focused tests without launching a program or changing the machine.
if ($MyInvocation.InvocationName -ne '.') {
  try { exit (Invoke-CompatibleStartup -Requested $AppPath -Inspect:$InspectOnly -Accepted:$AcceptNoSandbox) }
  catch {
    Write-Host ('无法发起兼容启动：{0}' -f $_.Exception.Message) -ForegroundColor Red
    exit 1
  }
}
