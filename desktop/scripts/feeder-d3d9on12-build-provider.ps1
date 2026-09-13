param(
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [string]$SourceFile=(Join-Path $PSScriptRoot 'feeder-beta3/nr_feeder_d3d9.cpp'),
    [string]$StageRoot=(Join-Path $PSScriptRoot '../build/feeder-beta3-stage-r17'),
    [string]$VcVarsAll='C:\BuildTools\VS2022\VC\Auxiliary\Build\vcvarsall.bat'
)
$ErrorActionPreference='Stop'
$outputPath=[IO.Path]::GetFullPath($OutputDirectory)
$sourcePath=(Resolve-Path -LiteralPath $SourceFile).Path
$stagePath=(Resolve-Path -LiteralPath $StageRoot).Path
if(Test-Path -LiteralPath $outputPath){throw 'Use a new output directory.'}
foreach($value in @($outputPath,$sourcePath,$VcVarsAll,$stagePath)){if($value -match '[%"\r\n!&|<>^]'){throw 'Unsupported build path character.'}}
New-Item -ItemType Directory -Path $outputPath|Out-Null
$assets=@()
foreach($arch in @('x86','x64')){
    $archPath=Join-Path $outputPath $arch
    New-Item -ItemType Directory -Path $archPath|Out-Null
    $extension=if($arch -eq 'x86'){'addon32'}else{'addon64'}
    $binary=Join-Path $archPath "dlss5-feed-dx9.$extension"
    $command=@"
@echo off
call "$VcVarsAll" $arch
if errorlevel 1 exit /b 1
cl /nologo /std:c++20 /EHsc /W4 /O2 /MT /utf-8 /LD /I"$stagePath\src" /I"$stagePath\external\reshade\include" /I"$stagePath\external\imgui" "$sourcePath" /Fo"$archPath\provider.obj" /link /OUT:"$binary" /IMPLIB:"$archPath\provider.lib" /INCREMENTAL:NO /Brepro d3d9.lib d3d12.lib user32.lib
if errorlevel 1 exit /b 1
"@
    $commandFile=Join-Path $archPath 'build.cmd'
    [IO.File]::WriteAllText($commandFile,$command,[Text.Encoding]::Default)
    & $commandFile 2>&1|Tee-Object -FilePath (Join-Path $archPath 'build.log')
    if($LASTEXITCODE -ne 0){throw 'D3D9On12 provider compile failed.'}
    $assets+=@{architecture=$arch;sha256=(Get-FileHash -LiteralPath $binary).Hash.ToLowerInvariant();bytes=(Get-Item -LiteralPath $binary).Length;file=$binary}
}
[ordered]@{schema=1;sourceSha256=(Get-FileHash -LiteralPath $sourcePath).Hash.ToLowerInvariant();assets=$assets;compileLinkVerified=$true;gpuRun=$false}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $outputPath 'validation.json') -Encoding utf8
