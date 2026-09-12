// Source-owned D3D9On12 relay. Only the Core in the x64 host evaluates NR.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d9on12.h>
#include <wrl/client.h>
#include <imgui.h>
#include <reshade.hpp>
#include <cstdio>
#include <cstdarg>
#include <mutex>
#include <vector>
#include <algorithm>
#include "nr_feeder_control.h"
#include "nr_feeder_query.h"
#include "nr_feeder_ipc_client.h"
#include "nr_feeder_depth_copy.h"
using Microsoft::WRL::ComPtr;
namespace {
HMODULE module{};
std::wstring directory;
NrFeederControl control;
NrFeederDx9Status counters{sizeof(NrFeederDx9Status)};
const char *overlay_title="装机宅 DLSS 5 · DX9 回填";
void Log(const char *format,...) {
    FILE *file=nullptr;_wfopen_s(&file,(directory+L"\\dlss5-feed.log").c_str(),L"a");if(!file)return;
    std::fprintf(file,"%llu ",GetTickCount64());va_list args;va_start(args,format);std::vfprintf(file,format,args);va_end(args);std::fputc('\n',file);std::fclose(file);
}
void Barrier(ID3D12GraphicsCommandList *list,ID3D12Resource *resource,D3D12_RESOURCE_STATES from,D3D12_RESOURCE_STATES to) {
    nr_feeder_depth::Copy::Transition(list,resource,from,to);
}
struct Session {
    reshade::api::swapchain *owner{};ComPtr<IDirect3DDevice9> game;ComPtr<IDirect3DDevice9On12> interop;
    ComPtr<ID3D12Device> device;ComPtr<ID3D12CommandQueue> queue;ComPtr<ID3D12CommandAllocator> allocator;
    ComPtr<ID3D12GraphicsCommandList> list;ComPtr<ID3D12Fence> fence;HANDLE event{};UINT64 value=0;
    ComPtr<ID3D12Resource> shared[FEED_SLOTS];HANDLE handles[FEED_SLOTS]{};
    nr_feeder_ipc::Client host;nr_feeder_depth::Copy depth_copy;UINT width=0,height=0;DXGI_FORMAT format=DXGI_FORMAT_UNKNOWN;
    struct DepthCandidate { ComPtr<IDirect3DSurface9> surface; UINT64 vertices=0,draws=0; };
    std::vector<DepthCandidate> depth_candidates;int active_depth=-1;UINT target_width=0,target_height=0;
    bool failed=false,retained=false,shared_ready=false,history_reset=true;UINT64 frames=0,epoch=0,attempts=0,control_generation=0;
    void DiscardDepth(){depth_candidates.clear();active_depth=-1;}
    void BindDepth(bool bound){active_depth=-1;if(!bound||failed||!control.enabled)return;
        ComPtr<IDirect3DSurface9> surface;if(FAILED(game->GetDepthStencilSurface(&surface)))return;D3DSURFACE_DESC desc{};
        if(FAILED(surface->GetDesc(&desc))||desc.Width!=target_width||desc.Height!=target_height||
            !(desc.Usage&D3DUSAGE_DEPTHSTENCIL)||desc.MultiSampleType!=D3DMULTISAMPLE_NONE)return;
        for(size_t n=0;n<depth_candidates.size();++n)if(depth_candidates[n].surface.Get()==surface.Get()){active_depth=static_cast<int>(n);return;}
        if(depth_candidates.size()>=16)return;depth_candidates.push_back({surface,0,0});active_depth=static_cast<int>(depth_candidates.size()-1);
    }
    void Draw(UINT count,UINT instances){if(active_depth<0||static_cast<size_t>(active_depth)>=depth_candidates.size())return;
        auto &candidate=depth_candidates[active_depth];++candidate.draws;candidate.vertices+=static_cast<UINT64>(count)*std::max(instances,1u);}
    ComPtr<IDirect3DSurface9> TakeDepth(UINT64 &draws,UINT64 &vertices){ComPtr<IDirect3DSurface9> selected;
        for(auto &candidate:depth_candidates)if(candidate.vertices>vertices||(candidate.vertices==vertices&&candidate.draws>draws)){selected=candidate.surface;draws=candidate.draws;vertices=candidate.vertices;}
        DiscardDepth();return selected;
    }
    bool Complete(){const UINT64 done=fence->GetCompletedValue();if(done!=UINT64_MAX&&done>=value)return true;
        if(done==UINT64_MAX||FAILED(fence->SetEventOnCompletion(value,event))||WaitForSingleObject(event,2000)!=WAIT_OBJECT_0||fence->GetCompletedValue()==UINT64_MAX||fence->GetCompletedValue()<value){failed=retained=true;Log("[nr-feeder-dx9] GPU completion unconfirmed; resource set retained");return false;}return true;}
    bool Begin(){return SUCCEEDED(allocator->Reset())&&SUCCEEDED(list->Reset(allocator.Get(),nullptr));}
    bool End(){if(FAILED(list->Close()))return false;ID3D12CommandList *lists[]={list.Get()};queue->ExecuteCommandLists(1,lists);
        if(FAILED(queue->Signal(fence.Get(),++value))){failed=retained=true;return false;}return Complete();}
    bool Init(reshade::api::swapchain *swapchain){owner=swapchain;game=reinterpret_cast<IDirect3DDevice9*>(swapchain->get_device()->get_native());
        if(!game||FAILED(game.As(&interop))||FAILED(interop->GetD3D12Device(IID_PPV_ARGS(&device))))return false;
        ComPtr<IDirect3DSurface9> backbuffer;D3DSURFACE_DESC desc{};
        if(FAILED(game->GetBackBuffer(0,0,D3DBACKBUFFER_TYPE_MONO,&backbuffer))||FAILED(backbuffer->GetDesc(&desc)))return false;
        target_width=desc.Width;target_height=desc.Height;
        D3D12_COMMAND_QUEUE_DESC q{};q.Type=D3D12_COMMAND_LIST_TYPE_DIRECT;
        if(FAILED(device->CreateCommandQueue(&q,IID_PPV_ARGS(&queue)))||FAILED(device->CreateCommandAllocator(q.Type,IID_PPV_ARGS(&allocator)))||
            FAILED(device->CreateCommandList(0,q.Type,allocator.Get(),nullptr,IID_PPV_ARGS(&list)))||FAILED(list->Close())||
            FAILED(device->CreateFence(0,D3D12_FENCE_FLAG_NONE,IID_PPV_ARGS(&fence))))return false;
        event=CreateEventW(nullptr,FALSE,FALSE,nullptr);if(!event)return false;
        const LUID luid=device->GetAdapterLuid();if(!host.Connect(directory+L"\\host64",luid)){Log("[nr-feeder-dx9] host unavailable: %s",host.reason);return false;}
        Log("[nr-feeder-session] pid=%lu source=0151-external-v1",GetCurrentProcessId());
        Log("[nr-feeder-dx9-session] pid=%lu host_pid=%lu api=dx9 architecture=%s luid=%08lX:%08lX",GetCurrentProcessId(),host.host_pid,sizeof(void*)==4?"x86":"x64",luid.HighPart,luid.LowPart);return true;
    }
    bool Prepare(ID3D12Resource *color,ID3D12Resource *depth){auto desc=color->GetDesc();auto dd=depth->GetDesc();
        if(desc.SampleDesc.Count!=1||desc.SampleDesc.Quality!=0||desc.Dimension!=D3D12_RESOURCE_DIMENSION_TEXTURE2D||desc.DepthOrArraySize!=1||desc.MipLevels!=1||
            !nr_feeder_depth::Copy::Supported(dd)||dd.Width!=desc.Width||dd.Height!=desc.Height||
            (desc.Format!=DXGI_FORMAT_B8G8R8A8_UNORM&&desc.Format!=DXGI_FORMAT_R8G8B8A8_UNORM)){
            if(shared_ready||attempts<=3||attempts%30==0)Log("[nr-feeder-dx9-depth-rejected] format=%u samples=%u quality=%u width=%llu height=%u",dd.Format,dd.SampleDesc.Count,dd.SampleDesc.Quality,dd.Width,dd.Height);
            shared_ready=false;history_reset=true;return false;}
        // The source may change format without changing the swapchain size.
        if(shared_ready&&width==desc.Width&&height==desc.Height&&format==desc.Format&&depth_copy.Matches(dd,shared[FEED_DEPTH].Get()))return true;
        shared_ready=false;history_reset=true;
        if(!Complete())return false;for(auto &texture:shared)texture.Reset();for(auto &handle:handles){if(handle)CloseHandle(handle);handle=nullptr;}depth_copy.Release();
        width=static_cast<UINT>(desc.Width);height=desc.Height;format=desc.Format;
        D3D12_HEAP_PROPERTIES heap{};heap.Type=D3D12_HEAP_TYPE_DEFAULT;
        for(int n=0;n<FEED_SLOTS;++n){auto own=desc;own.Flags=D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS;
            if(n==FEED_DEPTH||n==FEED_MV){own.Format=n==FEED_DEPTH?DXGI_FORMAT_R32_FLOAT:DXGI_FORMAT_R16G16_FLOAT;own.Flags|=D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS;}
            if(FAILED(device->CreateCommittedResource(&heap,D3D12_HEAP_FLAG_SHARED,&own,D3D12_RESOURCE_STATE_COMMON,nullptr,IID_PPV_ARGS(&shared[n])))||
                FAILED(device->CreateSharedHandle(shared[n].Get(),nullptr,GENERIC_ALL,nullptr,&handles[n])))return false;
        }
        if(!depth_copy.Prepare(device.Get(),depth,shared[FEED_DEPTH].Get()))return false;
        if(!host.Build(device.Get(),width,height,format,handles)){failed=true;Log("[nr-feeder-client-retained] shared set rejected: %s",host.reason);return false;}
        shared_ready=true;
        ++epoch;Log("[nr-feeder-dx9] resources epoch=%llu width=%u height=%u depth_format=%u depth_samples=%u depth_quality=%u",epoch,width,height,dd.Format,dd.SampleDesc.Count,dd.SampleDesc.Quality);return true;
    }
    void Present(){++attempts;UINT64 depth_draws=0,depth_vertices=0;auto scene_depth=TakeDepth(depth_draws,depth_vertices);if(failed)return;
        if(control_generation!=control.generation){control_generation=control.generation;shared_ready=false;history_reset=true;}
        ComPtr<IDirect3DSurface9> color9,depth9;
        if(FAILED(game->GetBackBuffer(0,0,D3DBACKBUFFER_TYPE_MONO,&color9)))return;
        D3DSURFACE_DESC color_desc{};if(FAILED(color9->GetDesc(&color_desc)))return;target_width=color_desc.Width;target_height=color_desc.Height;
        const HRESULT current_depth=game->GetDepthStencilSurface(&depth9);
        if(scene_depth){depth9=scene_depth;++counters.scene_depth_frames;}
        if(!depth9){if(attempts<=3||attempts%300==0)Log("[nr-feeder-client-retained] present=%llu no current-frame depth; bound_hr=0x%08lX",attempts,current_depth);return;}
        D3DSURFACE_DESC depth_desc{};
        if(FAILED(depth9->GetDesc(&depth_desc))||depth_desc.Width!=target_width||depth_desc.Height!=target_height||depth_desc.MultiSampleType!=D3DMULTISAMPLE_NONE||depth_desc.MultiSampleQuality!=0){
            if(shared_ready||attempts<=3||attempts%30==0)Log("[nr-feeder-dx9-depth-rejected] dx9_format=%u samples=%u quality=%lu width=%u height=%u",depth_desc.Format,depth_desc.MultiSampleType,depth_desc.MultiSampleQuality,depth_desc.Width,depth_desc.Height);
            shared_ready=false;history_reset=true;return;}
        if(attempts<=3||attempts%300==0)Log("[nr-feeder-dx9-depth] present=%llu source=%s bound_hr=0x%08lX draws=%llu vertices=%llu width=%u height=%u",attempts,scene_depth?"current-frame-scene":"present-bound",current_depth,depth_draws,depth_vertices,target_width,target_height);
        ComPtr<ID3D12Resource> color,depth;
        if(FAILED(interop->UnwrapUnderlyingResource(color9.Get(),queue.Get(),IID_PPV_ARGS(&color))))return;
        if(FAILED(interop->UnwrapUnderlyingResource(depth9.Get(),queue.Get(),IID_PPV_ARGS(&depth)))){interop->ReturnUnderlyingResource(color9.Get(),0,nullptr,nullptr);return;}
        bool prepared=Prepare(color.Get(),depth.Get());FeedFrameResult result{};bool ready=false;
        if(prepared&&Begin()){
            Barrier(list.Get(),color.Get(),D3D12_RESOURCE_STATE_COMMON,D3D12_RESOURCE_STATE_COPY_SOURCE);
            Barrier(list.Get(),shared[FEED_COLOR].Get(),D3D12_RESOURCE_STATE_COMMON,D3D12_RESOURCE_STATE_COPY_DEST);list->CopyResource(shared[FEED_COLOR].Get(),color.Get());
            Barrier(list.Get(),shared[FEED_COLOR].Get(),D3D12_RESOURCE_STATE_COPY_DEST,D3D12_RESOURCE_STATE_COMMON);
            Barrier(list.Get(),color.Get(),D3D12_RESOURCE_STATE_COPY_SOURCE,D3D12_RESOURCE_STATE_COMMON);
            const bool depth_recorded=depth_copy.Record(list.Get(),depth.Get(),shared[FEED_DEPTH].Get());
            if(End()&&depth_recorded){++counters.submitted;ready=host.Submit(queue.Get(),history_reset,result);if(ready)history_reset=false;}
            if(ready&&Begin()){
                Barrier(list.Get(),shared[FEED_OUTPUT].Get(),D3D12_RESOURCE_STATE_COMMON,D3D12_RESOURCE_STATE_COPY_SOURCE);
                Barrier(list.Get(),color.Get(),D3D12_RESOURCE_STATE_COMMON,D3D12_RESOURCE_STATE_COPY_DEST);list->CopyResource(color.Get(),shared[FEED_OUTPUT].Get());
                Barrier(list.Get(),color.Get(),D3D12_RESOURCE_STATE_COPY_DEST,D3D12_RESOURCE_STATE_COMMON);
                Barrier(list.Get(),shared[FEED_OUTPUT].Get(),D3D12_RESOURCE_STATE_COPY_SOURCE,D3D12_RESOURCE_STATE_COMMON);ready=End();if(ready){++counters.copied;if(result.nr_completed)++counters.nr_completed;}
            }else if(ready)ready=false;
        }
        ID3D12Fence *fences[]={fence.Get()};UINT64 values[]={value};
        HRESULT a=interop->ReturnUnderlyingResource(color9.Get(),value?1:0,values,fences),b=interop->ReturnUnderlyingResource(depth9.Get(),value?1:0,values,fences);
        if(FAILED(a)||FAILED(b)){failed=true;Log("[nr-feeder-dx9] resource return failed");}
        if(retained){color.Detach();depth.Detach();color9.Detach();depth9.Detach();return;}
        ++frames;if(ready&&(result.frame<=3||result.frame%30==0))Log("[nr-feeder-client-completion] frame=%llu output_ready=1 nr_completed=%u",result.frame,result.nr_completed);
        if(!ready&&(frames<=3||frames%30==0))Log("[nr-feeder-client-retained] frame=%llu reason=%s",frames,prepared?host.reason:"unsupported color or depth");
    }
    void Close(){DiscardDepth();host.Close();if(retained)return;depth_copy.Release();for(auto &texture:shared)texture.Reset();for(auto &handle:handles){if(handle)CloseHandle(handle);handle=nullptr;}
        list.Reset();allocator.Reset();fence.Reset();queue.Reset();device.Reset();interop.Reset();game.Reset();if(event)CloseHandle(event);event=nullptr;}
};
// Deliberately heap-owned: GPU/host cleanup is never executed under DllMain's lock.
Session *session=nullptr;std::recursive_mutex *gate=new std::recursive_mutex;bool entered=false;
void RefreshControl(){const auto previous=control.generation;control.Refresh();if(previous!=control.generation)Log("[nr-feeder-dx9-control] enabled=%u action=%s",control.enabled?1:0,control.enabled?"new-frame-history":"passthrough-no-submit");}
bool OwnCommand(reshade::api::command_list *cmd){return session&&session->owner&&control.enabled&&cmd->get_device()==session->owner->get_device();}
void BindDepth(reshade::api::command_list *cmd,uint32_t,const reshade::api::resource_view *,reshade::api::resource_view depth){std::lock_guard lock(*gate);if(OwnCommand(cmd))session->BindDepth(depth.handle!=0);}
bool Draw(reshade::api::command_list *cmd,uint32_t count,uint32_t instances,uint32_t,uint32_t){std::lock_guard lock(*gate);if(OwnCommand(cmd))session->Draw(count,instances);return false;}
bool DrawIndexed(reshade::api::command_list *cmd,uint32_t count,uint32_t instances,uint32_t,int32_t,uint32_t){std::lock_guard lock(*gate);if(OwnCommand(cmd))session->Draw(count,instances);return false;}
void Overlay(reshade::api::effect_runtime *runtime){if(runtime->get_device()->get_api()!=reshade::api::device_api::d3d9)return;std::lock_guard lock(*gate);RefreshControl();
    bool enabled=control.enabled;if(ImGui::Checkbox("启用 NR 回填",&enabled)&&control.Save(enabled))Log("[nr-feeder-dx9-control] enabled=%u action=%s source=overlay",enabled?1:0,enabled?"new-frame-history":"passthrough-no-submit");
    ImGui::TextWrapped("关闭后直接保留游戏原帧，不向 NR 宿主提交。此开关独立于 ReShade 的全局着色器开关。");
    ImGui::TextWrapped("NR 参数请在管理器设置；本面板不提供跨进程 Core 调节。Feeder 0.15.1 / Jean-Laurent ROUZIES；DX9 回填由本项目维护。");
    if(!control.error.empty())ImGui::TextWrapped("%s",control.error.c_str());
}
void Present(reshade::api::command_queue *,reshade::api::swapchain *swapchain,const reshade::api::rect *,const reshade::api::rect *,uint32_t,const reshade::api::rect *){
    if(!swapchain||swapchain->get_device()->get_api()!=reshade::api::device_api::d3d9)return;std::lock_guard lock(*gate);if(entered)return;entered=true;
    ++counters.presents;RefreshControl();if(!control.enabled){++counters.disabled_presents;if(session)session->DiscardDepth();entered=false;return;}
    if(!session){session=new Session;if(!session->Init(swapchain)){session->failed=true;Log("[nr-feeder-dx9] system 9On12 session unavailable");}}
    if(session->owner==swapchain)session->Present();entered=false;
}
void Destroy(reshade::api::swapchain *swapchain,bool){std::lock_guard lock(*gate);if(session&&session->owner==swapchain){session->Close();if(!session->retained)delete session;session=nullptr;}}
}
extern "C" __declspec(dllexport) const char *NAME="Xiaofeng NR D3D9On12 relay";
extern "C" __declspec(dllexport) BOOL __cdecl NrFeederDx9QueryStatus(NrFeederDx9Status *output,std::uint32_t size){if(!output||size!=sizeof(NrFeederDx9Status))return FALSE;std::lock_guard lock(*gate);counters.enabled=control.enabled?1u:0u;*output=counters;return TRUE;}
extern "C" __declspec(dllexport) const char *DESCRIPTION="Same-frame D3D9 color and raw depth to the sole x64 NR Core host.";
BOOL APIENTRY DllMain(HMODULE handle,DWORD reason,LPVOID){if(reason==DLL_PROCESS_ATTACH){module=handle;DisableThreadLibraryCalls(handle);wchar_t file[MAX_PATH]{};GetModuleFileNameW(handle,file,MAX_PATH);wchar_t *slash=wcsrchr(file,L'\\');if(!slash)return FALSE;*slash=0;directory=file;
        control.file=directory+L"\\dlss5-feed.cfg";
        if(!reshade::register_addon(handle))return FALSE;reshade::register_event<reshade::addon_event::present>(Present);reshade::register_event<reshade::addon_event::destroy_swapchain>(Destroy);
        reshade::register_event<reshade::addon_event::bind_render_targets_and_depth_stencil>(BindDepth);reshade::register_event<reshade::addon_event::draw>(Draw);reshade::register_event<reshade::addon_event::draw_indexed>(DrawIndexed);reshade::register_overlay(overlay_title,Overlay);
    }else if(reason==DLL_PROCESS_DETACH){reshade::unregister_overlay(overlay_title,Overlay);reshade::unregister_event<reshade::addon_event::draw_indexed>(DrawIndexed);reshade::unregister_event<reshade::addon_event::draw>(Draw);reshade::unregister_event<reshade::addon_event::bind_render_targets_and_depth_stencil>(BindDepth);reshade::unregister_event<reshade::addon_event::present>(Present);reshade::unregister_event<reshade::addon_event::destroy_swapchain>(Destroy);reshade::unregister_addon(handle);}return TRUE;}
