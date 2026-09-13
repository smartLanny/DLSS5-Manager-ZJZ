#include <windows.h>
#include <atomic>
#include <reshade.hpp>
static std::atomic<unsigned> devices{0},presents{0};
static void on_device(reshade::api::device* d){if(d->get_api()==reshade::api::device_api::vulkan)devices++;}
static void on_present(reshade::api::command_queue*,reshade::api::swapchain*,const reshade::api::rect*,const reshade::api::rect*,uint32_t,const reshade::api::rect*){presents++;}
extern "C" __declspec(dllexport) const char* NAME="Manager Vulkan loading probe";
extern "C" __declspec(dllexport) const char* DESCRIPTION="Measures actual Vulkan add-on loading and presentation; no NR or NGX simulation.";
extern "C" __declspec(dllexport) unsigned __cdecl ReadVulkanProbe(unsigned kind){return kind==0?devices.load():presents.load();}
BOOL APIENTRY DllMain(HMODULE module,DWORD reason,LPVOID){if(reason==DLL_PROCESS_ATTACH){if(!reshade::register_addon(module))return FALSE;reshade::register_event<reshade::addon_event::init_device>(on_device);reshade::register_event<reshade::addon_event::present>(on_present);}else if(reason==DLL_PROCESS_DETACH){reshade::unregister_addon(module);}return TRUE;}
