#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
extern "C" __declspec(dllexport) unsigned FixtureOrdinaryGraphicsDependency() { return 4812; }
BOOL WINAPI DllMain(HINSTANCE, DWORD, LPVOID) { return TRUE; }
