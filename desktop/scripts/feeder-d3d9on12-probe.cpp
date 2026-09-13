// Bounded system D3D9On12 interoperability probe. It loads only Windows' own
// d3d9.dll and never loads the quarantined dgVoodoo download or a game module.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <d3d9on12.h>
#include <dxgi1_4.h>
#include <wrl/client.h>
#include <cstdint>
#include <cstdio>
#include <cmath>
#include <fstream>
#include <string>
#include <vector>
#include "feeder-beta3/nr_feeder_ipc_client.h"
#include "feeder-beta3/nr_feeder_depth_copy.h"
using Microsoft::WRL::ComPtr;
static FILE *log_file = nullptr;
static void trace(const char* what,HRESULT result=S_OK) {if(log_file){std::fprintf(log_file,"%llu %s hr=0x%08lX\n",GetTickCount64(),what,result);std::fflush(log_file);}}
static void check(HRESULT h,const char* what){trace(what,h);if(FAILED(h))ExitProcess(12);}
static void need(bool ok,const char* what){if(!ok)check(E_FAIL,what);}
static LRESULT CALLBACK wnd(HWND w,UINT m,WPARAM p,LPARAM l){if(m==WM_DESTROY){PostQuitMessage(0);return 0;}return DefWindowProcW(w,m,p,l);}
static void transition(ID3D12GraphicsCommandList* list,ID3D12Resource* resource,D3D12_RESOURCE_STATES from,D3D12_RESOURCE_STATES to){D3D12_RESOURCE_BARRIER b{};b.Type=D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;b.Transition={resource,D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES,from,to};list->ResourceBarrier(1,&b);}
struct Sample{unsigned frame,width,height;UINT color_format,depth_format,depth_flags;std::uint64_t input_hash,output_hash;bool nr_completed=false;};
struct Probe {
    UINT width=640,height=360;UINT adapter=0;HWND window{};D3DPRESENT_PARAMETERS present{};
    ComPtr<IDirect3D9> api;ComPtr<IDirect3DDevice9> game;ComPtr<IDirect3DDevice9On12> interop;
    ComPtr<ID3D12Device> device;ComPtr<ID3D12CommandQueue> queue;ComPtr<ID3D12CommandAllocator> allocator;
    ComPtr<ID3D12GraphicsCommandList> list;ComPtr<ID3D12Fence> fence;UINT64 fence_value=0;HANDLE event{};
    ComPtr<ID3D12Resource> transport,readback_before,readback_after;D3D12_PLACED_SUBRESOURCE_FOOTPRINT footprint{};UINT64 bytes=0;
    std::vector<Sample> samples;unsigned borrowed=0,returned=0;LUID luid{};
    bool host_mode=false,addon_mode=false,host_built=false,history_reset=true;unsigned nr_frames=0;
    nr_feeder_ipc::Client peer;nr_feeder_depth::Copy depth_copy;
    ComPtr<ID3D12Resource> host_output,host_depth,host_motion;HANDLE shared_handles[FEED_SLOTS]{};
    void wait(UINT64 n){const UINT64 value=fence->GetCompletedValue();need(value!=UINT64_MAX,"device removed before completion");if(value>=n)return;check(fence->SetEventOnCompletion(n,event),"set completion event");need(WaitForSingleObject(event,2000)==WAIT_OBJECT_0,"bounded completion timeout");need(fence->GetCompletedValue()!=UINT64_MAX&&fence->GetCompletedValue()>=n,"confirmed GPU completion");}
    void configure(){present={};present.BackBufferWidth=width;present.BackBufferHeight=height;present.BackBufferFormat=D3DFMT_A8R8G8B8;present.BackBufferCount=1;present.MultiSampleType=D3DMULTISAMPLE_NONE;
        present.SwapEffect=D3DSWAPEFFECT_DISCARD;present.hDeviceWindow=window;present.Windowed=TRUE;present.EnableAutoDepthStencil=TRUE;present.AutoDepthStencilFormat=D3DFMT_D24S8;present.PresentationInterval=D3DPRESENT_INTERVAL_ONE;}
    void init(HWND w){window=w;wchar_t local[MAX_PATH]{};GetModuleFileNameW(nullptr,local,MAX_PATH);wchar_t *last=wcsrchr(local,L'\\');need(last!=nullptr,"fixture path");wcscpy_s(last+1,MAX_PATH-(last+1-local),L"d3d9.dll");
        HMODULE system=LoadLibraryExW(addon_mode?local:L"d3d9.dll",nullptr,LOAD_LIBRARY_SEARCH_SYSTEM32);need(system!=nullptr,"load D3D9 entry");
        wchar_t module[MAX_PATH]{};GetModuleFileNameW(system,module,MAX_PATH);if(log_file){std::fwprintf(log_file,L"system_module=%ls\n",module);std::fflush(log_file);}
        auto create=reinterpret_cast<PFN_Direct3DCreate9On12>(GetProcAddress(system,"Direct3DCreate9On12"));need(create!=nullptr,"system 9On12 export");
        D3D9ON12_ARGS args{};args.Enable9On12=TRUE;auto normal=reinterpret_cast<decltype(&Direct3DCreate9)>(GetProcAddress(system,"Direct3DCreate9"));
        api.Attach(addon_mode?normal(D3D_SDK_VERSION):create(D3D_SDK_VERSION,&args,1));need(api!=nullptr,"create 9On12 enumerator");bool found=false;
        for(UINT n=0;n<api->GetAdapterCount();++n){D3DADAPTER_IDENTIFIER9 id{};if(SUCCEEDED(api->GetAdapterIdentifier(n,0,&id))&&id.VendorId==0x10de){adapter=n;found=true;break;}}need(found,"NVIDIA adapter");
        configure();check(api->CreateDevice(adapter,D3DDEVTYPE_HAL,w,D3DCREATE_HARDWARE_VERTEXPROCESSING|D3DCREATE_MULTITHREADED,&present,&game),"create native D3D9 device through system 9On12");
        check(game.As(&interop),"QI IDirect3DDevice9On12");check(interop->GetD3D12Device(IID_PPV_ARGS(&device)),"borrow underlying D3D12 device");luid=device->GetAdapterLuid();
        D3D12_COMMAND_QUEUE_DESC q{};q.Type=D3D12_COMMAND_LIST_TYPE_DIRECT;check(device->CreateCommandQueue(&q,IID_PPV_ARGS(&queue)),"create same-device interop queue");
        check(device->CreateCommandAllocator(q.Type,IID_PPV_ARGS(&allocator)),"allocator");check(device->CreateCommandList(0,q.Type,allocator.Get(),nullptr,IID_PPV_ARGS(&list)),"command list");check(list->Close(),"close initial list");
        check(device->CreateFence(0,D3D12_FENCE_FLAG_NONE,IID_PPV_ARGS(&fence)),"completion fence");event=CreateEventW(nullptr,FALSE,FALSE,nullptr);need(event!=nullptr,"fence event");
        if(host_mode){wchar_t file[MAX_PATH]{};GetModuleFileNameW(nullptr,file,MAX_PATH);wchar_t* slash=wcsrchr(file,L'\\');need(slash!=nullptr,"host base path");*(slash+1)=0;
            need(peer.Connect(std::wstring(file)+L"_DLSS5_Feeder15\\addons\\host64",luid),peer.reason);trace("source-pinned 0.15 host connected");}}
    void prepare(ID3D12Resource* source){auto desc=source->GetDesc();if(transport){auto t=transport->GetDesc();if(t.Width==desc.Width&&t.Height==desc.Height&&t.Format==desc.Format)return;}
        transport.Reset();readback_before.Reset();readback_after.Reset();host_output.Reset();host_depth.Reset();host_motion.Reset();depth_copy.Release();
        for(auto &handle:shared_handles){if(handle)CloseHandle(handle);handle=nullptr;}host_built=false;history_reset=true;
        device->GetCopyableFootprints(&desc,0,1,0,&footprint,nullptr,nullptr,&bytes);
        desc.Flags=D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS;D3D12_HEAP_PROPERTIES props{};props.Type=D3D12_HEAP_TYPE_DEFAULT;
        check(device->CreateCommittedResource(&props,D3D12_HEAP_FLAG_SHARED,&desc,D3D12_RESOURCE_STATE_COMMON,nullptr,IID_PPV_ARGS(&transport)),"shared transport texture");
        D3D12_RESOURCE_DESC rb{};rb.Dimension=D3D12_RESOURCE_DIMENSION_BUFFER;rb.Width=bytes;rb.Height=rb.DepthOrArraySize=rb.MipLevels=1;rb.SampleDesc.Count=1;rb.Layout=D3D12_TEXTURE_LAYOUT_ROW_MAJOR;props.Type=D3D12_HEAP_TYPE_READBACK;
        check(device->CreateCommittedResource(&props,D3D12_HEAP_FLAG_NONE,&rb,D3D12_RESOURCE_STATE_COPY_DEST,nullptr,IID_PPV_ARGS(&readback_before)),"readback before");
        check(device->CreateCommittedResource(&props,D3D12_HEAP_FLAG_NONE,&rb,D3D12_RESOURCE_STATE_COPY_DEST,nullptr,IID_PPV_ARGS(&readback_after)),"readback after");
        if(host_mode){props.Type=D3D12_HEAP_TYPE_DEFAULT;
            check(device->CreateCommittedResource(&props,D3D12_HEAP_FLAG_SHARED,&desc,D3D12_RESOURCE_STATE_COMMON,nullptr,IID_PPV_ARGS(&host_output)),"shared host output");
            desc.Format=DXGI_FORMAT_R32_FLOAT;desc.Flags=D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS|D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS;
            check(device->CreateCommittedResource(&props,D3D12_HEAP_FLAG_SHARED,&desc,D3D12_RESOURCE_STATE_COMMON,nullptr,IID_PPV_ARGS(&host_depth)),"shared raw depth");
            desc.Format=DXGI_FORMAT_R16G16_FLOAT;
            check(device->CreateCommittedResource(&props,D3D12_HEAP_FLAG_SHARED,&desc,D3D12_RESOURCE_STATE_COMMON,nullptr,IID_PPV_ARGS(&host_motion)),"shared host motion");
            ID3D12Resource* resources[]={transport.Get(),host_output.Get(),host_depth.Get(),host_motion.Get()};
            for(int n=0;n<FEED_SLOTS;++n)check(device->CreateSharedHandle(resources[n],nullptr,GENERIC_ALL,nullptr,&shared_handles[n]),"export host texture handle");
        }}
    void readback(ID3D12Resource* color,ID3D12Resource* target){D3D12_TEXTURE_COPY_LOCATION src{};src.pResource=color;src.Type=D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;D3D12_TEXTURE_COPY_LOCATION dst{};dst.pResource=target;dst.Type=D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;dst.PlacedFootprint=footprint;list->CopyTextureRegion(&dst,0,0,0,&src,nullptr);}
    std::uint64_t hash(ID3D12Resource* resource){void* data=nullptr;D3D12_RANGE range{0,static_cast<SIZE_T>(bytes)};check(resource->Map(0,&range,&data),"map finished readback");std::uint64_t h=1469598103934665603ull;for(UINT y=0;y<height;++y){auto p=static_cast<unsigned char*>(data)+y*footprint.Footprint.RowPitch;for(UINT x=0;x<width*4;++x)h=(h^p[x])*1099511628211ull;}D3D12_RANGE written{0,0};resource->Unmap(0,&written);return h;}
    void render(unsigned frame){check(game->Clear(0,nullptr,D3DCLEAR_TARGET|D3DCLEAR_ZBUFFER,D3DCOLOR_ARGB(94,26,51,102),1,0),"clear game frame");check(game->BeginScene(),"begin scene");
        game->SetVertexShader(nullptr);game->SetPixelShader(nullptr);game->SetTexture(0,nullptr);game->SetFVF(D3DFVF_XYZRHW|D3DFVF_DIFFUSE);game->SetRenderState(D3DRS_LIGHTING,FALSE);game->SetRenderState(D3DRS_CULLMODE,D3DCULL_NONE);game->SetRenderState(D3DRS_ZENABLE,TRUE);game->SetRenderState(D3DRS_ZWRITEENABLE,TRUE);game->SetRenderState(D3DRS_ALPHABLENDENABLE,FALSE);
        struct V{float x,y,z,rhw;DWORD color;};for(unsigned n=0;n<3;++n){float x=width*(0.25f+0.22f*n+0.1f*std::sin(frame*0.03f+n)),y=height*(0.3f+0.12f*n),s=height*0.18f,z=0.7f-0.2f*n;DWORD c=D3DCOLOR_ARGB(94,50+n*70,170-n*30,80+n*40);
            V vertices[]={{x-s,y-s,z,1,c},{x+s,y-s,z,1,c},{x-s,y+s,z,1,c},{x-s,y+s,z,1,c},{x+s,y-s,z,1,c},{x+s,y+s,z,1,c}};check(game->DrawPrimitiveUP(D3DPT_TRIANGLELIST,2,vertices,sizeof(V)),"draw native D3D9 geometry");}
        check(game->EndScene(),"end scene");}
    void host_frame(unsigned frame){ComPtr<IDirect3DSurface9> color9,depth9;check(game->GetBackBuffer(0,0,D3DBACKBUFFER_TYPE_MONO,&color9),"game color");check(game->GetDepthStencilSurface(&depth9),"game depth");
        ComPtr<ID3D12Resource> color,depth;check(interop->UnwrapUnderlyingResource(color9.Get(),queue.Get(),IID_PPV_ARGS(&color)),"unwrap host color");++borrowed;
        check(interop->UnwrapUnderlyingResource(depth9.Get(),queue.Get(),IID_PPV_ARGS(&depth)),"unwrap host depth");++borrowed;prepare(color.Get());
        need(depth_copy.Prepare(device.Get(),depth.Get(),host_depth.Get()),"prepare raw-depth conversion");
        if(!host_built){const bool built=peer.Build(device.Get(),width,height,color->GetDesc().Format,shared_handles);need(built,peer.reason);host_built=true;}
        check(allocator->Reset(),"reset upload allocator");check(list->Reset(allocator.Get(),nullptr),"reset upload list");
        transition(list.Get(),color.Get(),D3D12_RESOURCE_STATE_COMMON,D3D12_RESOURCE_STATE_COPY_SOURCE);const bool sampled=frame%30==0;
        if(sampled)readback(color.Get(),readback_before.Get());transition(list.Get(),transport.Get(),D3D12_RESOURCE_STATE_COMMON,D3D12_RESOURCE_STATE_COPY_DEST);list->CopyResource(transport.Get(),color.Get());
        transition(list.Get(),transport.Get(),D3D12_RESOURCE_STATE_COPY_DEST,D3D12_RESOURCE_STATE_COMMON);transition(list.Get(),color.Get(),D3D12_RESOURCE_STATE_COPY_SOURCE,D3D12_RESOURCE_STATE_COMMON);
        depth_copy.Record(list.Get(),depth.Get(),host_depth.Get());check(list->Close(),"close upload list");ID3D12CommandList* upload[]={list.Get()};queue->ExecuteCommandLists(1,upload);check(queue->Signal(fence.Get(),++fence_value),"signal upload completion");wait(fence_value);
        FeedFrameResult result{};const bool ready=peer.Submit(queue.Get(),history_reset,result);history_reset=false;
        if(ready&&result.nr_completed)++nr_frames;
        if(frame<=3||frame%30==0){trace(peer.reason);if(log_file){std::fprintf(log_file,"host_result frame=%u host_frame=%llu ready=%d nr_completed=%u\n",frame,result.frame,ready?1:0,result.nr_completed);std::fflush(log_file);}}
        check(allocator->Reset(),"reset home allocator");check(list->Reset(allocator.Get(),nullptr),"reset home list");
        if(ready){transition(list.Get(),host_output.Get(),D3D12_RESOURCE_STATE_COMMON,D3D12_RESOURCE_STATE_COPY_SOURCE);transition(list.Get(),color.Get(),D3D12_RESOURCE_STATE_COMMON,D3D12_RESOURCE_STATE_COPY_DEST);list->CopyResource(color.Get(),host_output.Get());transition(list.Get(),color.Get(),D3D12_RESOURCE_STATE_COPY_DEST,D3D12_RESOURCE_STATE_COMMON);transition(list.Get(),host_output.Get(),D3D12_RESOURCE_STATE_COPY_SOURCE,D3D12_RESOURCE_STATE_COMMON);}
        if(sampled){transition(list.Get(),color.Get(),D3D12_RESOURCE_STATE_COMMON,D3D12_RESOURCE_STATE_COPY_SOURCE);readback(color.Get(),readback_after.Get());transition(list.Get(),color.Get(),D3D12_RESOURCE_STATE_COPY_SOURCE,D3D12_RESOURCE_STATE_COMMON);}
        check(list->Close(),"close home list");ID3D12CommandList* home[]={list.Get()};queue->ExecuteCommandLists(1,home);const UINT64 n=++fence_value;check(queue->Signal(fence.Get(),n),"signal home completion");
        ID3D12Fence* sync[]={fence.Get()};UINT64 values[]={n};check(interop->ReturnUnderlyingResource(color9.Get(),1,values,sync),"return host color with fence");++returned;check(interop->ReturnUnderlyingResource(depth9.Get(),1,values,sync),"return host depth with fence");++returned;wait(n);
        if(sampled){auto c=color->GetDesc(),d=depth->GetDesc();Sample s{frame,width,height,static_cast<UINT>(c.Format),static_cast<UINT>(d.Format),static_cast<UINT>(d.Flags),hash(readback_before.Get()),hash(readback_after.Get()),ready&&result.nr_completed!=0};if(!s.nr_completed)need(s.input_hash==s.output_hash,"declined host retains same-frame bytes");samples.push_back(s);}
        check(game->Present(nullptr,nullptr,nullptr,nullptr),"present host NR frame after return");}
    void round_trip(unsigned frame){if(addon_mode){check(game->Present(nullptr,nullptr,nullptr,nullptr),"ordinary game Present through installed add-on");return;}if(host_mode){host_frame(frame);return;}ComPtr<IDirect3DSurface9> color9,depth9;check(game->GetBackBuffer(0,0,D3DBACKBUFFER_TYPE_MONO,&color9),"game color");check(game->GetDepthStencilSurface(&depth9),"game depth");
        ComPtr<ID3D12Resource> color,depth;check(interop->UnwrapUnderlyingResource(color9.Get(),queue.Get(),IID_PPV_ARGS(&color)),"unwrap color");++borrowed;
        check(interop->UnwrapUnderlyingResource(depth9.Get(),queue.Get(),IID_PPV_ARGS(&depth)),"unwrap depth");++borrowed;prepare(color.Get());
        check(allocator->Reset(),"reset allocator");check(list->Reset(allocator.Get(),nullptr),"reset list");transition(list.Get(),color.Get(),D3D12_RESOURCE_STATE_COMMON,D3D12_RESOURCE_STATE_COPY_SOURCE);
        const bool sampled=frame%30==0;if(sampled)readback(color.Get(),readback_before.Get());transition(list.Get(),transport.Get(),D3D12_RESOURCE_STATE_COMMON,D3D12_RESOURCE_STATE_COPY_DEST);list->CopyResource(transport.Get(),color.Get());
        transition(list.Get(),transport.Get(),D3D12_RESOURCE_STATE_COPY_DEST,D3D12_RESOURCE_STATE_COPY_SOURCE);transition(list.Get(),color.Get(),D3D12_RESOURCE_STATE_COPY_SOURCE,D3D12_RESOURCE_STATE_COPY_DEST);list->CopyResource(color.Get(),transport.Get());
        transition(list.Get(),transport.Get(),D3D12_RESOURCE_STATE_COPY_SOURCE,D3D12_RESOURCE_STATE_COMMON);transition(list.Get(),color.Get(),D3D12_RESOURCE_STATE_COPY_DEST,D3D12_RESOURCE_STATE_COPY_SOURCE);
        if(sampled)readback(color.Get(),readback_after.Get());transition(list.Get(),color.Get(),D3D12_RESOURCE_STATE_COPY_SOURCE,D3D12_RESOURCE_STATE_COMMON);check(list->Close(),"close round-trip list");ID3D12CommandList* lists[]={list.Get()};queue->ExecuteCommandLists(1,lists);const UINT64 n=++fence_value;check(queue->Signal(fence.Get(),n),"signal interop completion");
        ID3D12Fence* sync[]={fence.Get()};UINT64 values[]={n};check(interop->ReturnUnderlyingResource(color9.Get(),1,values,sync),"return color with actual fence");++returned;check(interop->ReturnUnderlyingResource(depth9.Get(),1,values,sync),"return depth with actual fence");++returned;
        wait(n);if(sampled){auto c=color->GetDesc(),d=depth->GetDesc();Sample s{frame,width,height,static_cast<UINT>(c.Format),static_cast<UINT>(d.Format),static_cast<UINT>(d.Flags),hash(readback_before.Get()),hash(readback_after.Get())};need(s.input_hash==s.output_hash,"same-frame identity round-trip bytes");samples.push_back(s);}check(game->Present(nullptr,nullptr,nullptr,nullptr),"present after return");}
    void reset(){wait(fence_value);transport.Reset();readback_before.Reset();readback_after.Reset();width=768;height=432;configure();check(game->Reset(&present),"native D3D9 Reset");ComPtr<IDirect3DDevice9On12> current;check(game.As(&current),"9On12 interface after Reset");trace("reset completed");}
};
int WINAPI wWinMain(HINSTANCE instance,HINSTANCE,PWSTR,int){fopen_s(&log_file,"feeder-d3d9on12-probe.log","w");unsigned frames=180;bool reset=true,host=false,addon=false;int argc=0;auto args=CommandLineToArgvW(GetCommandLineW(),&argc);for(int n=1;n<argc;++n){if(std::wstring(args[n])==L"--frames"&&n+1<argc)frames=std::wcstoul(args[++n],nullptr,10);else if(std::wstring(args[n])==L"--no-reset")reset=false;else if(std::wstring(args[n])==L"--host")host=true;else if(std::wstring(args[n])==L"--addon")addon=true;}LocalFree(args);need(frames>=60&&frames<=360,"bounded request");
    WNDCLASSW wc{};wc.lpfnWndProc=wnd;wc.hInstance=instance;wc.lpszClassName=L"XiaofengSystemD3D9On12Probe";RegisterClassW(&wc);HWND window=CreateWindowW(wc.lpszClassName,L"System D3D9On12 interop probe",WS_OVERLAPPEDWINDOW,0,0,800,600,nullptr,nullptr,instance,nullptr);need(window!=nullptr,"window");Probe probe;probe.host_mode=host;probe.addon_mode=addon;probe.init(window);
    for(unsigned frame=1;frame<=frames;++frame){MSG m{};while(PeekMessageW(&m,nullptr,0,0,PM_REMOVE)){TranslateMessage(&m);DispatchMessageW(&m);}if(reset&&frame==frames/2+1)probe.reset();probe.render(frame);probe.round_trip(frame);Sleep(16);}
    std::ofstream out("feeder-d3d9on12-probe.json");out<<"{\"schema\":1,\"architecture\":\""<<(sizeof(void*)==4?"x86":"x64")<<"\",\"frames\":"<<frames<<",\"borrowed\":"<<probe.borrowed<<",\"returned\":"<<probe.returned<<",\"reset\":"<<(reset?"true":"false")<<",\"samples\":[";
    for(std::size_t n=0;n<probe.samples.size();++n){auto&s=probe.samples[n];if(n)out<<",";out<<"{\"frame\":"<<s.frame<<",\"width\":"<<s.width<<",\"height\":"<<s.height<<",\"colorFormat\":"<<s.color_format<<",\"depthFormat\":"<<s.depth_format<<",\"depthFlags\":"<<s.depth_flags<<",\"nrCompleted\":"<<(s.nr_completed?"true":"false")<<",\"inputHash\":\""<<std::hex<<s.input_hash<<"\",\"outputHash\":\""<<s.output_hash<<"\"}"<<std::dec;}
    out<<"],\"gpuRoundTripVerified\":"<<(addon?"false":"true")<<",\"nrVerified\":"<<(probe.nr_frames>0?"true":"false")<<",\"nrFrames\":"<<probe.nr_frames<<",\"hostVerified\":"<<(host&&probe.nr_frames>0?"true":"false")<<",\"realGameVerified\":false,\"exit\":\"clean\"}\n";probe.peer.Close();trace("probe completed");return 0;}
