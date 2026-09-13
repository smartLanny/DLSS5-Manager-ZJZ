param(
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [string]$SourceFile=(Join-Path $PSScriptRoot 'feeder-d3d9on12-probe.cpp'),
    [ValidateSet('x86','x64')][string]$Architecture='x86',
    [string]$StageRoot=(Join-Path $PSScriptRoot '../build/feeder-beta3-stage-r16'),
    [string]$VcVarsAll='C:\BuildTools\VS2022\VC\Auxiliary\Build\vcvarsall.bat'
)
$ErrorActionPreference='Stop'
$outputPath=[IO.Path]::GetFullPath($OutputDirectory)
$sourcePath=(Resolve-Path -LiteralPath $SourceFile).Path
$stagePath=(Resolve-Path -LiteralPath $StageRoot).Path
if(Test-Path -LiteralPath $outputPath){throw 'Use a new output directory.'}
foreach($value in @($outputPath,$sourcePath,$VcVarsAll,$stagePath)){if($value -match '[%"\r\n!&|<>^]'){throw 'Unsupported build path character.'}}
New-Item -ItemType Directory -Path $outputPath | Out-Null
$command=@"
@echo off
call "$VcVarsAll" $Architecture
if errorlevel 1 exit /b 1
cl /nologo /std:c++20 /EHsc /W4 /O2 /MT /utf-8 /I"$stagePath\src" /I"$stagePath\external\reshade\include" "$sourcePath" /Fo"$outputPath\probe.obj" /Fe"$outputPath\feeder-d3d9on12-probe.exe" /link /SUBSYSTEM:WINDOWS d3d9.lib d3d12.lib dxgi.lib user32.lib shell32.lib
if errorlevel 1 exit /b 1
"@
$commandFile=Join-Path $outputPath 'build.cmd'
[IO.File]::WriteAllText($commandFile,$command,[Text.Encoding]::Default)
& $commandFile 2>&1 | Tee-Object -FilePath (Join-Path $outputPath 'build.log')
if($LASTEXITCODE -ne 0){throw 'D3D9On12 probe compile failed.'}
[ordered]@{schema=1;architecture=$Architecture;compileLinkVerified=$true;sourceSha256=(Get-FileHash -LiteralPath $sourcePath).Hash.ToLowerInvariant();sha256=(Get-FileHash -LiteralPath (Join-Path $outputPath 'feeder-d3d9on12-probe.exe')).Hash.ToLowerInvariant();gpuRun=$false}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $outputPath 'validation.json') -Encoding utf8
