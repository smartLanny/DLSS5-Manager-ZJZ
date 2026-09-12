param(
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [string]$VcVarsAll='C:\BuildTools\VS2022\VC\Auxiliary\Build\vcvarsall.bat'
)
$ErrorActionPreference='Stop'
$repoPath=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourcePath=Join-Path $repoPath 'native/d3d9on12-shim'
$outputPath=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $outputPath){throw 'Use a fresh output directory to preserve prior evidence.'}
foreach($value in @($outputPath,$sourcePath,$VcVarsAll)){if($value -match '[%"\r\n!&|<>^]'){throw 'Unsupported build path character.'}}
$loaders=@{
    x86=@{file='ReShade32.dll';sha256='da430e0a9c6eecefa0d1b27d05e16c426fb5d04e808b194d914eaac4b31bc0f8';bytes=4398080}
    x64=@{file='ReShade64.dll';sha256='0cee63f9c9f13f3ac909c5b4903f4dbb4b719a7ab3b4f13b0deaf83c814b94f7';bytes=5592064}
}
New-Item -ItemType Directory -Path $outputPath|Out-Null
$assets=@()
foreach($architecture in @('x86','x64')){
    $loader=$loaders[$architecture]
    $loaderPath=Join-Path $repoPath ('resources/legacy-runtime/loaders/'+$loader.file)
    if((Get-FileHash -LiteralPath $loaderPath).Hash.ToLowerInvariant() -ne $loader.sha256 -or (Get-Item -LiteralPath $loaderPath).Length -ne $loader.bytes){throw 'Pinned ReShade input mismatch.'}
    $archPath=Join-Path $outputPath $architecture
    New-Item -ItemType Directory -Path $archPath|Out-Null
    $assembler=if($architecture -eq 'x86'){'ml'}else{'ml64'}
    $safeSeh=if($architecture -eq 'x86'){'/safeseh'}else{''}
    $command=@"
@echo off
call "$VcVarsAll" $architecture -vcvars_ver=14.44 10.0.26100.0
if errorlevel 1 exit /b 1
$assembler /nologo /c $safeSeh /Fo"$archPath\forward.obj" "$sourcePath\forward-$architecture.asm"
if errorlevel 1 exit /b 1
cl /nologo /std:c++17 /EHsc /W4 /WX /O2 /MT /utf-8 /DUNICODE /D_UNICODE /LD "$sourcePath\shim.cpp" /Fo"$archPath\shim.obj" /link "$archPath\forward.obj" /DEF:"$sourcePath\exports-$architecture.def" /OUT:"$archPath\d3d9.dll" /IMPLIB:"$archPath\d3d9.lib" /INCREMENTAL:NO /Brepro /DYNAMICBASE /NXCOMPAT bcrypt.lib kernel32.lib
if errorlevel 1 exit /b 1
dumpbin /exports "$archPath\d3d9.dll" > "$archPath\exports.txt"
if errorlevel 1 exit /b 1
dumpbin /imports "$archPath\d3d9.dll" > "$archPath\imports.txt"
if errorlevel 1 exit /b 1
"@
    $commandFile=Join-Path $archPath 'build-shim.cmd'
    [IO.File]::WriteAllText($commandFile,$command,[Text.Encoding]::Default)
    & $commandFile 2>&1|Tee-Object -FilePath (Join-Path $archPath 'build.log')
    if($LASTEXITCODE -ne 0){throw "$architecture D3D9On12 shim build failed."}
    $binaryPath=Join-Path $archPath 'd3d9.dll'
    $assets+=@{architecture=$architecture;file=$binaryPath;sha256=(Get-FileHash -LiteralPath $binaryPath).Hash.ToLowerInvariant();bytes=(Get-Item -LiteralPath $binaryPath).Length;loader=$loader}
}
$sources=[ordered]@{}
Get-ChildItem -LiteralPath $sourcePath -File|Sort-Object Name|ForEach-Object{$sources[$_.Name]=(Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant()}
[ordered]@{schema=1;id='xiaofeng-d3d9on12-shim-v1';toolset='14.44';sdk='10.0.26100.0';runtimeDirectory='_DLSS5_Feeder15';source=$sources;assets=$assets;compileVerified=$true;gpuVerified=$false;defenderVerified=$false}|ConvertTo-Json -Depth 7|Set-Content -LiteralPath (Join-Path $outputPath 'build-shim.json') -Encoding utf8
Write-Output "D3D9On12 shims built: $outputPath"
