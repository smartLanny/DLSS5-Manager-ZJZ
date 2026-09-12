// Managed DX9 entry point. Creation goes through the pinned ReShade add-on build;
// Windows owns D3D9On12 and the normal D3D9 COM interfaces.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>
#include <d3d9on12.h>
#include <array>
#include <string>
#include <vector>
#include <type_traits>

namespace {
#ifdef _WIN64
constexpr wchar_t kLoader[] = L"ReShade64.dll";
constexpr char kSha256[] = "0cee63f9c9f13f3ac909c5b4903f4dbb4b719a7ab3b4f13b0deaf83c814b94f7";
constexpr LONGLONG kBytes = 5592064;
#else
constexpr wchar_t kLoader[] = L"ReShade32.dll";
constexpr char kSha256[] = "da430e0a9c6eecefa0d1b27d05e16c426fb5d04e808b194d914eaac4b31bc0f8";
constexpr LONGLONG kBytes = 4398080;
#endif
INIT_ONCE loader_once = INIT_ONCE_STATIC_INIT;
INIT_ONCE system_once = INIT_ONCE_STATIC_INIT;
HMODULE loader = nullptr, system_d3d9 = nullptr;
HANDLE loader_file = INVALID_HANDLE_VALUE, loader_directory = INVALID_HANDLE_VALUE;
DWORD loader_error = ERROR_MOD_NOT_FOUND;
PFN_Direct3DCreate9On12 create9 = nullptr;
PFN_Direct3DCreate9On12Ex create9ex = nullptr;
BOOL CALLBACK initialize_system(PINIT_ONCE, PVOID, PVOID*);

std::wstring module_path(HMODULE module) {
    std::vector<wchar_t> value(32768);
    const DWORD n = GetModuleFileNameW(module, value.data(), static_cast<DWORD>(value.size()));
    if (n == 0 || n >= value.size()) return {};
    return {value.data(), n};
}
bool same_file(HANDLE expected, const std::wstring& path) {
    HANDLE actual = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (actual == INVALID_HANDLE_VALUE) return false;
    BY_HANDLE_FILE_INFORMATION a{}, b{};
    const bool ok = GetFileInformationByHandle(expected, &a) && GetFileInformationByHandle(actual, &b)
        && a.dwVolumeSerialNumber == b.dwVolumeSerialNumber && a.nFileIndexHigh == b.nFileIndexHigh
        && a.nFileIndexLow == b.nFileIndexLow;
    CloseHandle(actual);
    return ok;
}
bool verify_hash(HANDLE file) {
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(file, &size) || size.QuadPart != kBytes) return false;
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    bool ok = BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0;
    if (ok) ok = BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0) >= 0;
    std::array<UCHAR, 65536> buffer{};
    LONGLONG total = 0;
    while (ok) {
        DWORD n = 0;
        if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &n, nullptr)) { ok = false; break; }
        if (!n) break;
        total += n;
        ok = BCryptHashData(hash, buffer.data(), n, 0) >= 0;
    }
    std::array<UCHAR, 32> digest{};
    if (ok) ok = total == kBytes && BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) >= 0;
    if (hash) BCryptDestroyHash(hash);
    if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
    constexpr char digits[] = "0123456789abcdef";
    for (size_t n = 0; ok && n < digest.size(); ++n)
        ok = kSha256[n * 2] == digits[digest[n] >> 4] && kSha256[n * 2 + 1] == digits[digest[n] & 15];
    return ok;
}
void release_failed_load() {
    create9 = nullptr;
    create9ex = nullptr;
    // Do not unload a module whose DllMain may already have installed hooks.
    if (loader_file != INVALID_HANDLE_VALUE) { CloseHandle(loader_file); loader_file = INVALID_HANDLE_VALUE; }
    if (loader_directory != INVALID_HANDLE_VALUE) { CloseHandle(loader_directory); loader_directory = INVALID_HANDLE_VALUE; }
}
BOOL CALLBACK initialize_loader(PINIT_ONCE, PVOID, PVOID*) {
    try {
        const std::wstring executable = module_path(nullptr);
        const auto slash = executable.find_last_of(L"\\/");
        if (slash == std::wstring::npos) return TRUE;
        const std::wstring directory = executable.substr(0, slash) + L"\\_DLSS5_Feeder15";
        const DWORD attributes = GetFileAttributesW(directory.c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_DIRECTORY)
            || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) { loader_error = ERROR_PATH_NOT_FOUND; return TRUE; }
        loader_directory = CreateFileW(directory.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
            nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
        if (loader_directory == INVALID_HANDLE_VALUE) { loader_error = GetLastError(); return TRUE; }
        const std::wstring path = directory + L"\\" + kLoader;
        loader_file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
        if (loader_file == INVALID_HANDLE_VALUE) { loader_error = GetLastError(); release_failed_load(); return TRUE; }
        BY_HANDLE_FILE_INFORMATION info{};
        if (!GetFileInformationByHandle(loader_file, &info) || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
            || !verify_hash(loader_file)) { loader_error = ERROR_INVALID_IMAGE_HASH; release_failed_load(); return TRUE; }
        // ReShade resolves its On12 trampoline from the registered system
        // module. A game may call Create9 before any D3DPERF export; load that
        // system target explicitly instead of depending on call order.
        InitOnceExecuteOnce(&system_once, initialize_system, nullptr, nullptr);
        if (!system_d3d9) { loader_error = ERROR_MOD_NOT_FOUND; release_failed_load(); return TRUE; }
        // Absolute location and system-only dependency search. The read and directory
        // handles stay open for process lifetime to prevent replacement after hashing.
        loader = LoadLibraryExW(path.c_str(), nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
        if (!loader) { loader_error = GetLastError(); release_failed_load(); return TRUE; }
        if (!same_file(loader_file, module_path(loader))) { loader_error = ERROR_INVALID_IMAGE_HASH; release_failed_load(); return TRUE; }
        create9 = reinterpret_cast<PFN_Direct3DCreate9On12>(GetProcAddress(loader, "Direct3DCreate9On12"));
        create9ex = reinterpret_cast<PFN_Direct3DCreate9On12Ex>(GetProcAddress(loader, "Direct3DCreate9On12Ex"));
        if (!create9 || !create9ex) { loader_error = ERROR_PROC_NOT_FOUND; release_failed_load(); return TRUE; }
        loader_error = ERROR_SUCCESS;
    } catch (...) { loader_error = ERROR_NOT_ENOUGH_MEMORY; release_failed_load(); }
    return TRUE;
}
bool ensure_loader() {
    if (!InitOnceExecuteOnce(&loader_once, initialize_loader, nullptr, nullptr) || loader_error != ERROR_SUCCESS) {
        SetLastError(loader_error);
        OutputDebugStringW(L"Xiaofeng D3D9On12 shim: pinned ReShade loader unavailable.\n");
        return false;
    }
    return true;
}
BOOL CALLBACK initialize_system(PINIT_ONCE, PVOID, PVOID*) {
    wchar_t directory[MAX_PATH]{};
    const UINT count = GetSystemDirectoryW(directory, MAX_PATH);
    if (count && count < MAX_PATH) {
        try { system_d3d9 = LoadLibraryExW((std::wstring(directory) + L"\\d3d9.dll").c_str(), nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32); }
        catch (...) {}
    }
    return TRUE;
}
[[noreturn]] void missing_system_export() {
    RaiseFailFastException(nullptr, nullptr, 0);
    TerminateProcess(GetCurrentProcess(), ERROR_PROC_NOT_FOUND);
    __assume(0);
}
} // namespace

extern "C" IDirect3D9* WINAPI ShimDirect3DCreate9(UINT sdk) {
    if (!ensure_loader()) return nullptr;
    D3D9ON12_ARGS args{};
    args.Enable9On12 = TRUE;
    return create9(sdk, &args, 1);
}
extern "C" HRESULT WINAPI ShimDirect3DCreate9Ex(UINT sdk, IDirect3D9Ex** output) {
    if (!output) return D3DERR_INVALIDCALL;
    *output = nullptr;
    if (!ensure_loader()) return HRESULT_FROM_WIN32(loader_error);
    D3D9ON12_ARGS args{};
    args.Enable9On12 = TRUE;
    return create9ex(sdk, &args, 1, output);
}
extern "C" IDirect3D9* WINAPI ShimDirect3DCreate9On12(UINT sdk, D3D9ON12_ARGS* overrides, UINT count) {
    return ensure_loader() ? create9(sdk, overrides, count) : nullptr;
}
extern "C" HRESULT WINAPI ShimDirect3DCreate9On12Ex(UINT sdk, D3D9ON12_ARGS* overrides, UINT count, IDirect3D9Ex** output) {
    if (!output) return D3DERR_INVALIDCALL;
    *output = nullptr;
    return ensure_loader() ? create9ex(sdk, overrides, count, output) : HRESULT_FROM_WIN32(loader_error);
}
static_assert(std::is_same_v<decltype(&ShimDirect3DCreate9On12), PFN_Direct3DCreate9On12>);
static_assert(std::is_same_v<decltype(&ShimDirect3DCreate9On12Ex), PFN_Direct3DCreate9On12Ex>);
static_assert(std::is_same_v<decltype(&ShimDirect3DCreate9), decltype(&Direct3DCreate9)>);
static_assert(std::is_same_v<decltype(&ShimDirect3DCreate9Ex), decltype(&Direct3DCreate9Ex)>);

extern "C" {
FARPROC g_system_exports[19]{};
void WINAPI ResolveD3D9Export(unsigned index) {
    static const char* names[] = {"D3DPERF_BeginEvent", "D3DPERF_EndEvent", "D3DPERF_GetStatus", "D3DPERF_QueryRepeatFrame",
        "D3DPERF_SetMarker", "D3DPERF_SetOptions", "D3DPERF_SetRegion", "DebugSetLevel", "DebugSetMute",
        "Direct3D9EnableMaximizedWindowedModeShim", "Direct3DShaderValidatorCreate9", "PSGPError", "PSGPSampleTexture"};
    static const WORD ordinals[] = {16, 17, 18, 19, 22, 23};
    if (index >= 19) missing_system_export();
    InitOnceExecuteOnce(&system_once, initialize_system, nullptr, nullptr);
    FARPROC target = system_d3d9 ? GetProcAddress(system_d3d9,
        index < 13 ? names[index] : MAKEINTRESOURCEA(ordinals[index - 13])) : nullptr;
    if (!target) missing_system_export();
    InterlockedExchangePointer(reinterpret_cast<PVOID volatile*>(&g_system_exports[index]), reinterpret_cast<PVOID>(target));
}
}
