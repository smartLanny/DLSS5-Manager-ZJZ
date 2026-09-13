param(
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [string]$DependencyRoot=(Join-Path $PSScriptRoot '../../dlss5-lab/staging/renodx-source'),
    [string]$DetoursArchive=(Join-Path $PSScriptRoot '../build/mfg-beta3-upstream/detours-9764ceb.zip'),
    [string]$VcVarsAll='C:\BuildTools\VS2022\VC\Auxiliary\Build\vcvarsall.bat'
)
$ErrorActionPreference='Stop'
$repoPath=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourcePath=Join-Path $repoPath 'native/mfgunlock'
$outputPath=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $outputPath){throw 'Use a new output directory so previous build evidence is retained.'}
foreach($value in @($outputPath,$sourcePath,$DependencyRoot,$VcVarsAll)){if($value -match '[%"\r\n!&|<>^]'){throw 'Unsupported build path character.'}}
$lock=Get-Content (Join-Path $sourcePath 'source-lock.json') -Raw|ConvertFrom-Json
& node (Join-Path $PSScriptRoot 'verify-fg-mfgunlock-source.js')
if($LASTEXITCODE -ne 0){throw 'MFG source-scope verification failed.'}
foreach($entry in $lock.upstream.files.PSObject.Properties){
    if((Get-FileHash -LiteralPath (Join-Path $sourcePath ('upstream/'+$entry.Name))).Hash.ToLowerInvariant() -ne $entry.Value){throw "Upstream source changed: $($entry.Name)"}
}
if((Get-FileHash -LiteralPath $DetoursArchive).Hash.ToLowerInvariant() -ne $lock.detours.archiveSha256){throw 'Detours archive does not match the pinned source.'}
New-Item -ItemType Directory -Path $outputPath | Out-Null
$depsPath=Join-Path $outputPath 'deps'
foreach($dependency in $lock.dependencies){
    $modulePath=Join-Path $DependencyRoot $dependency.relative
    foreach($entry in $dependency.files.PSObject.Properties){
        $inputPath=Join-Path $modulePath $entry.Name
        if((Get-FileHash -LiteralPath $inputPath).Hash.ToLowerInvariant() -ne $entry.Value){throw "Pinned header changed: $($dependency.id)/$($entry.Name)"}
        $destPath=Join-Path (Join-Path $depsPath $dependency.id) $entry.Name
        New-Item -ItemType Directory -Force -Path (Split-Path $destPath) | Out-Null
        Copy-Item -LiteralPath $inputPath -Destination $destPath
    }
}
Expand-Archive -LiteralPath $DetoursArchive -DestinationPath (Join-Path $depsPath 'detours')
$detoursPath=Join-Path $depsPath ('detours/Detours-'+$lock.detours.commit)
$command=@"
@echo off
call "$VcVarsAll" x64 -vcvars_ver=14.44 10.0.26100.0
if errorlevel 1 exit /b 1
pushd "$detoursPath\src"
nmake /nologo
if errorlevel 1 exit /b 1
popd
cl /nologo /std:c++20 /EHsc /W4 /O2 /MT /DNOMINMAX /DWIN32_LEAN_AND_MEAN "$repoPath\test\native\mfg-patch-gate.cpp" /Fo"$outputPath\mfg-patch-gate-test.obj" /Fe"$outputPath\mfg-patch-gate-test.exe"
if errorlevel 1 exit /b 1
"$outputPath\mfg-patch-gate-test.exe" > "$outputPath\mfg-patch-gate-test.json"
if errorlevel 1 exit /b 1
cl /nologo /std:c++20 /EHsc /W4 /O2 /MT /utf-8 /Zc:char8_t- /DNOMINMAX /DWIN32_LEAN_AND_MEAN /DUNICODE /D_UNICODE /LD /I"$depsPath\reshade" /I"$depsPath\streamline\include" /I"$depsPath\dlss\include" /I"$detoursPath\include" "$sourcePath\addon.cpp" /Fo"$outputPath\mfgunlock.obj" /link /OUT:"$outputPath\renodx-mfgunlock.addon64" /IMPLIB:"$outputPath\mfgunlock.lib" /INCREMENTAL:NO /Brepro "$detoursPath\lib.X64\detours.lib" kernel32.lib user32.lib
if errorlevel 1 exit /b 1
"@
$commandFile=Join-Path $outputPath 'build-mfgunlock.cmd'
[IO.File]::WriteAllText($commandFile,$command,[Text.Encoding]::Default)
& $commandFile 2>&1 | Tee-Object -FilePath (Join-Path $outputPath 'build-mfgunlock.log')
if($LASTEXITCODE -ne 0){throw 'MFG Unlock compilation failed.'}
$binaryPath=Join-Path $outputPath 'renodx-mfgunlock.addon64'
$report=[ordered]@{schema=1;provider=$lock.provider;upstreamCommit=$lock.upstream.commit;
    sourceLockSha256=(Get-FileHash -LiteralPath (Join-Path $sourcePath 'source-lock.json')).Hash.ToLowerInvariant();
    sourceSha256=(Get-FileHash -LiteralPath (Join-Path $sourcePath 'addon.cpp')).Hash.ToLowerInvariant();
    panelSha256=(Get-FileHash -LiteralPath (Join-Path $sourcePath 'panel_zh.inl')).Hash.ToLowerInvariant();
    binarySha256=(Get-FileHash -LiteralPath $binaryPath).Hash.ToLowerInvariant();abi=$lock.abi;compileLinkVerified=$true;
    runtimeSafetyPatches=$lock.localSafetyPatches;patchGateTest=(Get-Content -LiteralPath (Join-Path $outputPath 'mfg-patch-gate-test.json') -Raw|ConvertFrom-Json);
    gpuRun=$false;overlayVerified=$false}
$report|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $outputPath 'build-mfgunlock.json') -Encoding utf8
Write-Output "MFG Unlock compiled: $binaryPath"
