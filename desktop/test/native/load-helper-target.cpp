#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <cstdlib>
#if defined(FIXTURE_IMPORT_ORDINARY)
extern "C" __declspec(dllimport) unsigned FixtureOrdinaryGraphicsDependency();
#elif defined(FIXTURE_IMPORT_RESHADE)
extern "C" __declspec(dllimport) bool ReShadeRegisterAddon();
#endif
int wmain(int argc, wchar_t** argv) {
#if defined(FIXTURE_IMPORT_ORDINARY)
  if (FixtureOrdinaryGraphicsDependency() != 4812) return 3;
#elif defined(FIXTURE_IMPORT_RESHADE)
  if (!ReShadeRegisterAddon()) return 3;
#endif
  DWORD lifetime = 4500;
  if (argc >= 2) { const auto value = wcstoul(argv[1], nullptr, 10); if (value >= 1000 && value <= 20000) lifetime = value; }
  if (argc == 3 && !LoadLibraryW(argv[2])) return 2;
  Sleep(lifetime); return 0;
}
