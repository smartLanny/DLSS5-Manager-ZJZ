param(
    [Parameter(Mandatory=$true)][string]$StageRoot,
    [Parameter(Mandatory=$true)][string]$OutputRoot,
    [string]$VcVarsAll = 'C:\BuildTools\VS2022\VC\Auxiliary\Build\vcvarsall.bat'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$stagePath = (Resolve-Path -LiteralPath $StageRoot).Path
$vcPath = (Resolve-Path -LiteralPath $VcVarsAll).Path
$outPath = [IO.Path]::GetFullPath($OutputRoot)
if (Test-Path -LiteralPath $outPath) { throw 'Use a new output directory; previous build evidence is retained.' }
foreach ($value in @($stagePath,$vcPath,$outPath)) {
    if ($value -match '[%"\r\n!&|<>^]') { throw 'Unsupported command character in build path.' }
}
$manifest = Get-Content -LiteralPath (Join-Path $stagePath 'beta3-source-manifest.json') -Raw | ConvertFrom-Json
if ($manifest.upstreamCommit -ne '3f624855276c4bde55145c712782477639b30e85' -or $manifest.ipcVersion -ne 9) { throw 'Unexpected Feeder source identity.' }
foreach ($entry in $manifest.files.PSObject.Properties) {
    $file = [IO.Path]::GetFullPath((Join-Path $stagePath $entry.Name))
    if (!$file.StartsWith($stagePath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
        (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value) { throw "Source changed: $($entry.Name)" }
}
New-Item -ItemType Directory -Path $outPath | Out-Null
$includes = '/Inr_lab_interop /Iexternal\reshade\include /Iexternal\ngx /Iexternal\vulkan /Iexternal\imgui /Iexternal\minhook\include'
$hooks = 'external\minhook\src\buffer.c external\minhook\src\hook.c external\minhook\src\trampoline.c'
$tasks = @(
    @{ name='native'; target='dlss5-feed.addon64'; arch='x64'; command="/LD src\dlss5-feed.cpp $hooks external\minhook\src\hde\hde64.c"; libraries='external\ngx\libs\nvsdk_ngx_d.lib version.lib kernel32.lib user32.lib advapi32.lib ole32.lib' },
    @{ name='host'; target='dlss5-feed-host64.exe'; arch='x64'; command='host\dlss5-feed-host64.cpp'; libraries='external\ngx\libs\nvsdk_ngx_d.lib version.lib winmm.lib kernel32.lib user32.lib gdi32.lib advapi32.lib ole32.lib' },
    @{ name='x86'; target='dlss5-feed.addon32'; arch='amd64_x86'; command="/LD src\dlss5-feed32.cpp $hooks external\minhook\src\hde\hde32.c"; libraries='d3d11.lib dwmapi.lib kernel32.lib user32.lib advapi32.lib' },
    @{ name='relay64'; target='dlss5-feed-relay.addon64'; arch='x64'; command="/DNR_FEED_RELAY_X64=1 /LD src\dlss5-feed32.cpp $hooks external\minhook\src\hde\hde64.c"; libraries='d3d11.lib dwmapi.lib kernel32.lib user32.lib advapi32.lib' }
)
$outputs = @()
foreach ($task in $tasks) {
    $objectPath = Join-Path $outPath $task.name
    New-Item -ItemType Directory -Path $objectPath | Out-Null
    $binary = Join-Path $outPath $task.target
    $command = @"
@echo off
call "$vcPath" $($task.arch)
if errorlevel 1 exit /b 1
cd /d "$stagePath"
cl /nologo /EHsc /O2 /MD /W3 /utf-8 /std:c++20 $includes /Fo"$objectPath\\" /Fd"$objectPath\\" $($task.command) /link /OUT:"$binary" /IMPLIB:"$objectPath\provider.lib" $($task.libraries)
if errorlevel 1 exit /b 1
exit /b 0
"@
    $commandFile = Join-Path $objectPath 'build.cmd'
    [IO.File]::WriteAllText($commandFile, $command, [Text.Encoding]::Default)
    & $commandFile 2>&1 | Tee-Object -FilePath (Join-Path $objectPath 'build.log')
    if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $binary)) { throw "Feeder $($task.name) compile/link failed." }
    $outputs += [ordered]@{ name=$task.target; architecture=$task.arch; sha256=(Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant(); bytes=(Get-Item -LiteralPath $binary).Length }
}
[ordered]@{ schema=1; source=$manifest; files=$outputs; compileLinkVerified=$true; controlledRuntimeVerified=$false; realGameVerified=$false } |
    ConvertTo-Json -Depth 9 | Set-Content -LiteralPath (Join-Path $outPath 'validation.json') -Encoding utf8
