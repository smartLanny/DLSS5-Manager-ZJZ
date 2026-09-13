param(
    [Parameter(Mandatory=$true)][string]$OutputRoot,
    [Parameter(Mandatory=$true)][string]$VulkanHeadersRoot,
    [Parameter(Mandatory=$true)][string]$Dxc,
    [Parameter(Mandatory=$true)][string]$VcVarsAll
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Root = Split-Path -Parent $PSScriptRoot
$Output = [IO.Path]::GetFullPath($OutputRoot)
if (Test-Path -LiteralPath $Output) { throw 'OutputRoot must be new; existing evidence is retained.' }
$Headers = (Resolve-Path -LiteralPath $VulkanHeadersRoot).Path
$Compiler = (Resolve-Path -LiteralPath $Dxc).Path
$VcVars = (Resolve-Path -LiteralPath $VcVarsAll).Path
$Source = Join-Path $Root 'test/native/vulkan-present.cpp'
$Shader = Join-Path $Root 'test/native/vulkan-scene.hlsl'
foreach ($Value in @($Output,$Headers,$Compiler,$VcVars,$Root)) {
    if ($Value -match '[%"\r\n!&|<>^]') { throw 'Build paths contain unsupported command characters.' }
}
foreach ($Required in @($Source,$Shader,(Join-Path $Headers 'vulkan/vulkan.h'))) {
    if (!(Test-Path -LiteralPath $Required)) { throw "Missing fixed build input: $Required" }
}
New-Item -ItemType Directory -Path $Output | Out-Null
$Header = New-Object Text.StringBuilder
[void]$Header.AppendLine('#pragma once')
[void]$Header.AppendLine('#include <cstdint>')
foreach ($Stage in @(@{Name='Vertex';Entry='VSMain';Target='vs_6_0'},@{Name='Pixel';Entry='PSMain';Target='ps_6_0'})) {
    $Spirv = Join-Path $Output ($Stage.Name + '.spv')
    & $Compiler '-spirv' '-fspv-target-env=vulkan1.2' '-T' $Stage.Target '-E' $Stage.Entry '-Fo' $Spirv $Shader 2>&1 | Tee-Object -FilePath (Join-Path $Output ($Stage.Name + '-shader.log'))
    if ($LASTEXITCODE -ne 0) { throw "DXC SPIR-V compilation failed: $($Stage.Entry)" }
    $Bytes = [IO.File]::ReadAllBytes($Spirv)
    if ($Bytes.Length -lt 20 -or $Bytes.Length % 4 -ne 0 -or [BitConverter]::ToUInt32($Bytes,0) -ne 0x07230203) { throw 'Invalid SPIR-V output.' }
    [void]$Header.AppendLine(('static constexpr std::uint32_t kVulkanScene' + $Stage.Name + '[] = {'))
    for ($Index=0;$Index -lt $Bytes.Length;$Index+=4) {
        [void]$Header.Append(('0x{0:x8}u,' -f [BitConverter]::ToUInt32($Bytes,$Index)))
        if (($Index/4)%8 -eq 7) { [void]$Header.AppendLine() }
    }
    [void]$Header.AppendLine("`n};")
}
[IO.File]::WriteAllText((Join-Path $Output 'vulkan-scene-shaders.h'),$Header.ToString(),(New-Object Text.UTF8Encoding($false)))
$Batch = @"
@echo off
call "$VcVars" x64
if errorlevel 1 exit /b 1
cl /nologo /EHsc /O2 /MD /W4 /utf-8 /std:c++20 /I"$Headers" /I"$Output" "$Source" /Fo"$Output\vulkan-present.obj" /Fe:"$Output\vulkan-present.exe" /link user32.lib
if errorlevel 1 exit /b 1
exit /b 0
"@
$BatchPath = Join-Path $Output 'build-msvc.cmd'
[IO.File]::WriteAllText($BatchPath,$Batch,[Text.Encoding]::Default)
& $BatchPath 2>&1 | Tee-Object -FilePath (Join-Path $Output 'build-msvc.log')
if ($LASTEXITCODE -ne 0) { throw 'Vulkan scene host build failed; see build-msvc.log.' }
$Evidence = [ordered]@{source_head=(& git -C $Root rev-parse HEAD).Trim();source_working_copy=$true;shader_compiler=$Compiler;vulkan_headers=$Headers;files=@();runtime_verified=$false}
foreach ($File in @($Source,(Join-Path $Root 'test/native/vulkan-scene.h'),$Shader,$PSCommandPath,(Join-Path $Headers 'vulkan/vulkan.h'),(Join-Path $Output 'Vertex.spv'),(Join-Path $Output 'Pixel.spv'),(Join-Path $Output 'vulkan-present.exe'))) {
    $Evidence.files += [ordered]@{path=$File;sha256=(Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
}
$Evidence | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Output 'build-identity.json') -Encoding utf8
Write-Output "Built real depth/moving-geometry sample: $Output\vulkan-present.exe"
