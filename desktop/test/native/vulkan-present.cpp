// Real x64 Vulkan presentation/depth probe. No NGX/Core or ReShade-guide substitute.
// Usage: vulkan-present.exe <report.txt> [frames, default 600].
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define VK_NO_PROTOTYPES
#define VK_USE_PLATFORM_WIN32_KHR
#include <windows.h>
#include <vulkan/vulkan.h>
#include <cstdio>
#include <vector>
#include <stdexcept>
#include <string>
#include <fstream>
static void need(bool ok,const char* what){if(!ok)throw std::runtime_error(what);}
static void vkcheck(VkResult r,const char* what){if(r!=VK_SUCCESS&&r!=VK_SUBOPTIMAL_KHR){char b[160];sprintf_s(b,"%s: VkResult=%d",what,r);throw std::runtime_error(b);}}
#include "vulkan-scene.h"
static LRESULT CALLBACK proc(HWND h,UINT m,WPARAM w,LPARAM l){return DefWindowProcW(h,m,w,l);}
int wmain(int argc,wchar_t** argv){
 const std::wstring report=argc>1?argv[1]:L"vulkan-probe-result.txt"; FILE* out=nullptr;_wfopen_s(&out,report.c_str(),L"wb");if(!out)return 3;
 try{
  unsigned requestedFrames=600;
  if(argc>2){wchar_t* end=nullptr;unsigned long value=wcstoul(argv[2],&end,10);need(end&&end!=argv[2]&&*end==0&&value>=1&&value<=36000,"frames must be 1..36000");requestedFrames=static_cast<unsigned>(value);}
  fprintf(out,"requested_frames=%u\nscene=depth-tested moving checker quads\ndepth_format=D32_SFLOAT\ndepth_direction=forward\ndepth_clear=1.0\ndepth_compare=LESS\n",requestedFrames);fflush(out);
  WCHAR system[MAX_PATH];GetSystemDirectoryW(system,MAX_PATH);std::wstring loaderPath=std::wstring(system)+L"\\vulkan-1.dll";
  HMODULE loader=LoadLibraryW(loaderPath.c_str());need(loader!=nullptr,"system Vulkan loader");
  auto gipa=(PFN_vkGetInstanceProcAddr)GetProcAddress(loader,"vkGetInstanceProcAddr");need(gipa!=nullptr,"vkGetInstanceProcAddr");
  auto createInstance=(PFN_vkCreateInstance)gipa(nullptr,"vkCreateInstance");
  const char* iext[]={VK_KHR_SURFACE_EXTENSION_NAME,VK_KHR_WIN32_SURFACE_EXTENSION_NAME};
  VkApplicationInfo ai{VK_STRUCTURE_TYPE_APPLICATION_INFO};ai.pApplicationName="Xiaofeng real Vulkan presentation probe";ai.apiVersion=VK_API_VERSION_1_2;
  VkInstanceCreateInfo ici{VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO};ici.pApplicationInfo=&ai;ici.enabledExtensionCount=2;ici.ppEnabledExtensionNames=iext;
  VkInstance instance{};vkcheck(createInstance(&ici,nullptr,&instance),"CreateInstance");
#define I(name) auto name=(PFN_vk##name)gipa(instance,"vk" #name);need(name!=nullptr,#name)
  I(EnumeratePhysicalDevices);I(GetPhysicalDeviceProperties);I(GetPhysicalDeviceQueueFamilyProperties);I(GetPhysicalDeviceSurfaceSupportKHR);I(GetPhysicalDeviceSurfaceCapabilitiesKHR);I(GetPhysicalDeviceSurfaceFormatsKHR);I(CreateWin32SurfaceKHR);I(CreateDevice);I(GetDeviceProcAddr);I(DestroySurfaceKHR);I(DestroyInstance);
  uint32_t n=0;vkcheck(EnumeratePhysicalDevices(instance,&n,nullptr),"Enumerate GPUs");need(n>0&&n<32,"GPU count");std::vector<VkPhysicalDevice> devices(n);vkcheck(EnumeratePhysicalDevices(instance,&n,devices.data()),"Enumerate GPUs");
  VkPhysicalDevice phys{};VkPhysicalDeviceProperties props{};for(auto d:devices){GetPhysicalDeviceProperties(d,&props);if(props.vendorID==0x10de){phys=d;break;}}need(phys!=VK_NULL_HANDLE,"NVIDIA GPU");fprintf(out,"gpu=%s\n",props.deviceName);
  WNDCLASSW wc{};wc.lpfnWndProc=proc;wc.hInstance=GetModuleHandleW(nullptr);wc.lpszClassName=L"XiaofengVulkanProbe";RegisterClassW(&wc);
  HWND window=CreateWindowW(wc.lpszClassName,L"Vulkan compatibility verification",WS_OVERLAPPEDWINDOW,20,20,656,399,nullptr,nullptr,wc.hInstance,nullptr);need(window!=nullptr,"CreateWindow");ShowWindow(window,SW_SHOWNOACTIVATE);
  VkWin32SurfaceCreateInfoKHR sci{VK_STRUCTURE_TYPE_WIN32_SURFACE_CREATE_INFO_KHR};sci.hinstance=wc.hInstance;sci.hwnd=window;VkSurfaceKHR surface{};vkcheck(CreateWin32SurfaceKHR(instance,&sci,nullptr,&surface),"CreateSurface");
  GetPhysicalDeviceQueueFamilyProperties(phys,&n,nullptr);need(n>0&&n<128,"queue family count");std::vector<VkQueueFamilyProperties> fam(n);GetPhysicalDeviceQueueFamilyProperties(phys,&n,fam.data());uint32_t family=UINT32_MAX;
  for(uint32_t i=0;i<n;i++){VkBool32 present=VK_FALSE;vkcheck(GetPhysicalDeviceSurfaceSupportKHR(phys,i,surface,&present),"SurfaceSupport");if(present&&(fam[i].queueFlags&VK_QUEUE_GRAPHICS_BIT)){family=i;break;}}need(family!=UINT32_MAX,"graphics/present queue");
  float priority=1;VkDeviceQueueCreateInfo qi{VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO};qi.queueFamilyIndex=family;qi.queueCount=1;qi.pQueuePriorities=&priority;
  const char* ext=VK_KHR_SWAPCHAIN_EXTENSION_NAME;VkDeviceCreateInfo ci{VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO};ci.queueCreateInfoCount=1;ci.pQueueCreateInfos=&qi;ci.enabledExtensionCount=1;ci.ppEnabledExtensionNames=&ext;
  VkDevice device{};vkcheck(CreateDevice(phys,&ci,nullptr,&device),"CreateDevice");
#define D(name) auto name=(PFN_vk##name)GetDeviceProcAddr(device,"vk" #name);need(name!=nullptr,#name)
  D(GetDeviceQueue);D(CreateSwapchainKHR);D(GetSwapchainImagesKHR);D(CreateCommandPool);D(AllocateCommandBuffers);D(CreateSemaphore);D(CreateFence);D(WaitForFences);D(ResetFences);D(AcquireNextImageKHR);D(ResetCommandBuffer);D(BeginCommandBuffer);D(CmdPipelineBarrier);D(CmdClearColorImage);D(EndCommandBuffer);D(QueueSubmit);D(QueuePresentKHR);D(DeviceWaitIdle);D(DestroyFence);D(DestroySemaphore);D(DestroyCommandPool);D(DestroySwapchainKHR);D(DestroyDevice);
  VkQueue queue{};GetDeviceQueue(device,family,0,&queue);
  VkSurfaceCapabilitiesKHR cap{};vkcheck(GetPhysicalDeviceSurfaceCapabilitiesKHR(phys,surface,&cap),"SurfaceCapabilities");vkcheck(GetPhysicalDeviceSurfaceFormatsKHR(phys,surface,&n,nullptr),"SurfaceFormats");need(n>0&&n<256,"format count");std::vector<VkSurfaceFormatKHR> formats(n);vkcheck(GetPhysicalDeviceSurfaceFormatsKHR(phys,surface,&n,formats.data()),"SurfaceFormats");
  auto format=formats[0];for(auto f:formats)if(f.format==VK_FORMAT_B8G8R8A8_UNORM&&f.colorSpace==VK_COLOR_SPACE_SRGB_NONLINEAR_KHR){format=f;break;}
  need((cap.supportedUsageFlags&VK_IMAGE_USAGE_TRANSFER_DST_BIT)!=0,"transfer-destination swapchain");
  VkSwapchainCreateInfoKHR sc{VK_STRUCTURE_TYPE_SWAPCHAIN_CREATE_INFO_KHR};sc.surface=surface;sc.minImageCount=cap.minImageCount+1;if(cap.maxImageCount&&sc.minImageCount>cap.maxImageCount)sc.minImageCount=cap.maxImageCount;sc.imageFormat=format.format;sc.imageColorSpace=format.colorSpace;sc.imageExtent=cap.currentExtent.width==UINT32_MAX?VkExtent2D{640,360}:cap.currentExtent;sc.imageArrayLayers=1;sc.imageUsage=VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT|VK_IMAGE_USAGE_TRANSFER_DST_BIT|(cap.supportedUsageFlags&VK_IMAGE_USAGE_TRANSFER_SRC_BIT);sc.imageSharingMode=VK_SHARING_MODE_EXCLUSIVE;sc.preTransform=cap.currentTransform;sc.compositeAlpha=VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR;sc.presentMode=VK_PRESENT_MODE_FIFO_KHR;sc.clipped=VK_TRUE;
  VkSwapchainKHR swap{};vkcheck(CreateSwapchainKHR(device,&sc,nullptr,&swap),"CreateSwapchain");vkcheck(GetSwapchainImagesKHR(device,swap,&n,nullptr),"SwapchainImages");std::vector<VkImage> images(n);vkcheck(GetSwapchainImagesKHR(device,swap,&n,images.data()),"SwapchainImages");
  VulkanScene scene;scene.initialize(instance,phys,device,gipa,GetDeviceProcAddr,images,sc.imageExtent,format.format);
  VkCommandPoolCreateInfo pi{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};pi.queueFamilyIndex=family;pi.flags=VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;VkCommandPool pool{};vkcheck(CreateCommandPool(device,&pi,nullptr,&pool),"CommandPool");
  VkCommandBufferAllocateInfo bi{VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};bi.commandPool=pool;bi.level=VK_COMMAND_BUFFER_LEVEL_PRIMARY;bi.commandBufferCount=1;VkCommandBuffer cb{};vkcheck(AllocateCommandBuffers(device,&bi,&cb),"CommandBuffer");
  VkSemaphoreCreateInfo si{VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO};VkSemaphore acquired{},ready{};vkcheck(CreateSemaphore(device,&si,nullptr,&acquired),"AcquireSemaphore");vkcheck(CreateSemaphore(device,&si,nullptr,&ready),"PresentSemaphore");VkFenceCreateInfo fi{VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};fi.flags=VK_FENCE_CREATE_SIGNALED_BIT;VkFence fence{};vkcheck(CreateFence(device,&fi,nullptr,&fence),"Fence");
  unsigned frames=0;for(;frames<requestedFrames;frames++){
   MSG msg;while(PeekMessageW(&msg,nullptr,0,0,PM_REMOVE)){TranslateMessage(&msg);DispatchMessageW(&msg);}
   vkcheck(WaitForFences(device,1,&fence,VK_TRUE,5000000000ull),"FrameWait");uint32_t index=0;vkcheck(AcquireNextImageKHR(device,swap,5000000000ull,acquired,VK_NULL_HANDLE,&index),"AcquireNextImage");vkcheck(ResetFences(device,1,&fence),"ResetFence");vkcheck(ResetCommandBuffer(cb,0),"ResetCommandBuffer");VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};begin.flags=VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;vkcheck(BeginCommandBuffer(cb,&begin),"BeginCommands");
   const bool inspectDepth=frames==0||frames==requestedFrames/2;
   scene.record(cb,index,frames,inspectDepth);vkcheck(EndCommandBuffer(cb),"EndCommands");
   VkPipelineStageFlags stage=VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;VkSubmitInfo submit{VK_STRUCTURE_TYPE_SUBMIT_INFO};submit.waitSemaphoreCount=1;submit.pWaitSemaphores=&acquired;submit.pWaitDstStageMask=&stage;submit.commandBufferCount=1;submit.pCommandBuffers=&cb;submit.signalSemaphoreCount=1;submit.pSignalSemaphores=&ready;vkcheck(QueueSubmit(queue,1,&submit,fence),"QueueSubmit");VkPresentInfoKHR present{VK_STRUCTURE_TYPE_PRESENT_INFO_KHR};present.waitSemaphoreCount=1;present.pWaitSemaphores=&ready;present.swapchainCount=1;present.pSwapchains=&swap;present.pImageIndices=&index;vkcheck(QueuePresentKHR(queue,&present),"Present");
   // Keep the bounded probe simple: retire each presentation before reusing its binary semaphore.
   vkcheck(DeviceWaitIdle(device),"PresentationRetire");if(inspectDepth)scene.inspectDepth(out,frames);Sleep(12);
  }
  auto probe=GetModuleHandleW(L"manager-vulkan-probe.addon64");using Read=unsigned(__cdecl*)(unsigned);auto read=probe?(Read)GetProcAddress(probe,"ReadVulkanProbe"):nullptr;
  fprintf(out,"frames=%u\naddon_loaded=%d\naddon_vulkan_devices=%u\naddon_presents=%u\n",frames,probe!=nullptr,read?read(0):0,read?read(1):0);fflush(out);
  const bool moved=scene.readbacks>1&&scene.firstDepthHash!=scene.lastDepthHash;
  fprintf(out,"draw_calls=%u\ndepth_readbacks=%u\ndepth_motion_verified=%d\n",frames*3,scene.readbacks,moved);fflush(out);
  need(requestedFrames==1||moved,"moving geometry must change actual depth readback");
  vkcheck(DeviceWaitIdle(device),"DeviceWaitIdle");scene.destroy();DestroyFence(device,fence,nullptr);DestroySemaphore(device,ready,nullptr);DestroySemaphore(device,acquired,nullptr);DestroyCommandPool(device,pool,nullptr);DestroySwapchainKHR(device,swap,nullptr);DestroyDevice(device,nullptr);DestroySurfaceKHR(instance,surface,nullptr);DestroyInstance(instance,nullptr);DestroyWindow(window);fprintf(out,"exit=clean\n");fclose(out);return 0;
 }catch(const std::exception& e){fprintf(out,"error=%s\n",e.what());fclose(out);return 1;}
}
