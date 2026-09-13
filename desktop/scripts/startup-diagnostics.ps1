param(
  [string]$InstallPath,
  [string]$OutputPath,
  [string]$TempPath = $env:TEMP,
  [string]$StartupLogPath = (Join-Path $env:LOCALAPPDATA 'xiaofeng-dlss5-manager\startup'),
  [string]$SourcePath = $PSScriptRoot,
  [string]$ExecutableName = 'DLSS 5 AI 超分管理器.exe',
  [switch]$NoUI
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($InstallPath)) {
  $InstallPath = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot $ExecutableName) -PathType Leaf) { $PSScriptRoot }
    else { Join-Path $env:LOCALAPPDATA 'Programs\xiaofeng-dlss5-manager' }
}
$script:Lines = New-Object System.Collections.Generic.List[string]
$script:Failures = 0
$script:Warnings = 0
function Add-Line([string]$Text = '') { $script:Lines.Add($Text) }
function Add-Check([string]$Name, [string]$Status, [string]$Detail) {
  if ($Status -eq 'FAIL') { $script:Failures++ } elseif ($Status -eq 'UNKNOWN' -or $Status -eq 'WARN') { $script:Warnings++ }
  Add-Line ('[{0}] {1}: {2}' -f $Status, $Name, $Detail)
}
function Replace-IgnoreCase([string]$Text, [string]$Value, [string]$Label) {
  if ([string]::IsNullOrEmpty($Value)) { return $Text }
  return [regex]::Replace($Text, [regex]::Escape([IO.Path]::GetFullPath($Value).TrimEnd('\')), $Label,
    [Text.RegularExpressions.RegexOptions]::IgnoreCase)
}
function Redact([string]$Text, [switch]$LogContent) {
  if ($null -eq $Text) { return '' }
  $value = [string]$Text
  if ($LogContent) {
    # Startup logs are not allowed to disclose arbitrary game/config paths.
    # Do this before friendly HOME/TEMP substitutions so a path under HOME is
    # removed as a whole instead of leaving its game-relative suffix.
    $value = [regex]::Replace($value, '(?i)(?:[A-Z]:\\|\\\\)[^\r\n\t"<>|]{2,}', '<PATH>')
  }
  $roots = @(
    @{ value = $env:USERPROFILE; label = '%USERPROFILE%' },
    @{ value = $env:LOCALAPPDATA; label = '%LOCALAPPDATA%' },
    @{ value = $env:APPDATA; label = '%APPDATA%' },
    @{ value = $TempPath; label = '%TEMP%' }
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_.value) } | Sort-Object { $_.value.Length } -Descending
  foreach ($root in $roots) { try { $value = Replace-IgnoreCase $value $root.value $root.label } catch {} }
  if (-not [string]::IsNullOrWhiteSpace($env:USERNAME)) { $value = [regex]::Replace($value, [regex]::Escape($env:USERNAME), '%USERNAME%', [Text.RegularExpressions.RegexOptions]::IgnoreCase) }
  if ($LogContent) {
    $value = ($value -split '\r?\n' | ForEach-Object { if ($_.Length -gt 1000) { $_.Substring(0, 1000) + '…' } else { $_ } }) -join "`n"
  }
  return $value
}
function Try-File([string]$File, [int64]$Minimum = 1) {
  try {
    $item = Get-Item -LiteralPath $File -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -and $item.Length -ge $Minimum) { return @{ ok = $true; size = $item.Length } }
    return @{ ok = $false; reason = '不是有效文件或文件为空' }
  } catch { return @{ ok = $false; reason = $_.Exception.Message } }
}
function Test-DirectoryWritable([string]$Directory) {
  try {
    if ([string]::IsNullOrWhiteSpace($Directory) -or -not (Test-Path -LiteralPath $Directory -PathType Container)) { return @{ ok = $false; reason = '目录不存在' } }
    $probe = Join-Path $Directory ('.xiaofeng-startup-probe-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try { [IO.File]::WriteAllText($probe, 'probe', (New-Object Text.UTF8Encoding($false))); return @{ ok = $true } }
    finally { if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue } }
  } catch { return @{ ok = $false; reason = $_.Exception.Message } }
}
function Choose-Output([string]$Requested) {
  $name = 'xiaofeng-startup-diagnostics-{0}.txt' -f (Get-Date -Format 'yyyyMMdd-HHmmss')
  $candidates = New-Object System.Collections.Generic.List[string]
  if (-not [string]::IsNullOrWhiteSpace($Requested)) {
    if (Test-Path -LiteralPath $Requested -PathType Container) { $candidates.Add((Join-Path $Requested $name)) } else { $candidates.Add([IO.Path]::GetFullPath($Requested)) }
  }
  foreach ($dir in @($PSScriptRoot, [Environment]::GetFolderPath('Desktop'), $TempPath)) {
    if (-not [string]::IsNullOrWhiteSpace($dir)) { $candidate = Join-Path $dir $name; if (-not $candidates.Contains($candidate)) { $candidates.Add($candidate) } }
  }
  foreach ($candidate in $candidates) {
    try {
      $parent = Split-Path -Parent $candidate
      if (-not (Test-DirectoryWritable $parent).ok) { continue }
      return $candidate
    } catch {}
  }
  throw '找不到可写的报告目录。'
}
function Read-LogTail([string]$File, [int]$Limit) {
  $stream = [IO.File]::Open($File, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
  try {
    $count = [int][Math]::Min([int64]$Limit, $stream.Length); if ($count -eq 0) { return '' }
    $truncated = $count -lt $stream.Length
    $null = $stream.Seek(-$count, [IO.SeekOrigin]::End); $bytes = New-Object byte[] $count; $read = $stream.Read($bytes, 0, $count)
    $text = [Text.Encoding]::UTF8.GetString($bytes, 0, $read)
    if ($truncated) { $newline = $text.IndexOf("`n"); if ($newline -ge 0) { $text = $text.Substring($newline + 1) } else { return '' } }
    return $text
  } finally { $stream.Dispose() }
}

Add-Line '小枫 DLSS 5 Manager 启动诊断'
Add-Line ('生成时间: {0:o}' -f (Get-Date))
Add-Line '范围: 只读检查安装文件、临时目录、同名进程和限定 startup 日志；不启动或终止程序。'
Add-Line ''
Add-Line '== 启动环境（仅记录是否设置，不导出值） =='
foreach ($name in @('NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', '__COMPAT_LAYER', 'TEMP', 'TMP')) {
  $present = -not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($name))
  Add-Line ('{0}: {1}' -f $name, $(if ($present) { '已设置' } else { '未设置' }))
}
Add-Line 'GPU process 不可用可能涉及子进程或安全策略。--disable-gpu 不是通用解法；本工具不启用 --no-sandbox，也不更改系统策略。'
Add-Line ''
Add-Line '== 安装与 Electron 文件 =='
$install = try { [IO.Path]::GetFullPath($InstallPath) } catch { $null }
if ($null -eq $install -or -not (Test-Path -LiteralPath $install -PathType Container)) {
  Add-Check '安装目录' 'FAIL' (Redact ($InstallPath + '（不存在或路径无效）'))
} else {
  Add-Check '安装目录' 'OK' (Redact $install)
  $exe = Join-Path $install $ExecutableName; $exeCheck = Try-File $exe 1048576
  if ($exeCheck.ok) {
    $version = try { ([Diagnostics.FileVersionInfo]::GetVersionInfo($exe)).FileVersion } catch { '' }
    Add-Check '主程序 EXE' 'OK' ('{0}，{1:N0} bytes{2}' -f $ExecutableName, $exeCheck.size, $(if ($version) { '，版本 ' + $version } else { '' }))
  } else {
    Add-Check '主程序 EXE' 'FAIL' (Redact ($ExecutableName + '：' + $exeCheck.reason))
    try { $alternatives = @(Get-ChildItem -LiteralPath $install -File -Filter '*.exe' | Where-Object { $_.Name -notmatch '^Uninstall ' } | Select-Object -First 5 -ExpandProperty Name); if ($alternatives.Count) { Add-Line ('  找到其他 EXE: ' + ($alternatives -join '、')) } } catch {}
  }
  $expected = @(
    'resources\app.asar', 'icudtl.dat', 'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin',
    'chrome_100_percent.pak', 'chrome_200_percent.pak', 'ffmpeg.dll', 'd3dcompiler_47.dll',
    'vulkan-1.dll', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json'
  )
  if ((Test-Path -LiteralPath (Join-Path $install 'dxcompiler.dll')) -or (Test-Path -LiteralPath (Join-Path $install 'dxil.dll'))) {
    $expected += @('dxcompiler.dll', 'dxil.dll')
  } else { $expected += @('libEGL.dll', 'libGLESv2.dll') }
  foreach ($rel in $expected) {
    $check = Try-File (Join-Path $install $rel)
    Add-Check ('随包文件 ' + $rel) $(if ($check.ok) { 'OK' } else { 'FAIL' }) $(if ($check.ok) { ('{0:N0} bytes' -f $check.size) } else { Redact $check.reason })
  }
  try {
    $localeCount = @(Get-ChildItem -LiteralPath (Join-Path $install 'locales') -File -Filter '*.pak' -ErrorAction Stop).Count
    Add-Check 'Electron locales' $(if ($localeCount -gt 0) { 'OK' } else { 'FAIL' }) ($localeCount.ToString() + ' 个 .pak')
  } catch { Add-Check 'Electron locales' 'FAIL' (Redact $_.Exception.Message) }
  Add-Line '  注: 当前配套按实际 Electron 运行库布局检查；version.dll 不属于管理器的必需运行文件。'
}

Add-Line ''
Add-Line '== 安装包或 portable 来源目录 =='
try {
  $source = [IO.Path]::GetFullPath($SourcePath)
  if (-not (Test-Path -LiteralPath $source -PathType Container)) { Add-Check '工具/安装包目录' 'UNKNOWN' (Redact ($source + '（不存在）')) }
  else {
    Add-Check '工具/安装包目录' 'OK' (Redact $source)
    $packages = @(Get-ChildItem -LiteralPath $source -File -ErrorAction Stop | Where-Object { $_.Name -match '(?i)(setup|portable|external).*\.exe$' } | Select-Object -First 10)
    if ($packages.Count) { foreach ($item in $packages) { Add-Line ('  {0} ({1:N0} bytes)' -f $item.Name, $item.Length) } }
    else { Add-Line '  未在该目录发现名称含 Setup / portable / external 的 EXE；这不表示主程序一定损坏。' }
  }
} catch { Add-Check '工具/安装包目录' 'UNKNOWN' (Redact $_.Exception.Message) }

Add-Line ''
Add-Line '== TEMP 与磁盘空间 =='
$temp = Test-DirectoryWritable $TempPath
Add-Check 'TEMP 写入' $(if ($temp.ok) { 'OK' } else { 'FAIL' }) $(if ($temp.ok) { Redact ([IO.Path]::GetFullPath($TempPath)) } else { Redact $temp.reason })
try {
  $root = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($TempPath)); $drive = New-Object IO.DriveInfo($root); $free = [int64]$drive.AvailableFreeSpace
  Add-Check 'TEMP 可用空间' $(if ($free -lt 536870912) { 'WARN' } else { 'OK' }) ('{0:N0} bytes' -f $free)
} catch { Add-Check 'TEMP 可用空间' 'UNKNOWN' (Redact $_.Exception.Message) }

Add-Line ''
Add-Line '== 同产品进程 =='
try {
  $processName = [IO.Path]::GetFileNameWithoutExtension($ExecutableName); $count = @(Get-Process -Name $processName -ErrorAction SilentlyContinue).Count
  Add-Check '同名运行实例' $(if ($count -gt 0) { 'WARN' } else { 'OK' }) ($count.ToString() + ' 个；未终止进程，也未读取命令行。')
} catch { Add-Check '同名运行实例' 'UNKNOWN' (Redact $_.Exception.Message) }

Add-Line ''
Add-Line '== 本程序最近的 Windows 崩溃摘要 =='
try {
  # A native Chromium abort may precede Node's error handlers. Export only
  # the matching executable's named fields, never full event messages.
  $query = New-Object System.Diagnostics.Eventing.Reader.EventLogQuery('Application', [System.Diagnostics.Eventing.Reader.PathType]::LogName, '*[System[(EventID=1000) and TimeCreated[timediff(@SystemTime) <= 86400000]]]')
  $query.ReverseDirection = $true
  $reader = New-Object System.Diagnostics.Eventing.Reader.EventLogReader($query)
  $found = 0; $examined = 0
  $eventWatch = [Diagnostics.Stopwatch]::StartNew()
  try {
    while ($examined -lt 100 -and $found -lt 3 -and $eventWatch.ElapsedMilliseconds -lt 1500) {
      $event = $reader.ReadEvent([TimeSpan]::FromMilliseconds(150)); if ($null -eq $event) { break }; $examined++
      try {
        [xml]$xml = $event.ToXml(); $data = @{}
        foreach ($field in $xml.Event.EventData.Data) { if ($field.Name) { $data[[string]$field.Name] = [string]$field.'#text' } }
        if ($data['AppName'] -ieq $ExecutableName) {
          $found++
          Add-Line ('时间={0:o}; 程序={1}; 故障模块={2}; 异常码={3}' -f $event.TimeCreated, $ExecutableName, (Redact $data['ModuleName'] -LogContent), $data['ExceptionCode'])
        }
      } finally { $event.Dispose() }
    }
  } finally { $reader.Dispose() }
  if ($found -eq 0) { Add-Check '崩溃摘要' 'UNKNOWN' '在限定范围内没有匹配记录；不表示启动成功。' }
} catch { Add-Check '崩溃摘要' 'UNKNOWN' ('无法读取本程序崩溃摘要：' + (Redact $_.Exception.Message -LogContent)) }

Add-Line ''
Add-Line '== startup 简日志 =='
try {
  if (-not (Test-Path -LiteralPath $StartupLogPath -PathType Container)) { Add-Check 'startup 日志目录' 'UNKNOWN' '目录尚不存在。' }
  else {
    Add-Check 'startup 日志目录' 'OK' (Redact ([IO.Path]::GetFullPath($StartupLogPath)))
    $logs = @(Get-ChildItem -LiteralPath $StartupLogPath -File -ErrorAction Stop | Where-Object { $_.Length -le 65536 -and $_.Extension -match '^\.(log|txt|jsonl)$' } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 4)
    if (-not $logs.Count) { Add-Line '  没有找到不超过 64 KiB 的 startup 简日志。' }
    foreach ($log in $logs) {
      Add-Line ('-- {0} | {1:o} | {2:N0} bytes | tail <= 24 KiB --' -f $log.Name, $log.LastWriteTime, $log.Length)
      try { Add-Line (Redact (Read-LogTail $log.FullName 24576) -LogContent) } catch { Add-Line ('[读取失败] ' + (Redact $_.Exception.Message -LogContent)); $script:Warnings++ }
    }
  }
} catch { Add-Check 'startup 日志' 'UNKNOWN' (Redact $_.Exception.Message) }

Add-Line ''
Add-Line ('结果: FAIL={0}, WARN/UNKNOWN={1}' -f $script:Failures, $script:Warnings)
Add-Line 'available/OK 仅表示文件或基础条件可读，不证明 Electron 已创建窗口。'

$report = ($script:Lines -join "`r`n") + "`r`n"
$encoding = New-Object Text.UTF8Encoding($true); $bytes = $encoding.GetBytes($report)
if ($bytes.Length -gt 131072) {
  $suffix = $encoding.GetBytes("`r`n[TRUNCATED] 报告已限制为 128 KiB。`r`n")
  $kept = New-Object byte[] (131072 - $suffix.Length); [Array]::Copy($bytes, $kept, $kept.Length)
  $bytes = New-Object byte[] 131072; [Array]::Copy($kept, $bytes, $kept.Length); [Array]::Copy($suffix, 0, $bytes, $kept.Length, $suffix.Length)
}

try {
  $destination = Choose-Output $OutputPath
  [IO.File]::WriteAllBytes($destination, $bytes)
  Write-Host ('诊断完成：' + (Redact $destination)) -ForegroundColor Green
  Write-Host ('发现 FAIL={0}，WARN/UNKNOWN={1}。请把生成的 txt 发给维护者。' -f $script:Failures, $script:Warnings)
  if (-not $NoUI) { Write-Host '此工具没有启动或修改 Manager。按窗口提示返回即可。' }
  exit $(if ($script:Failures -gt 0) { 2 } else { 0 })
} catch {
  Write-Error ('无法写出诊断报告：' + (Redact $_.Exception.Message))
  exit 3
}
