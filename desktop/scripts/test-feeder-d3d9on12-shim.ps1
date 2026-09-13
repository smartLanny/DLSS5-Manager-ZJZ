param([Parameter(Mandatory=$true)][string]$BuildDirectory,[Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
$repoPath=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$buildPath=[IO.Path]::GetFullPath($BuildDirectory)
$outputPath=[IO.Path]::GetFullPath($OutputDirectory)
foreach($value in @($repoPath,$buildPath,$outputPath)){if($value -match '[%"\r\n!&|<>^]'){throw 'Unsupported test path character.'}}
if(Test-Path -LiteralPath $outputPath){throw 'Use a fresh isolated test directory.'}
New-Item -ItemType Directory -Path $outputPath|Out-Null
$results=@()
foreach($architecture in @('x86','x64')){
    $archPath=Join-Path $outputPath $architecture
    New-Item -ItemType Directory -Path $archPath|Out-Null
    $command=@"
@echo off
call "C:\BuildTools\VS2022\VC\Auxiliary\Build\vcvarsall.bat" $architecture -vcvars_ver=14.44 10.0.26100.0
if errorlevel 1 exit /b 1
cl /nologo /std:c++17 /EHsc /W4 /WX /O2 /MT "$repoPath\scripts\feeder-d3d9on12-shim-abi.cpp" /Fo"$archPath\fixture.obj" /Fe"$archPath\fixture.exe" /link /Brepro d3d9.lib kernel32.lib
if errorlevel 1 exit /b 1
"@
    $commandPath=Join-Path $archPath 'build-fixture.cmd'
    [IO.File]::WriteAllText($commandPath,$command,[Text.Encoding]::Default)
    & $commandPath 2>&1|Tee-Object -FilePath (Join-Path $archPath 'build.log')
    if($LASTEXITCODE -ne 0){throw 'ABI fixture compilation failed.'}
    $loaderName=if($architecture -eq 'x86'){'ReShade32.dll'}else{'ReShade64.dll'}
    $loaderSource=Join-Path $repoPath ('resources/legacy-runtime/loaders/'+$loaderName)
    foreach($case in @('missing','wrong-directory','corrupt','valid-enumerator','valid-create-first')){
        $casePath=Join-Path $archPath $case
        New-Item -ItemType Directory -Path $casePath|Out-Null
        Copy-Item -LiteralPath (Join-Path $archPath 'fixture.exe') -Destination (Join-Path $casePath 'fixture.exe')
        Copy-Item -LiteralPath (Join-Path $buildPath ($architecture+'/d3d9.dll')) -Destination (Join-Path $casePath 'd3d9.dll')
        if($case -eq 'wrong-directory'){Copy-Item -LiteralPath $loaderSource -Destination (Join-Path $casePath $loaderName)}
        if($case -in @('corrupt','valid-enumerator','valid-create-first')){
            $runtimePath=Join-Path $casePath '_DLSS5_Feeder15'
            New-Item -ItemType Directory -Path $runtimePath|Out-Null
            $loaderPath=Join-Path $runtimePath $loaderName
            Copy-Item -LiteralPath $loaderSource -Destination $loaderPath
            if($case -eq 'corrupt'){
                $bytes=[IO.File]::ReadAllBytes($loaderPath)
                $bytes[$bytes.Length-1]=$bytes[$bytes.Length-1] -bxor 1
                [IO.File]::WriteAllBytes($loaderPath,$bytes)
            }
            [IO.File]::WriteAllText((Join-Path $casePath 'ReShade.ini'),"[ADDON]`r`nAddonPath=.\_DLSS5_Feeder15\addons`r`n",[Text.UTF8Encoding]::new($false))
        }
        $process=Start-Process -FilePath (Join-Path $casePath 'fixture.exe') -ArgumentList $case -WorkingDirectory $casePath -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $casePath 'result.log') -RedirectStandardError (Join-Path $casePath 'stderr.log')
        if(!$process.WaitForExit(30000)){$process.Kill();throw 'Bounded ABI fixture timed out.'}
        $process.Refresh()
        $log=[IO.File]::ReadAllText((Join-Path $casePath 'result.log'))
        Write-Output $log.Trim()
        if($process.ExitCode -ne 0 -or $log -notmatch '(?m)^PASS '){throw "ABI case failed: $architecture/$case ($($process.ExitCode))."}
        $results+=@{architecture=$architecture;case=$case;exitCode=$process.ExitCode;log=$log.Trim()}
    }
}
[ordered]@{schema=1;suite='real-loader-no-device-ABI';gpuDeviceCreated=$false;cases=$results}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $outputPath 'acceptance.json') -Encoding utf8
