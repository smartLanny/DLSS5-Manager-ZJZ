#pragma once
#include <windows.h>
#include <d3d12.h>
#include <dxgi1_4.h>
#include <wrl/client.h>
#include <reshade.hpp>
#include <string>
#include "nr_feeder_consumer.h"

// Only the host creates this manual ReShade runtime. D3D9 games supply color
// and copied raw depth; unchanged VORT pixel passes run here with SM4+ support.
namespace nr_feeder_host_guides {
using Microsoft::WRL::ComPtr;
struct Guides;
inline Guides *active = nullptr;
void Begin(reshade::api::effect_runtime *, reshade::api::command_list *, reshade::api::resource_view, reshade::api::resource_view);
inline std::string ConfigPath() {
    wchar_t file[MAX_PATH]{}; if (!GetModuleFileNameW(nullptr, file, MAX_PATH)) return {};
    wchar_t *slash = wcsrchr(file, L'\\'); if (!slash) return {}; *(slash + 1) = 0;
    std::wstring wide = std::wstring(file) + L"NRGuides.ini";
    int length = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, nullptr, 0, nullptr, nullptr);
    std::string result(length, '\0'); if (length > 1) WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, result.data(), length, nullptr, nullptr);
    if (!result.empty()) result.pop_back(); return result;
}
struct Guides {
    ComPtr<ID3D12Device> device; ComPtr<ID3D12CommandQueue> queue;
    ComPtr<IDXGISwapChain3> swap; ComPtr<ID3D12CommandAllocator> allocator;
    ComPtr<ID3D12GraphicsCommandList> list; ComPtr<ID3D12Fence> fence;
    reshade::api::effect_runtime *runtime = nullptr; reshade::api::resource_view depth_view{};
    ID3D12Resource *depth_resource = nullptr;
    HWND window = nullptr; HANDLE event = nullptr; UINT width = 0, height = 0; DXGI_FORMAT format = DXGI_FORMAT_UNKNOWN;
    UINT64 value = 0; bool retained = false, registered = false, addon_registered = false; const char *reason = "not initialized";
    static LRESULT CALLBACK WindowProc(HWND w, UINT m, WPARAM a, LPARAM b) { return DefWindowProcW(w,m,a,b); }
    bool Complete() {
        if (!nr_feeder::Complete(fence.Get(), event, value)) { retained = true; reason = "guide GPU completion unconfirmed"; return false; }
        return true;
    }
    void Release() {
        if (retained || nr_feeder::quarantined) return;
        active = nullptr;
        if (runtime) {
            if (depth_view.handle) runtime->get_device()->destroy_resource_view(depth_view);
            depth_view = {}; reshade::destroy_effect_runtime(runtime); runtime = nullptr;
        }
        if (registered) { reshade::unregister_event<reshade::addon_event::reshade_begin_effects>(Begin); registered = false; }
        if (addon_registered) { reshade::unregister_addon(GetModuleHandleW(nullptr)); addon_registered = false; }
        list.Reset(); allocator.Reset(); fence.Reset(); swap.Reset(); queue.Reset(); device.Reset();
        if (event) CloseHandle(event); event = nullptr; if (window) DestroyWindow(window); window = nullptr;
        width = height = 0; value = 0; depth_resource = nullptr;
    }
    bool Prepare(ID3D12Device *dev, ID3D12CommandQueue *q, ID3D12Resource *color, ID3D12Resource *depth) {
        const auto cd = color->GetDesc(), dd = depth->GetDesc();
        if (runtime && width == cd.Width && height == cd.Height && format == cd.Format && depth_resource == depth) return true;
        Release(); if (retained || nr_feeder::quarantined) return false;
        device = dev; queue = q; width = static_cast<UINT>(cd.Width); height = cd.Height; format = cd.Format;
        if (!width || !height || dd.Width != width || dd.Height != height || dd.Format != DXGI_FORMAT_R32_FLOAT) { reason = "raw depth contract mismatch"; return false; }
        WNDCLASSW wc{}; wc.lpfnWndProc = WindowProc; wc.hInstance = GetModuleHandleW(nullptr); wc.lpszClassName = L"NRFeederHostGuides"; RegisterClassW(&wc);
        window = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, wc.lpszClassName, L"NR host guides", WS_POPUP, 0, 0, width, height, nullptr, nullptr, wc.hInstance, nullptr);
        if (!window) { reason = "guide window unavailable"; return false; }
        HMODULE dxgi = GetModuleHandleW(L"dxgi.dll");
        auto create = dxgi ? reinterpret_cast<decltype(&CreateDXGIFactory1)>(GetProcAddress(dxgi,"CreateDXGIFactory1")) : nullptr;
        ComPtr<IDXGIFactory2> factory; if (!create || FAILED(create(IID_PPV_ARGS(&factory)))) { reason = "guide DXGI factory unavailable"; return false; }
        DXGI_SWAP_CHAIN_DESC1 sc{};sc.Width=width;sc.Height=height;sc.Format=format;sc.SampleDesc.Count=1;sc.BufferUsage=DXGI_USAGE_RENDER_TARGET_OUTPUT;sc.BufferCount=2;sc.SwapEffect=DXGI_SWAP_EFFECT_FLIP_DISCARD;
        ComPtr<IDXGISwapChain1> initial;
        if (FAILED(factory->CreateSwapChainForHwnd(q,window,&sc,nullptr,nullptr,&initial)) || FAILED(initial.As(&swap))) { reason = "guide swapchain unavailable"; return false; }
        swap->SetColorSpace1(DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709);
        if (FAILED(dev->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT,IID_PPV_ARGS(&allocator))) ||
            FAILED(dev->CreateCommandList(0,D3D12_COMMAND_LIST_TYPE_DIRECT,allocator.Get(),nullptr,IID_PPV_ARGS(&list)))) { reason = "guide command list unavailable"; return false; }
        list->Close(); if (FAILED(dev->CreateFence(0,D3D12_FENCE_FLAG_NONE,IID_PPV_ARGS(&fence)))) { reason = "guide fence unavailable"; return false; }
        event=CreateEventW(nullptr,FALSE,FALSE,nullptr);if(!event){reason="guide event unavailable";return false;}
        const auto config=ConfigPath();
        if (config.empty() || !reshade::create_effect_runtime(reshade::api::device_api::d3d12,dev,q,swap.Get(),config.c_str(),&runtime)) { reason = "manual ReShade runtime unavailable"; return false; }
        auto *api = runtime->get_device();
        reshade::api::resource_view_desc view(reshade::api::format::r32_float,0,1,0,1);
        if (!api->create_resource_view({reinterpret_cast<std::uint64_t>(depth)},reshade::api::resource_usage::shader_resource,view,&depth_view)) { reason="host depth view unavailable"; return false; }
        addon_registered=reshade::register_addon(GetModuleHandleW(nullptr));
        if(!addon_registered){reason="host guide event owner unavailable";return false;}
        depth_resource=depth; active=this;reshade::register_event<reshade::addon_event::reshade_begin_effects>(Begin);registered=true;
        reason="warming VORT shaders";return true;
    }
    bool BeginCommands() { return SUCCEEDED(allocator->Reset()) && SUCCEEDED(list->Reset(allocator.Get(),nullptr)); }
    bool EndCommands() { if (FAILED(list->Close())) return false;ID3D12CommandList *lists[]={list.Get()};queue->ExecuteCommandLists(1,lists);
        if(FAILED(queue->Signal(fence.Get(),++value)))return false;return Complete(); }
    bool Render(ID3D12Device *dev,ID3D12CommandQueue *q,ID3D12Resource *color,ID3D12Resource *depth,ID3D12Resource *motion) {
        if (!Prepare(dev,q,color,depth) || !BeginCommands()) return false;
        ComPtr<ID3D12Resource> backbuffer;
        if (FAILED(swap->GetBuffer(swap->GetCurrentBackBufferIndex(),IID_PPV_ARGS(&backbuffer)))) { reason="guide backbuffer unavailable";return false; }
        nr_feeder::Transition(list.Get(),color,D3D12_RESOURCE_STATE_COMMON,D3D12_RESOURCE_STATE_COPY_SOURCE);
        nr_feeder::Transition(list.Get(),backbuffer.Get(),D3D12_RESOURCE_STATE_PRESENT,D3D12_RESOURCE_STATE_COPY_DEST);
        list->CopyResource(backbuffer.Get(),color);
        nr_feeder::Transition(list.Get(),backbuffer.Get(),D3D12_RESOURCE_STATE_COPY_DEST,D3D12_RESOURCE_STATE_PRESENT);
        nr_feeder::Transition(list.Get(),color,D3D12_RESOURCE_STATE_COPY_SOURCE,D3D12_RESOURCE_STATE_COMMON);
        constexpr auto sampled=D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE|D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE;
        nr_feeder::Transition(list.Get(),depth,D3D12_RESOURCE_STATE_COMMON,sampled);
        if(!EndCommands())return false;
        reshade::update_and_present_effect_runtime(runtime);
        if(FAILED(queue->Signal(fence.Get(),++value))||!Complete())return false;
        const auto mv=runtime->find_texture_variable("DLSS5_Feed.fx","DLSS5_MV"),dp=runtime->find_texture_variable("DLSS5_Feed.fx","DLSS5_Depth");
        reshade::api::resource_view mview{},dview{},unused{};
        if(mv.handle)runtime->get_texture_binding(mv,&mview,&unused);if(dp.handle)runtime->get_texture_binding(dp,&dview,&unused);
        auto *api=runtime->get_device();
        auto *m=mview.handle?reinterpret_cast<ID3D12Resource*>(api->get_resource_from_view(mview).handle):nullptr;
        auto *d=dview.handle?reinterpret_cast<ID3D12Resource*>(api->get_resource_from_view(dview).handle):nullptr;
        bool ready=m&&d&&m->GetDesc().Width==width&&m->GetDesc().Height==height&&m->GetDesc().Format==DXGI_FORMAT_R16G16_FLOAT&&
            d->GetDesc().Width==width&&d->GetDesc().Height==height&&d->GetDesc().Format==DXGI_FORMAT_R32_FLOAT;
        if(!BeginCommands())return false;
        nr_feeder::Transition(list.Get(),depth,sampled,D3D12_RESOURCE_STATE_COMMON);
        if(ready){
            for(auto pair:{std::pair<ID3D12Resource*,ID3D12Resource*>{m,motion},{d,depth}}){
                nr_feeder::Transition(list.Get(),pair.first,sampled,D3D12_RESOURCE_STATE_COPY_SOURCE);
                nr_feeder::Transition(list.Get(),pair.second,D3D12_RESOURCE_STATE_COMMON,D3D12_RESOURCE_STATE_COPY_DEST);
                list->CopyResource(pair.second,pair.first);
                nr_feeder::Transition(list.Get(),pair.second,D3D12_RESOURCE_STATE_COPY_DEST,D3D12_RESOURCE_STATE_COMMON);
                nr_feeder::Transition(list.Get(),pair.first,D3D12_RESOURCE_STATE_COPY_SOURCE,sampled);
            }
        }
        if(!EndCommands())return false;
        reason=ready?"VORT pixel guides completed":"warming VORT shaders";return ready;
    }
};
inline Guides guides;
inline void Begin(reshade::api::effect_runtime *runtime,reshade::api::command_list *,reshade::api::resource_view,reshade::api::resource_view) {
    if(active&&runtime==active->runtime&&active->depth_view.handle)runtime->update_texture_bindings("DEPTH",active->depth_view,active->depth_view);
}
}
