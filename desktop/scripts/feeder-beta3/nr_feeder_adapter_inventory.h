#pragma once
#include <windows.h>
#include <dxgi1_2.h>
#include <cstdio>
// Invoked before host logging, configuration, ReShade or device creation.
inline int NrListAdaptersJson() {
    HMODULE system=LoadLibraryExW(L"dxgi.dll",nullptr,LOAD_LIBRARY_SEARCH_SYSTEM32);
    auto create=system?reinterpret_cast<decltype(&CreateDXGIFactory1)>(GetProcAddress(system,"CreateDXGIFactory1")):nullptr;
    IDXGIFactory1 *factory=nullptr;
    if(!create||FAILED(create(IID_PPV_ARGS(&factory)))){printf("{\"schema\":1,\"adapters\":[],\"error\":\"dxgi-unavailable\"}\n");return 2;}
    printf("{\"schema\":1,\"adapters\":[");bool comma=false;
    for(UINT index=0;index<32;++index){
        IDXGIAdapter1 *adapter=nullptr;if(factory->EnumAdapters1(index,&adapter)==DXGI_ERROR_NOT_FOUND)break;
        DXGI_ADAPTER_DESC1 desc{};if(!adapter)continue;HRESULT result=adapter->GetDesc1(&desc);adapter->Release();if(FAILED(result))continue;
        char name[512]{};WideCharToMultiByte(CP_UTF8,0,desc.Description,-1,name,sizeof(name),nullptr,nullptr);
        printf("%s{\"index\":%u,\"vendorId\":%u,\"deviceId\":%u,\"software\":%s,\"luid\":\"%08lX:%08lX\",\"description\":\"",comma?",":"",index,desc.VendorId,desc.DeviceId,(desc.Flags&DXGI_ADAPTER_FLAG_SOFTWARE)?"true":"false",desc.AdapterLuid.HighPart,desc.AdapterLuid.LowPart);
        for(const unsigned char *p=reinterpret_cast<const unsigned char*>(name);*p;++p){if(*p=='"'||*p=='\\')putchar('\\');if(*p<32)printf("\\u%04x",*p);else putchar(*p);}
        printf("\"}");comma=true;
    }
    printf("]}\n");factory->Release();FreeLibrary(system);return 0;
}
