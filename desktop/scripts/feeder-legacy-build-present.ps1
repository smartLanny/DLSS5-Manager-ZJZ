param(
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [string]$VcVarsAll='C:\BuildTools\VS2022\VC\Auxiliary\Build\vcvarsall.bat'
)
$ErrorActionPreference='Stop'
$outputPath=[IO.Path]::GetFullPath($OutputDirectory)
$sourcePath=Join-Path $PSScriptRoot 'feeder-legacy-present.cpp'
if(Test-Path -LiteralPath $outputPath){throw 'Use a new output directory.'}
foreach($value in @($outputPath,$sourcePath,$VcVarsAll)){if($value -match '[%"\r\n!&|<>^]'){throw 'Unsupported build path character.'}}
New-Item -ItemType Directory -Path $outputPath | Out-Null
$rows=@()
foreach($arch in @('x64','x86')) {
    foreach($api in @('dx11','dx10')) {
        $targetPath=Join-Path $outputPath "$api-$arch"
        New-Item -ItemType Directory -Path $targetPath | Out-Null
        $vcArch=if($arch -eq 'x86'){'amd64_x86'}else{'x64'}
        $extra=if($api -eq 'dx10'){'/DFEED_D3D10=1'}else{''}
        $library=if($api -eq 'dx10'){'d3d10.lib'}else{'d3d11.lib'}
        $command=@"
@echo off
call "$VcVarsAll" $vcArch
if errorlevel 1 exit /b 1
cl /nologo /std:c++20 /EHsc /W4 /O2 /MT /utf-8 $extra "$sourcePath" /Fo"$targetPath\renderer.obj" /Fe"$targetPath\feeder-legacy-present.exe" /link /SUBSYSTEM:WINDOWS $library dxgi.lib d3dcompiler.lib user32.lib shell32.lib
if errorlevel 1 exit /b 1
"@
        $commandFile=Join-Path $targetPath 'build.cmd'
        [IO.File]::WriteAllText($commandFile,$command,[Text.Encoding]::Default)
        & $commandFile 2>&1 | Tee-Object -FilePath (Join-Path $targetPath 'build.log')
        if($LASTEXITCODE -ne 0){throw "Fixture $api/$arch compile failed."}
        $rows += [ordered]@{api=$api;architecture=$arch;file="$api-$arch/feeder-legacy-present.exe";sha256=(Get-FileHash -LiteralPath (Join-Path $targetPath 'feeder-legacy-present.exe')).Hash.ToLowerInvariant()}
    }
}
[ordered]@{schema=1;compileLinkVerified=$true;sourceSha256=(Get-FileHash -LiteralPath $sourcePath).Hash.ToLowerInvariant();files=$rows;gpuRun=$false}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $outputPath 'validation.json') -Encoding utf8
