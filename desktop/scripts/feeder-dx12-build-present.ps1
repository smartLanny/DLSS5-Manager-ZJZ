param(
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [string]$InteropDirectory=(Join-Path $PSScriptRoot '../build/feeder-dx12-stage-r1/nr_lab_interop'),
    [string]$VcVarsAll='C:\BuildTools\VS2022\VC\Auxiliary\Build\vcvarsall.bat'
)
$ErrorActionPreference='Stop'
$outputPath=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $outputPath){throw 'Use a new output directory; preserve previous fixture evidence.'}
$sourcePath=Join-Path $PSScriptRoot 'feeder-dx12-present.cpp'
$interopPath=(Resolve-Path -LiteralPath $InteropDirectory).Path
$abiHeader=Join-Path $interopPath 'nr_external_provider_abi.h'
if((Get-FileHash -LiteralPath $abiHeader).Hash.ToLowerInvariant() -ne 'fa59a07ad15b26e53485fbe2d39e6a92289f7d7ac6d860e1684d1e35426608b7'){throw 'The read-only Query ABI must match the actual fixed Core.'}
foreach($value in @($outputPath,$sourcePath,$VcVarsAll,$interopPath)){if($value -match '[%"\r\n!&|<>^]'){throw 'Unsupported build path character.'}}
New-Item -ItemType Directory -Path $outputPath | Out-Null
$command=@"
@echo off
call "$VcVarsAll" x64
if errorlevel 1 exit /b 1
cl /nologo /std:c++20 /EHsc /W4 /O2 /MT /utf-8 /I"$interopPath" "$sourcePath" /Fo"$outputPath\renderer.obj" /Fe"$outputPath\feeder-dx12-present.exe" /link /SUBSYSTEM:WINDOWS d3d12.lib dxgi.lib d3dcompiler.lib user32.lib shell32.lib
if errorlevel 1 exit /b 1
"@
$commandFile=Join-Path $outputPath 'build-present.cmd'
[IO.File]::WriteAllText($commandFile,$command,[Text.Encoding]::Default)
& $commandFile 2>&1 | Tee-Object -FilePath (Join-Path $outputPath 'build-present.log')
if($LASTEXITCODE -ne 0){throw 'DX12 fixture compile/link failed.'}
[ordered]@{sourceSha256=(Get-FileHash -LiteralPath $sourcePath).Hash.ToLowerInvariant();exeSha256=(Get-FileHash -LiteralPath (Join-Path $outputPath 'feeder-dx12-present.exe')).Hash.ToLowerInvariant();compileLinkVerified=$true;gpuRun=$false}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $outputPath 'build-present.json') -Encoding utf8
