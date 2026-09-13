// A single-use ReShade loader for a manager-owned profile. Ordinary by
// default; explicit same-user administrator targets are gated by the HoYo
// launch coordinator and independently verified here without elevation.
// No game termination, file cleanup, ACL changes, driver or protection bypass.
#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <TlHelp32.h>
#include <bcrypt.h>
#include <string>
#include <vector>
#include <map>
#include <iostream>
#include <algorithm>
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "advapi32.lib")

struct Handle {
  HANDLE value = nullptr;
  explicit Handle(HANDLE v = nullptr) : value(v) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  explicit operator bool() const { return value && value != INVALID_HANDLE_VALUE; }
};
std::string utf8(const std::wstring& value) {
  const int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.c_str(), (int)value.size(), nullptr, 0, nullptr, nullptr);
  if (count <= 0) return {};
  std::string result(count, '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.c_str(), (int)value.size(), result.data(), count, nullptr, nullptr);
  return result;
}
std::string json(const std::wstring& value) {
  std::string output = "\"";
  for (unsigned char ch : utf8(value)) {
    if (ch == '\\' || ch == '"') output += '\\';
    if (ch < 32) output += '?'; else output += (char)ch;
  }
  return output + "\"";
}
bool same(const std::wstring& a, const std::wstring& b) { return _wcsicmp(a.c_str(), b.c_str()) == 0; }
std::wstring image(HANDLE process) {
  std::wstring value(32768, L'\0'); DWORD size = (DWORD)value.size();
  if (!QueryFullProcessImageNameW(process, 0, value.data(), &size)) return {};
  value.resize(size); return value;
}
bool localPath(const std::wstring& value) {
  if (value.size() < 4 || value.size() >= 32000 || !iswalpha(value[0]) || value[1] != L':' || (value[2] != L'\\' && value[2] != L'/')) return false;
  std::wstring full(32768, L'\0'); DWORD size = GetFullPathNameW(value.c_str(), (DWORD)full.size(), full.data(), nullptr);
  if (!size || size >= full.size()) return false; full.resize(size);
  if (!same(value, full)) return false;
  // Reject reparse points on every path component, including the leaf.
  for (size_t at = 3; at <= value.size(); ++at) if (at == value.size() || value[at] == L'\\' || value[at] == L'/') {
    const DWORD attr = GetFileAttributesW(value.substr(0, at).c_str());
    if (attr == INVALID_FILE_ATTRIBUTES || (attr & FILE_ATTRIBUTE_REPARSE_POINT)) return false;
  }
  return true;
}
bool hex(const std::wstring& text) { return text.size() == 64 && text.find_first_not_of(L"0123456789abcdef") == std::wstring::npos; }
bool uuid(const std::wstring& text) {
  if (text.size() != 36) return false;
  for (size_t i = 0; i < text.size(); ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (text[i] != L'-') return false; }
    else if (!iswxdigit(text[i])) return false;
  }
  return true;
}
std::string sha256(const std::wstring& path) {
  Handle file(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
  BY_HANDLE_FILE_INFORMATION info{};
  if (!file || !GetFileInformationByHandle(file.value, &info) || info.nNumberOfLinks != 1 || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) return {};
  BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE state = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return {};
  DWORD size = 0, returned = 0;
  BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, (PUCHAR)&size, sizeof(size), &returned, 0);
  std::vector<UCHAR> memory(size), buffer(64 * 1024); UCHAR digest[32]{};
  bool ok = BCryptCreateHash(algorithm, &state, memory.data(), size, nullptr, 0, 0) >= 0;
  DWORD read = 0;
  while (ok) { if (!ReadFile(file.value, buffer.data(), (DWORD)buffer.size(), &read, nullptr)) { ok = false; break; }
    if (!read) break; ok = BCryptHashData(state, buffer.data(), read, 0) >= 0; }
  if (ok) ok = BCryptFinishHash(state, digest, sizeof(digest), 0) >= 0;
  if (state) BCryptDestroyHash(state); BCryptCloseAlgorithmProvider(algorithm, 0);
  if (!ok) return {}; const char* chars = "0123456789abcdef"; std::string result;
  for (UCHAR byte : digest) { result += chars[byte >> 4]; result += chars[byte & 15]; } return result;
}
std::vector<BYTE> tokenInfo(HANDLE process, TOKEN_INFORMATION_CLASS kind) {
  HANDLE raw = nullptr; if (!OpenProcessToken(process, TOKEN_QUERY, &raw)) return {}; Handle token(raw);
  DWORD size = 0; GetTokenInformation(token.value, kind, nullptr, 0, &size); std::vector<BYTE> data(size);
  if (!size || !GetTokenInformation(token.value, kind, data.data(), size, &size)) return {}; return data;
}
bool ordinary(HANDLE process) {
  auto data = tokenInfo(process, TokenIntegrityLevel); if (data.empty()) return false;
  auto* label = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(data.data()); PSID sid = label->Label.Sid;
  const DWORD level = *GetSidSubAuthority(sid, (DWORD)(*GetSidSubAuthorityCount(sid) - 1));
  return level < SECURITY_MANDATORY_HIGH_RID;
}
bool elevatedAdmin(HANDLE process) {
  auto elevation = tokenInfo(process, TokenElevation), integrity = tokenInfo(process, TokenIntegrityLevel), user = tokenInfo(process, TokenUser);
  if (elevation.size() != sizeof(TOKEN_ELEVATION) || integrity.size() < sizeof(TOKEN_MANDATORY_LABEL) || user.size() < sizeof(TOKEN_USER) ||
      !reinterpret_cast<TOKEN_ELEVATION*>(elevation.data())->TokenIsElevated) return false;
  const PSID integritySid = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(integrity.data())->Label.Sid;
  const PSID userSid = reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid;
  if (!IsValidSid(integritySid) || !IsValidSid(userSid) || !*GetSidSubAuthorityCount(integritySid) || IsWellKnownSid(userSid, WinLocalSystemSid)) return false;
  // HIGH is intentional: SYSTEM and protected-process integrity are never
  // accepted, even if both processes happen to share an account or session.
  return *GetSidSubAuthority(integritySid, (DWORD)(*GetSidSubAuthorityCount(integritySid) - 1)) == SECURITY_MANDATORY_HIGH_RID;
}
bool sameUser(HANDLE process, bool elevatedTarget) {
  auto current = tokenInfo(GetCurrentProcess(), TokenUser), target = tokenInfo(process, TokenUser);
  auto cs = tokenInfo(GetCurrentProcess(), TokenSessionId), ts = tokenInfo(process, TokenSessionId);
  return !current.empty() && !target.empty() && cs.size() == sizeof(DWORD) && ts.size() == sizeof(DWORD) &&
    EqualSid(reinterpret_cast<TOKEN_USER*>(current.data())->User.Sid, reinterpret_cast<TOKEN_USER*>(target.data())->User.Sid) &&
    *reinterpret_cast<DWORD*>(cs.data()) == *reinterpret_cast<DWORD*>(ts.data()) &&
    (elevatedTarget ? elevatedAdmin(GetCurrentProcess()) && elevatedAdmin(process) : ordinary(GetCurrentProcess()) && ordinary(process));
}
unsigned long long creation(HANDLE process) { FILETIME started{}, ended{}, kernel{}, user{}; if (!GetProcessTimes(process, &started, &ended, &kernel, &user)) return 0;
  return (static_cast<unsigned long long>(started.dwHighDateTime) << 32) | started.dwLowDateTime; }
std::vector<DWORD> targets(const std::wstring& target) {
  std::vector<DWORD> result; Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  const std::wstring name = target.substr(target.find_last_of(L"\\/") + 1); PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
  if (!snapshot) return result;
  for (BOOL more = Process32FirstW(snapshot.value, &entry); more; more = Process32NextW(snapshot.value, &entry)) {
    if (!same(entry.szExeFile, name)) continue;
    Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, entry.th32ProcessID));
    if (process && same(image(process.value), target)) result.push_back(entry.th32ProcessID);
  }
  return result;
}
uintptr_t moduleBase(DWORD pid, const std::wstring& name) {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid)); MODULEENTRY32W module{}; module.dwSize = sizeof(module);
  if (!snapshot) return 0;
  for (BOOL more = Module32FirstW(snapshot.value, &module); more; more = Module32NextW(snapshot.value, &module))
    if (same(module.szModule, name)) return reinterpret_cast<uintptr_t>(module.modBaseAddr);
  return 0;
}
bool loaded(DWORD pid, const std::wstring& file) {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid)); MODULEENTRY32W module{}; module.dwSize = sizeof(module);
  if (!snapshot) return false;
  for (BOOL more = Module32FirstW(snapshot.value, &module); more; more = Module32NextW(snapshot.value, &module)) if (same(module.szExePath, file)) return true;
  return false;
}
// Only read the target's image headers/export table. No foreign DLL is loaded
// into this process for inspection, and a system dxgi.dll name is not evidence
// of ReShade. All reads and enumeration have explicit size/count bounds.
enum class LoaderPresence { Clear, Present, Unavailable };
bool readImage(HANDLE process, const MODULEENTRY32W& module, DWORD rva, void* output, SIZE_T bytes) {
  if (rva > module.modBaseSize || bytes > module.modBaseSize - rva) return false;
  SIZE_T read = 0;
  return ReadProcessMemory(process, module.modBaseAddr + rva, output, bytes, &read) && read == bytes;
}
LoaderPresence reshadeExports(HANDLE process, const MODULEENTRY32W& module) {
  IMAGE_DOS_HEADER dos{};
  if (!readImage(process, module, 0, &dos, sizeof(dos)) || dos.e_magic != IMAGE_DOS_SIGNATURE || dos.e_lfanew < 0 || dos.e_lfanew > 1024 * 1024)
    return LoaderPresence::Unavailable;
  IMAGE_NT_HEADERS64 nt{};
  if (!readImage(process, module, (DWORD)dos.e_lfanew, &nt, sizeof(nt)) || nt.Signature != IMAGE_NT_SIGNATURE || nt.OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC)
    return LoaderPresence::Unavailable;
  if (nt.OptionalHeader.NumberOfRvaAndSizes <= IMAGE_DIRECTORY_ENTRY_EXPORT) return LoaderPresence::Clear;
  const auto directory = nt.OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXPORT];
  if (!directory.VirtualAddress || !directory.Size) return LoaderPresence::Clear;
  IMAGE_EXPORT_DIRECTORY exports{};
  if (!readImage(process, module, directory.VirtualAddress, &exports, sizeof(exports)) || exports.NumberOfNames > 16384 || exports.NumberOfFunctions > 65536)
    return LoaderPresence::Unavailable;
  std::vector<DWORD> names(exports.NumberOfNames), functions(exports.NumberOfFunctions);
  std::vector<WORD> ordinals(exports.NumberOfNames);
  if ((!names.empty() && (!readImage(process, module, exports.AddressOfNames, names.data(), names.size() * sizeof(DWORD)) ||
      !readImage(process, module, exports.AddressOfNameOrdinals, ordinals.data(), ordinals.size() * sizeof(WORD)))) ||
      (!functions.empty() && !readImage(process, module, exports.AddressOfFunctions, functions.data(), functions.size() * sizeof(DWORD))))
    return LoaderPresence::Unavailable;
  const char* required[] = { "ReShadeRegisterAddon", "ReShadeUnregisterAddon", "ReShadeRegisterEvent", "ReShadeUnregisterEvent" };
  unsigned mask = 0;
  for (size_t i = 0; i < names.size(); ++i) {
    char name[64]{};
    if (names[i] >= module.modBaseSize) return LoaderPresence::Unavailable;
    const SIZE_T bytes = (std::min)(sizeof(name), (size_t)module.modBaseSize - names[i]);
    if (!readImage(process, module, names[i], name, bytes)) return LoaderPresence::Unavailable;
    if (!memchr(name, 0, bytes)) continue;
    for (unsigned index = 0; index < 4; ++index) if (strcmp(name, required[index]) == 0) {
      if (ordinals[i] >= functions.size()) return LoaderPresence::Unavailable;
      const DWORD rva = functions[ordinals[i]];
      // A forwarded name is not an implementation identity.
      if (!rva || rva >= module.modBaseSize || (rva >= directory.VirtualAddress && rva - directory.VirtualAddress < directory.Size))
        return LoaderPresence::Unavailable;
      mask |= 1u << index;
    }
  }
  return mask == 15 ? LoaderPresence::Present : LoaderPresence::Clear;
}
LoaderPresence otherLoader(HANDLE process, DWORD pid, const std::wstring& loader, const std::string& loaderHash) {
  WIN32_FILE_ATTRIBUTE_DATA wanted{};
  if (!GetFileAttributesExW(loader.c_str(), GetFileExInfoStandard, &wanted)) return LoaderPresence::Unavailable;
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid)); MODULEENTRY32W module{}; module.dwSize = sizeof(module);
  if (!snapshot) return LoaderPresence::Unavailable;
  size_t count = 0;
  for (BOOL more = Module32FirstW(snapshot.value, &module); more; more = Module32NextW(snapshot.value, &module)) {
    if (++count > 1024) return LoaderPresence::Unavailable;
    if (same(module.szExePath, loader)) return LoaderPresence::Present;
    WIN32_FILE_ATTRIBUTE_DATA observed{};
    if (!GetFileAttributesExW(module.szExePath, GetFileExInfoStandard, &observed)) return LoaderPresence::Unavailable;
    if (observed.nFileSizeHigh == wanted.nFileSizeHigh && observed.nFileSizeLow == wanted.nFileSizeLow) {
      const auto actual = sha256(module.szExePath);
      if (actual.empty()) return LoaderPresence::Unavailable;
      if (actual == loaderHash) return LoaderPresence::Present;
    }
    const auto identity = reshadeExports(process, module);
    if (identity != LoaderPresence::Clear) return identity;
  }
  return GetLastError() == ERROR_NO_MORE_FILES ? LoaderPresence::Clear : LoaderPresence::Unavailable;
}
std::wstring targetMutex(const std::wstring& target) {
  // Two independent managers must not both pass a pre-load check for the same
  // exact executable. The mutex spans Ready -> attach/timeout and has no file
  // or game lifetime effects. Collisions only refuse an additional helper.
  unsigned long long a = 1469598103934665603ULL, b = 1099511628211ULL;
  for (wchar_t ch : target) { const auto value = (unsigned long long)towlower(ch == L'/' ? L'\\' : ch); a = (a ^ value) * 1099511628211ULL; b = (b ^ value) * 1469598103934665603ULL; }
  return L"Local\\DLSS5.Loading.Helper." + std::to_wstring(a) + L"." + std::to_wstring(b);
}
uintptr_t remoteFunction(HANDLE process, DWORD pid, const char* function) {
  const auto address = reinterpret_cast<uintptr_t>(GetProcAddress(GetModuleHandleW(L"kernel32.dll"), function));
  HMODULE containing = nullptr;
  if (!address || !GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
      reinterpret_cast<LPCWSTR>(address), &containing)) return 0;
  wchar_t localFile[MAX_PATH]{}; if (!GetModuleFileNameW(containing, localFile, MAX_PATH)) return 0;
  const uintptr_t offset = address - reinterpret_cast<uintptr_t>(containing);
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid)); MODULEENTRY32W module{}; module.dwSize = sizeof(module);
  if (!snapshot) return 0;
  for (BOOL more = Module32FirstW(snapshot.value, &module); more; more = Module32NextW(snapshot.value, &module)) {
    if (!same(module.szExePath, localFile) || offset >= module.modBaseSize || module.modBaseSize - offset < 16) continue;
    const auto remote = reinterpret_cast<uintptr_t>(module.modBaseAddr) + offset;
    unsigned char observed[16]{}; SIZE_T read = 0; MEMORY_BASIC_INFORMATION region{};
    if (!VirtualQueryEx(process, reinterpret_cast<LPCVOID>(remote), &region, sizeof(region)) || region.State != MEM_COMMIT ||
        (region.Protect & (PAGE_GUARD | PAGE_NOACCESS)) || !(region.Protect & (PAGE_EXECUTE | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY)) ||
        !ReadProcessMemory(process, reinterpret_cast<LPCVOID>(remote), observed, sizeof(observed), &read) || read != sizeof(observed) ||
        memcmp(observed, reinterpret_cast<const void*>(address), sizeof(observed)) != 0) return 0;
    return remote;
  }
  return 0;
}
bool initialized(HANDLE process, DWORD pid, DWORD& error) {
  // Process discovery may precede the mapping of its static DLL imports.
  // Windows serializes remote-thread startup with process/DLL initialization:
  // https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-createremotethread
  // Call an existing system function, with no custom remote code or argument
  // allocation. Its PID result is a bounded initialization acknowledgement,
  // not a claim about DLLs the application chooses to load later in main.
  const ULONGLONG deadline = GetTickCount64() + 3000; uintptr_t query = 0;
  do {
    query = remoteFunction(process, pid, "GetCurrentProcessId");
    if (query) break;
    DWORD exit = 0;
    if (!GetExitCodeProcess(process, &exit) || exit != STILL_ACTIVE) { error = ERROR_PROCESS_ABORTED; return false; }
    Sleep(10); // Poll only while the required system module is absent.
  } while (GetTickCount64() < deadline);
  if (!query) { error = ERROR_MOD_NOT_FOUND; return false; }
  Handle thread(CreateRemoteThread(process, nullptr, 0, reinterpret_cast<LPTHREAD_START_ROUTINE>(query), nullptr, 0, nullptr));
  if (!thread) { error = GetLastError(); return false; }
  const DWORD wait = WaitForSingleObject(thread.value, 5000); DWORD observed = 0;
  if (wait != WAIT_OBJECT_0 || !GetExitCodeThread(thread.value, &observed) || observed != pid) {
    error = wait == WAIT_TIMEOUT ? WAIT_TIMEOUT : ERROR_PROCESS_ABORTED; return false;
  }
  return true;
}
bool load(DWORD pid, const std::wstring& target, const std::wstring& loader, const std::wstring& config,
    const std::wstring& targetHash, const std::wstring& loaderHash, const std::wstring& configHash,
    unsigned long long earliest, bool elevatedTarget, DWORD& error) {
  Handle process(OpenProcess(PROCESS_CREATE_THREAD | PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_QUERY_INFORMATION, FALSE, pid));
  if (!process) { error = GetLastError(); return false; }
  BOOL wow = TRUE;
  if (!same(image(process.value), target) || creation(process.value) < earliest || !sameUser(process.value, elevatedTarget) || !IsWow64Process(process.value, &wow) || wow) { error = ERROR_ACCESS_DENIED; return false; }
  if (!initialized(process.value, pid, error)) return false;
  if (!sameUser(process.value, elevatedTarget)) { error = ERROR_ACCESS_DENIED; return false; }
  if (!localPath(target) || !localPath(loader) || !localPath(config) || sha256(target) != utf8(targetHash) ||
      sha256(loader) != utf8(loaderHash) || sha256(config) != utf8(configHash)) { error = ERROR_FILE_INVALID; return false; }
  const auto presence = otherLoader(process.value, pid, loader, utf8(loaderHash));
  if (presence != LoaderPresence::Clear) { error = presence == LoaderPresence::Present ? ERROR_ALREADY_EXISTS : ERROR_PARTIAL_COPY; return false; }
  const auto address = remoteFunction(process.value, pid, "LoadLibraryW");
  if (!address) { error = ERROR_PROC_NOT_FOUND; return false; }
  const size_t bytes = (loader.size() + 1) * sizeof(wchar_t);
  void* memory = VirtualAllocEx(process.value, nullptr, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
  if (!memory) { error = GetLastError(); return false; }
  SIZE_T written = 0;
  if (!WriteProcessMemory(process.value, memory, loader.c_str(), bytes, &written) || written != bytes) { error = GetLastError(); VirtualFreeEx(process.value, memory, 0, MEM_RELEASE); return false; }
  Handle thread(CreateRemoteThread(process.value, nullptr, 0, reinterpret_cast<LPTHREAD_START_ROUTINE>(address), memory, 0, nullptr));
  if (!thread) { error = GetLastError(); VirtualFreeEx(process.value, memory, 0, MEM_RELEASE); return false; }
  const DWORD wait = WaitForSingleObject(thread.value, 10000);
  // An in-flight LoadLibrary may still read its argument. On timeout the game
  // owns the allocation until exit; never free it early or terminate the game.
  if (wait != WAIT_OBJECT_0) { error = wait == WAIT_TIMEOUT ? WAIT_TIMEOUT : GetLastError(); return false; }
  VirtualFreeEx(process.value, memory, 0, MEM_RELEASE);
  if (!loaded(pid, loader)) { error = ERROR_DLL_INIT_FAILED; return false; }
  error = ERROR_SUCCESS; return true;
}
int wmain(int argc, wchar_t** argv) {
  std::map<std::wstring, std::wstring> args;
  for (int index = 1; index + 1 < argc; index += 2) { if (!args.emplace(argv[index], argv[index + 1]).second) return 2; }
  const auto elevated = args.find(L"--elevated-target"); const bool elevatedTarget = elevated != args.end();
  if (argc != (elevatedTarget ? 19 : 17) || args.size() != (elevatedTarget ? 9 : 8) || elevatedTarget && elevated->second != L"1") return 2;
  const wchar_t* required[] = { L"--session", L"--target", L"--target-sha", L"--loader", L"--loader-sha", L"--config", L"--config-sha", L"--timeout" };
  for (const auto name : required) if (args.find(name) == args.end()) return 2;
  const auto session = args[L"--session"], target = args[L"--target"], targetHash = args[L"--target-sha"], loader = args[L"--loader"], loaderHash = args[L"--loader-sha"], config = args[L"--config"], configHash = args[L"--config-sha"], timeoutText = args[L"--timeout"];
  auto event = [&](const char* type, DWORD pid = 0, DWORD error = 0) {
    std::cout << "{\"version\":1,\"event\":\"" << type << "\",\"sessionId\":" << json(session) << ",\"targetExe\":" << json(target)
      << ",\"configHash\":" << json(configHash) << ",\"helperPid\":" << GetCurrentProcessId() << ",\"gamePid\":" << pid << ",\"error\":" << error
      << ",\"elevatedTarget\":" << (elevatedTarget ? "true" : "false") << "}" << std::endl;
  };
  wchar_t* timeoutEnd = nullptr; unsigned long timeout = wcstoul(timeoutText.c_str(), &timeoutEnd, 10);
  if (!uuid(session) || !hex(targetHash) || !hex(loaderHash) || !hex(configHash) || timeoutText.empty() || !timeoutEnd || *timeoutEnd ||
      timeoutText.find_first_not_of(L"0123456789") != std::wstring::npos || timeout < 1000 || timeout > 300000 ||
      !localPath(target) || !localPath(loader) || !localPath(config) ||
      !(elevatedTarget ? elevatedAdmin(GetCurrentProcess()) : ordinary(GetCurrentProcess()))) { event("failed", 0, ERROR_INVALID_PARAMETER); return 2; }
  if (sha256(target) != utf8(targetHash) || sha256(loader) != utf8(loaderHash) || sha256(config) != utf8(configHash)) { event("failed", 0, ERROR_FILE_INVALID); return 3; }
  Handle lease(CreateMutexW(nullptr, FALSE, targetMutex(target).c_str()));
  if (!lease || WaitForSingleObject(lease.value, 0) != WAIT_OBJECT_0) { event("failed", 0, ERROR_BUSY); return 4; }
  if (!targets(target).empty()) { event("failed", 0, ERROR_ALREADY_EXISTS); return 4; }
  FILETIME stamp{}; GetSystemTimeAsFileTime(&stamp); const unsigned long long earliest = ((static_cast<unsigned long long>(stamp.dwHighDateTime) << 32) | stamp.dwLowDateTime) - 10000000ULL;
  const ULONGLONG deadline = GetTickCount64() + timeout; event("ready");
  while (GetTickCount64() < deadline) {
    const auto found = targets(target);
    if (found.size() > 1) { event("failed", 0, ERROR_DUP_NAME); return 5; }
    if (found.size() == 1) {
      const DWORD pid = found.front();
      if (!localPath(target) || !localPath(loader) || !localPath(config) || sha256(target) != utf8(targetHash) || sha256(loader) != utf8(loaderHash) || sha256(config) != utf8(configHash)) { event("failed", pid, ERROR_FILE_INVALID); return 3; }
      DWORD error = 0; const bool ok = load(pid, target, loader, config, targetHash, loaderHash, configHash, earliest, elevatedTarget, error);
      event(ok ? "attached" : "failed", pid, error); return ok ? 0 : 6;
    }
    Sleep(50);
  }
  event("failed", 0, WAIT_TIMEOUT); return 7;
}
