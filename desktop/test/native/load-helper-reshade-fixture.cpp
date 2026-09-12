#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
extern "C" __declspec(dllexport) bool ReShadeRegisterAddon() { return true; }
extern "C" __declspec(dllexport) void ReShadeUnregisterAddon() {}
extern "C" __declspec(dllexport) void ReShadeRegisterEvent() {}
extern "C" __declspec(dllexport) void ReShadeUnregisterEvent() {}
BOOL WINAPI DllMain(HINSTANCE, DWORD, LPVOID) { return TRUE; }
