// No device is created by this test. It exercises real Windows DLL loading,
// SDK import names/calling conventions and the pinned-loader rejection path.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d9on12.h>
#include <cstdio>
#include <string>
static void need(bool pass, const char* what) {
    if (!pass) { std::printf("FAIL %s win32=%lu\n", what, GetLastError()); std::fflush(stdout); ExitProcess(12); }
}
int main(int argc, char** argv) {
    need(argc == 2, "one test mode");
    const bool create_first = std::string(argv[1]) == "valid-create-first";
    const bool accepted = create_first || std::string(argv[1]) == "valid-enumerator";
    wchar_t executable[32768]{}, actual[32768]{};
    need(GetModuleFileNameW(nullptr, executable, 32768) != 0, "fixture location");
    const std::wstring exe(executable), parent = exe.substr(0, exe.find_last_of(L"\\/"));
    HMODULE shim = GetModuleHandleW(L"d3d9.dll");
    need(shim && GetModuleFileNameW(shim, actual, 32768), "normal SDK imports loaded shim");
    need(_wcsicmp(actual, (parent + L"\\d3d9.dll").c_str()) == 0, "actual EXE d3d9 path");
    const char* names[] = {"D3DPERF_BeginEvent","D3DPERF_EndEvent","D3DPERF_GetStatus","D3DPERF_QueryRepeatFrame",
        "D3DPERF_SetMarker","D3DPERF_SetOptions","D3DPERF_SetRegion","DebugSetLevel","DebugSetMute",
        "Direct3D9EnableMaximizedWindowedModeShim","Direct3DCreate9","Direct3DCreate9Ex","Direct3DCreate9On12",
        "Direct3DCreate9On12Ex","Direct3DShaderValidatorCreate9","PSGPError","PSGPSampleTexture"};
    const WORD ordinals[] = {27,28,29,30,31,32,33,34,35,36,37,38,20,21,24,25,26};
    for (unsigned n = 0; n < 17; ++n)
        need(GetProcAddress(shim, names[n]) == GetProcAddress(shim, MAKEINTRESOURCEA(ordinals[n])), "named and ordinal export identity");
    for (WORD ordinal = 16; ordinal <= 38; ++ordinal)
        need(GetProcAddress(shim, MAKEINTRESOURCEA(ordinal)) != nullptr, "complete system ordinal range");
    const auto ancillary = [] { for (int n = 0; n < 2000; ++n) {
        D3DPERF_SetOptions(0);
        D3DPERF_BeginEvent(0x12345678, L"ABI \x4e2d\x6587 marker");
        D3DPERF_SetMarker(0x87654321, L"marker");
        D3DPERF_SetRegion(0xfedcba98, L"region");
        D3DPERF_QueryRepeatFrame();
        D3DPERF_GetStatus();
        D3DPERF_EndEvent();
    } };
    if (!create_first) ancillary();
    need(Direct3DCreate9Ex(D3D_SDK_VERSION, nullptr) == D3DERR_INVALIDCALL, "null Ex output rejects without dereference");
    const UINT sdk = D3D_SDK_VERSION;
    IDirect3D9* d3d = Direct3DCreate9(sdk);
    need((d3d != nullptr) == accepted, "Create9 follows pinned loader availability");
    if (d3d) d3d->Release();
    IDirect3D9Ex* d3dex = reinterpret_cast<IDirect3D9Ex*>(1);
    HRESULT result = Direct3DCreate9Ex(sdk, &d3dex);
    need(accepted ? SUCCEEDED(result) && d3dex != nullptr : FAILED(result) && d3dex == nullptr, "Ex return value and output");
    if (d3dex) d3dex->Release();
    auto on12 = reinterpret_cast<PFN_Direct3DCreate9On12>(GetProcAddress(shim,"Direct3DCreate9On12"));
    auto on12ex = reinterpret_cast<PFN_Direct3DCreate9On12Ex>(GetProcAddress(shim,"Direct3DCreate9On12Ex"));
    D3D9ON12_ARGS args{}; args.Enable9On12 = TRUE;
    d3d = on12(sdk, &args, 1);
    need((d3d != nullptr) == accepted, "On12 calling convention");
    if (d3d) d3d->Release();
    d3dex = reinterpret_cast<IDirect3D9Ex*>(1);
    result = on12ex(sdk, &args, 1, &d3dex);
    need(accepted ? SUCCEEDED(result) && d3dex != nullptr : FAILED(result) && d3dex == nullptr, "On12Ex calling convention and output");
    if (d3dex) d3dex->Release();
#ifdef _WIN64
    constexpr wchar_t loader_name[] = L"ReShade64.dll";
#else
    constexpr wchar_t loader_name[] = L"ReShade32.dll";
#endif
    HMODULE loader = GetModuleHandleW(loader_name);
    need((loader != nullptr) == accepted, "only valid pinned loader executes");
    if (accepted) {
        need(GetModuleFileNameW(loader, actual, 32768), "actual loader location");
        const std::wstring expected = parent + L"\\_DLSS5_Feeder15\\" + loader_name;
        need(_wcsicmp(actual, expected.c_str()) == 0, "fixed loader subdirectory");
        HANDLE writer = CreateFileW(expected.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
        need(writer == INVALID_HANDLE_VALUE && GetLastError() == ERROR_SHARING_VIOLATION, "verified loader stays locked against replacement");
    }
    ancillary(); // Repeat after ReShade installs its own system-entry hooks.
    std::printf("PASS architecture=%s mode=%s sdkImports=true exports=23 namedExports=17 ancillaryCalls=%u gpuDeviceCreated=false\n", sizeof(void*) == 4 ? "x86" : "x64", argv[1], create_first ? 14000 : 28000);
    return 0;
}
