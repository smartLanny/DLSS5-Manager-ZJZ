// Controlled DX12 renderer for the real ReShade/Feeder callback path.
// It does not call Provider exports or provide synthetic guide textures.
// Guides must be produced by the installed ReShade depth/VORT shader pipeline.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <d3d12.h>
#include <dxgi1_4.h>
#include <d3dcompiler.h>
#include <wrl/client.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <vector>
#include "nr_external_provider_abi.h"
using Microsoft::WRL::ComPtr;

static void need(bool value, const char *name) {
    if (value) return;
    std::fprintf(stderr, "DX12 fixture failed: %s\n", name);
    // On a fence/driver failure do not unwind and release in-flight objects.
    ExitProcess(12);
}
static void hr(HRESULT result, const char *name) {
    if (FAILED(result)) std::fprintf(stderr, "HRESULT=0x%08lX %s\n", static_cast<unsigned long>(result), name);
    need(SUCCEEDED(result), name);
}
static std::uint64_t hashBytes(const void *data, std::size_t length) {
    const auto *bytes = static_cast<const unsigned char *>(data);
    std::uint64_t hash = 1469598103934665603ull;
    for (std::size_t n = 0; n < length; ++n) hash = (hash ^ bytes[n]) * 1099511628211ull;
    return hash;
}
static std::string narrow(const wchar_t *text) {
    const int count = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
    std::string value(count > 0 ? count : 0, '\0');
    if (count > 1) WideCharToMultiByte(CP_UTF8, 0, text, -1, value.data(), count, nullptr, nullptr);
    if (count > 0) value.resize(count-1);
    return value;
}
static LRESULT CALLBACK windowProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    if (message == WM_CLOSE) { DestroyWindow(window); return 0; }
    if (message == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProcW(window, message, wparam, lparam);
}
static const char shader[] = R"hlsl(
cbuffer Draw : register(b0) { float4 transform; float4 tint; }
struct Vertex { float4 position:SV_Position; float2 uv:TEXCOORD0; };
Vertex VSMain(uint vertex:SV_VertexID) {
    float2 corners[6] = {float2(-1,-1),float2(1,-1),float2(-1,1),float2(-1,1),float2(1,-1),float2(1,1)};
    Vertex o; o.position=float4(corners[vertex]*transform.z+transform.xy,transform.w,1);
    o.uv=corners[vertex]*0.5+0.5; return o;
}
float4 PSMain(Vertex i):SV_Target {
    float c=fmod(floor(i.uv.x*18)+floor(i.uv.y*18),2);
    return float4(tint.rgb*(0.3+0.55*c)+0.025,1);
}
)hlsl";

static std::string utcNow() {
    SYSTEMTIME t{}; GetSystemTime(&t); char value[40]{};
    std::snprintf(value,sizeof(value),"%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",t.wYear,t.wMonth,t.wDay,t.wHour,t.wMinute,t.wSecond,t.wMilliseconds);
    return value;
}
static bool readCoreStatus(NrExternalStatusV1 &status) {
    // Observation only. The fixture never Claim/Submit/Create/Evaluates NR;
    // actual work must still come from Feeder's ordinary ReShade callbacks.
    const HMODULE core=GetModuleHandleW(L"DLSS5-AI渲染超分版-beta0.4.7-@野生的装机宅-Bilibili.addon64");
    using Query=std::int32_t(WINAPI *)(std::uint32_t,std::uint32_t,std::uint32_t,NrExternalStatusV1 *);
    const auto query=core?reinterpret_cast<Query>(GetProcAddress(core,"NRExternalProvider_QueryV1")):nullptr;
    status={}; return query && query(kNrExternalProviderAbi,sizeof(status),0,&status)!=0 && status.size==sizeof(status) && status.abi==kNrExternalProviderAbi;
}

struct ReadbackSample {
    unsigned frame = 0, changed = 0, alphaChanged = 0, depthKinds = 0;
    unsigned width = 0, height = 0;
    std::uint64_t inputHash = 0, outputHash = 0, depthHash = 0;
    std::string utc;
    bool coreQuery = false;
    NrExternalStatusV1 core{};
};
struct Renderer {
    UINT width = 640, height = 360;
    ComPtr<IDXGIFactory4> factory;
    ComPtr<IDXGIAdapter1> adapter;
    ComPtr<ID3D12Device> device;
    ComPtr<ID3D12CommandQueue> queue;
    ComPtr<IDXGISwapChain3> swapchain;
    ComPtr<ID3D12CommandAllocator> allocator;
    ComPtr<ID3D12GraphicsCommandList> list;
    ComPtr<ID3D12Fence> fence;
    ComPtr<ID3D12DescriptorHeap> rtvHeap, dsvHeap;
    ComPtr<ID3D12RootSignature> root;
    ComPtr<ID3D12PipelineState> pipeline;
    ComPtr<ID3D12Resource> depth, colorReadback, depthReadback;
    ComPtr<ID3D12Resource> buffers[2];
    UINT rtvStride = 0, rowPitch = 0;
    UINT64 fenceValue = 0;
    HANDLE event = nullptr;
    std::string gpu;
    std::vector<ReadbackSample> samples;
    unsigned draws = 0;
    void wait() {
        const UINT64 wanted = ++fenceValue;
        hr(queue->Signal(fence.Get(), wanted), "queue Signal");
        hr(fence->SetEventOnCompletion(wanted, event), "SetEventOnCompletion");
        need(WaitForSingleObject(event, 10000) == WAIT_OBJECT_0, "GPU completion timeout");
        const auto value = fence->GetCompletedValue();
        need(value != UINT64_MAX && value >= wanted, "actual GPU fence completion");
    }
    void begin() {
        hr(allocator->Reset(), "allocator Reset"); hr(list->Reset(allocator.Get(), nullptr), "list Reset");
    }
    void execute() {
        hr(list->Close(), "list Close"); ID3D12CommandList *lists[] = {list.Get()}; queue->ExecuteCommandLists(1, lists);
    }
    void barrier(ID3D12Resource *resource, D3D12_RESOURCE_STATES before, D3D12_RESOURCE_STATES after) {
        D3D12_RESOURCE_BARRIER b{}; b.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
        b.Transition = {resource, D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES, before, after}; list->ResourceBarrier(1, &b);
    }
    void copyTexture(ID3D12Resource *source, ID3D12Resource *dest, DXGI_FORMAT format, UINT64 offset = 0) {
        D3D12_TEXTURE_COPY_LOCATION from{}, to{};
        from.pResource = source; from.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
        to.pResource = dest; to.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT; to.PlacedFootprint.Offset = offset;
        to.PlacedFootprint.Footprint = {format, width, height, 1, rowPitch}; list->CopyTextureRegion(&to, 0, 0, 0, &from, nullptr);
    }
    void readbackResource(ComPtr<ID3D12Resource> &out, UINT64 size) {
        D3D12_HEAP_PROPERTIES heap{}; heap.Type = D3D12_HEAP_TYPE_READBACK;
        D3D12_RESOURCE_DESC d{}; d.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER; d.Width = size; d.Height = 1;
        d.DepthOrArraySize = 1; d.MipLevels = 1; d.SampleDesc.Count = 1; d.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
        hr(device->CreateCommittedResource(&heap, D3D12_HEAP_FLAG_NONE, &d, D3D12_RESOURCE_STATE_COPY_DEST, nullptr, IID_PPV_ARGS(&out)), "readback resource");
    }
    void createTargets() {
        const auto start = rtvHeap->GetCPUDescriptorHandleForHeapStart();
        for (unsigned n = 0; n < 2; ++n) {
            hr(swapchain->GetBuffer(n, IID_PPV_ARGS(&buffers[n])), "swapchain buffer");
            D3D12_CPU_DESCRIPTOR_HANDLE handle{start.ptr + n * rtvStride}; device->CreateRenderTargetView(buffers[n].Get(), nullptr, handle);
        }
        D3D12_HEAP_PROPERTIES heap{}; heap.Type = D3D12_HEAP_TYPE_DEFAULT;
        D3D12_RESOURCE_DESC d{}; d.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D; d.Width = width; d.Height = height;
        d.DepthOrArraySize = 1; d.MipLevels = 1; d.SampleDesc.Count = 1; d.Format = DXGI_FORMAT_D32_FLOAT; d.Flags = D3D12_RESOURCE_FLAG_ALLOW_DEPTH_STENCIL;
        D3D12_CLEAR_VALUE clear{}; clear.Format = d.Format; clear.DepthStencil.Depth = 1;
        hr(device->CreateCommittedResource(&heap, D3D12_HEAP_FLAG_NONE, &d, D3D12_RESOURCE_STATE_DEPTH_WRITE, &clear, IID_PPV_ARGS(&depth)), "depth attachment");
        device->CreateDepthStencilView(depth.Get(), nullptr, dsvHeap->GetCPUDescriptorHandleForHeapStart());
        rowPitch = (width * 4 + 255) & ~255u;
        readbackResource(colorReadback, static_cast<UINT64>(rowPitch) * height * 2);
        readbackResource(depthReadback, static_cast<UINT64>(rowPitch) * height);
    }
    void initialize(HWND window) {
        hr(CreateDXGIFactory1(IID_PPV_ARGS(&factory)), "DXGI factory (local ReShade proxy)");
        for (UINT index = 0; ; ++index) {
            ComPtr<IDXGIAdapter1> item;
            if (factory->EnumAdapters1(index, &item) == DXGI_ERROR_NOT_FOUND) break;
            DXGI_ADAPTER_DESC1 desc{}; item->GetDesc1(&desc);
            if (!(desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) && desc.VendorId == 0x10de) { adapter = item; gpu = narrow(desc.Description); break; }
        }
        need(adapter != nullptr && gpu.find("RTX 50") != std::string::npos, "fixture requires RTX50 hardware");
        hr(D3D12CreateDevice(adapter.Get(), D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(&device)), "D3D12 device");
        D3D12_COMMAND_QUEUE_DESC q{}; q.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
        hr(device->CreateCommandQueue(&q, IID_PPV_ARGS(&queue)), "direct queue");
        DXGI_SWAP_CHAIN_DESC1 desc{}; desc.Width = width; desc.Height = height; desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
        desc.SampleDesc.Count = 1; desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT; desc.BufferCount = 2;
        desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL; desc.AlphaMode = DXGI_ALPHA_MODE_IGNORE;
        ComPtr<IDXGISwapChain1> created;
        hr(factory->CreateSwapChainForHwnd(queue.Get(), window, &desc, nullptr, nullptr, &created), "real DX12 swapchain");
        hr(created.As(&swapchain), "swapchain3");
        hr(swapchain->SetColorSpace1(DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709), "actual SDR/sRGB swapchain color space");
        factory->MakeWindowAssociation(window, DXGI_MWA_NO_ALT_ENTER);
        hr(device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT, IID_PPV_ARGS(&allocator)), "allocator");
        hr(device->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, allocator.Get(), nullptr, IID_PPV_ARGS(&list)), "list");
        hr(list->Close(), "initial list Close");
        hr(device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&fence)), "fence");
        event = CreateEventW(nullptr, FALSE, FALSE, nullptr); need(event != nullptr, "fence event");
        D3D12_DESCRIPTOR_HEAP_DESC hd{}; hd.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV; hd.NumDescriptors = 2;
        hr(device->CreateDescriptorHeap(&hd, IID_PPV_ARGS(&rtvHeap)), "RTV heap");
        hd.Type = D3D12_DESCRIPTOR_HEAP_TYPE_DSV; hd.NumDescriptors = 1;
        hr(device->CreateDescriptorHeap(&hd, IID_PPV_ARGS(&dsvHeap)), "DSV heap");
        rtvStride = device->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_RTV);
        D3D12_ROOT_PARAMETER parameter{}; parameter.ParameterType = D3D12_ROOT_PARAMETER_TYPE_32BIT_CONSTANTS;
        parameter.Constants = {0, 0, 8}; parameter.ShaderVisibility = D3D12_SHADER_VISIBILITY_ALL;
        D3D12_ROOT_SIGNATURE_DESC rs{1, &parameter, 0, nullptr, D3D12_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT};
        ComPtr<ID3DBlob> blob, errors, vs, ps;
        hr(D3D12SerializeRootSignature(&rs, D3D_ROOT_SIGNATURE_VERSION_1, &blob, &errors), "root serialization");
        hr(device->CreateRootSignature(0, blob->GetBufferPointer(), blob->GetBufferSize(), IID_PPV_ARGS(&root)), "root signature");
        hr(D3DCompile(shader, sizeof(shader)-1, "feeder-dx12-fixture", nullptr, nullptr, "VSMain", "vs_5_0", D3DCOMPILE_ENABLE_STRICTNESS, 0, &vs, &errors), "geometry vertex shader");
        hr(D3DCompile(shader, sizeof(shader)-1, "feeder-dx12-fixture", nullptr, nullptr, "PSMain", "ps_5_0", D3DCOMPILE_ENABLE_STRICTNESS, 0, &ps, &errors), "geometry pixel shader");
        D3D12_GRAPHICS_PIPELINE_STATE_DESC p{}; p.pRootSignature = root.Get();
        p.VS = {vs->GetBufferPointer(), vs->GetBufferSize()}; p.PS = {ps->GetBufferPointer(), ps->GetBufferSize()};
        p.RasterizerState.FillMode = D3D12_FILL_MODE_SOLID; p.RasterizerState.CullMode = D3D12_CULL_MODE_NONE; p.RasterizerState.DepthClipEnable = TRUE;
        for (auto &blend : p.BlendState.RenderTarget) {
            blend.SrcBlend = D3D12_BLEND_ONE; blend.DestBlend = D3D12_BLEND_ZERO; blend.BlendOp = D3D12_BLEND_OP_ADD;
            blend.SrcBlendAlpha = D3D12_BLEND_ONE; blend.DestBlendAlpha = D3D12_BLEND_ZERO; blend.BlendOpAlpha = D3D12_BLEND_OP_ADD;
            blend.LogicOp = D3D12_LOGIC_OP_NOOP; blend.RenderTargetWriteMask = D3D12_COLOR_WRITE_ENABLE_ALL;
        }
        p.DepthStencilState.DepthEnable = TRUE; p.DepthStencilState.DepthWriteMask = D3D12_DEPTH_WRITE_MASK_ALL; p.DepthStencilState.DepthFunc = D3D12_COMPARISON_FUNC_LESS;
        p.DepthStencilState.StencilReadMask = D3D12_DEFAULT_STENCIL_READ_MASK; p.DepthStencilState.StencilWriteMask = D3D12_DEFAULT_STENCIL_WRITE_MASK;
        p.DepthStencilState.FrontFace = {D3D12_STENCIL_OP_KEEP, D3D12_STENCIL_OP_KEEP, D3D12_STENCIL_OP_KEEP, D3D12_COMPARISON_FUNC_ALWAYS};
        p.DepthStencilState.BackFace = p.DepthStencilState.FrontFace;
        p.SampleMask = UINT_MAX; p.PrimitiveTopologyType = D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
        p.NumRenderTargets = 1; p.RTVFormats[0] = DXGI_FORMAT_R8G8B8A8_UNORM; p.DSVFormat = DXGI_FORMAT_D32_FLOAT; p.SampleDesc.Count = 1;
        hr(device->CreateGraphicsPipelineState(&p, IID_PPV_ARGS(&pipeline)), "actual raster pipeline");
        createTargets();
    }
    void resize() {
        wait(); for (auto &buffer : buffers) buffer.Reset(); depth.Reset(); colorReadback.Reset(); depthReadback.Reset();
        width = 768; height = 432;
        hr(swapchain->ResizeBuffers(2, width, height, DXGI_FORMAT_R8G8B8A8_UNORM, 0), "ResizeBuffers");
        hr(swapchain->SetColorSpace1(DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709), "SDR after resize"); createTargets();
    }
    void draw(unsigned frame, bool sample) {
        const UINT index = swapchain->GetCurrentBackBufferIndex(); auto *buffer = buffers[index].Get();
        begin(); barrier(buffer, D3D12_RESOURCE_STATE_PRESENT, D3D12_RESOURCE_STATE_RENDER_TARGET);
        auto rtv = rtvHeap->GetCPUDescriptorHandleForHeapStart(); rtv.ptr += index * rtvStride;
        const auto dsv = dsvHeap->GetCPUDescriptorHandleForHeapStart(); const float clear[] = {.02f,.03f,.04f,1};
        list->ClearRenderTargetView(rtv, clear, 0, nullptr); list->ClearDepthStencilView(dsv, D3D12_CLEAR_FLAG_DEPTH, 1, 0, 0, nullptr);
        list->OMSetRenderTargets(1, &rtv, FALSE, &dsv); list->SetGraphicsRootSignature(root.Get()); list->SetPipelineState(pipeline.Get());
        const D3D12_VIEWPORT viewport{0,0,float(width),float(height),0,1}; const D3D12_RECT scissor{0,0,LONG(width),LONG(height)};
        list->RSSetViewports(1, &viewport); list->RSSetScissorRects(1, &scissor); list->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        const float movement = std::sin(frame * .04f) * .4f;
        const float constants[3][8] = {{movement,-.08f,.3f,.2f,.85f,.22f,.1f,1}, {-.35f,.3f,.25f,.5f,.12f,.75f,.2f,1}, {0,0,1,.85f,.15f,.3f,.8f,1}};
        for (const auto &value : constants) { list->SetGraphicsRoot32BitConstants(0, 8, value, 0); list->DrawInstanced(6,1,0,0); ++draws; }
        if (sample) {
            barrier(buffer, D3D12_RESOURCE_STATE_RENDER_TARGET, D3D12_RESOURCE_STATE_COPY_SOURCE);
            copyTexture(buffer, colorReadback.Get(), DXGI_FORMAT_R8G8B8A8_UNORM);
            barrier(buffer, D3D12_RESOURCE_STATE_COPY_SOURCE, D3D12_RESOURCE_STATE_PRESENT);
            barrier(depth.Get(), D3D12_RESOURCE_STATE_DEPTH_WRITE, D3D12_RESOURCE_STATE_COPY_SOURCE);
            copyTexture(depth.Get(), depthReadback.Get(), DXGI_FORMAT_D32_FLOAT);
            barrier(depth.Get(), D3D12_RESOURCE_STATE_COPY_SOURCE, D3D12_RESOURCE_STATE_DEPTH_WRITE);
        } else barrier(buffer, D3D12_RESOURCE_STATE_RENDER_TARGET, D3D12_RESOURCE_STATE_PRESENT);
        execute();
        hr(swapchain->Present(1, 0), "real Present/ReShade callback"); wait();
        if (!sample) return;
        begin(); barrier(buffer, D3D12_RESOURCE_STATE_PRESENT, D3D12_RESOURCE_STATE_COPY_SOURCE);
        copyTexture(buffer, colorReadback.Get(), DXGI_FORMAT_R8G8B8A8_UNORM, static_cast<UINT64>(rowPitch) * height);
        barrier(buffer, D3D12_RESOURCE_STATE_COPY_SOURCE, D3D12_RESOURCE_STATE_PRESENT); execute(); wait();
        void *mapped = nullptr; const SIZE_T size = static_cast<SIZE_T>(rowPitch)*height; const D3D12_RANGE range{0,size*2};
        hr(colorReadback->Map(0,&range,&mapped),"completed color readback");
        const auto *in = static_cast<const unsigned char *>(mapped), *out = in+size;
        ReadbackSample item{}; item.frame = frame; item.width=width; item.height=height;
        item.utc=utcNow(); item.coreQuery=readCoreStatus(item.core);
        std::vector<unsigned char> input, output; input.reserve(width*height*4); output.reserve(width*height*4);
        for(UINT y=0;y<height;++y) for(UINT x=0;x<width;++x) {
            const auto *a=in+y*rowPitch+x*4, *b=out+y*rowPitch+x*4;
            item.changed += a[0]!=b[0] || a[1]!=b[1] || a[2]!=b[2]; item.alphaChanged += a[3]!=b[3];
            input.insert(input.end(),a,a+4); output.insert(output.end(),b,b+4);
        }
        item.inputHash=hashBytes(input.data(),input.size()); item.outputHash=hashBytes(output.data(),output.size());
        const D3D12_RANGE empty{0,0}; colorReadback->Unmap(0,&empty);
        const D3D12_RANGE depthRange{0,size}; hr(depthReadback->Map(0,&depthRange,&mapped),"completed actual depth readback");
        item.depthHash=hashBytes(mapped,size); bool haveNear=false,haveMiddle=false,haveFar=false;
        for(UINT y=0;y<height;++y) for(UINT x=0;x<width;++x) { const float z=*reinterpret_cast<const float *>(static_cast<const unsigned char *>(mapped)+y*rowPitch+x*4);
            need(std::isfinite(z) && z>=0 && z<=1,"finite rasterized depth"); haveNear|=z<.3f;haveMiddle|=z>.4f&&z<.6f;haveFar|=z>.8f; }
        item.depthKinds=unsigned(haveNear)+unsigned(haveMiddle)+unsigned(haveFar); depthReadback->Unmap(0,&empty); samples.push_back(item);
    }
};

int WINAPI wWinMain(HINSTANCE instance,HINSTANCE,LPWSTR,int) {
    int argc=0; wchar_t **args=CommandLineToArgvW(GetCommandLineW(),&argc);
    unsigned frames=600,resizeAt=301,minFrameMs=0; bool resize=false;
    for(int n=1;n<argc;++n) { const std::wstring option=args[n];
        if(option==L"--frames" && n+1<argc)frames=std::wcstoul(args[++n],nullptr,10);
        else if(option==L"--frame-ms" && n+1<argc)minFrameMs=std::wcstoul(args[++n],nullptr,10);
        else if(option==L"--resize-at" && n+1<argc)resizeAt=std::wcstoul(args[++n],nullptr,10);
        else if(option==L"--resize")resize=true;else need(false,"unknown fixture argument"); }
    LocalFree(args); need(frames>=1&&frames<=3600&&minFrameMs<=32&&(!resize||(resizeAt>1&&resizeAt<frames)),"bounded frame request");
    WNDCLASSW wc{};wc.lpfnWndProc=windowProc;wc.hInstance=instance;wc.lpszClassName=L"XiaofengFeederDx12Fixture";RegisterClassW(&wc);
    RECT rect{0,0,640,360};AdjustWindowRect(&rect,WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU,FALSE);
    HWND window=CreateWindowW(wc.lpszClassName,L"DX12 Feeder controlled callback",WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU,CW_USEDEFAULT,CW_USEDEFAULT,
        rect.right-rect.left,rect.bottom-rect.top,nullptr,nullptr,instance,nullptr);need(window!=nullptr,"fixture window");ShowWindow(window,SW_SHOW);
    const std::string started=utcNow();std::string resizeStarted,resizeCompleted;NrExternalStatusV1 coreBeforeResize{};
    Renderer renderer;renderer.initialize(window);unsigned completed=0;
    for(unsigned frame=1;frame<=frames;++frame) {
        const ULONGLONG frameStarted=GetTickCount64();
        MSG message{};while(PeekMessageW(&message,nullptr,0,0,PM_REMOVE)){need(message.message!=WM_QUIT,"fixture closed early");TranslateMessage(&message);DispatchMessageW(&message);}
        if(resize&&frame==resizeAt){resizeStarted=utcNow();readCoreStatus(coreBeforeResize);renderer.resize();resizeCompleted=utcNow();}
        renderer.draw(frame,frame%60==0||frame==frames);completed=frame;
        const ULONGLONG elapsed=GetTickCount64()-frameStarted;
        if(elapsed<minFrameMs)Sleep(static_cast<DWORD>(minFrameMs-elapsed));
    }
    renderer.wait();
    const bool feeder=GetModuleHandleW(L"dlss5-feed-dx12-sdr.addon64")!=nullptr || GetModuleHandleW(L"dlss5-feed.addon64")!=nullptr;
    std::ofstream out("feeder-dx12-report.json",std::ios::binary|std::ios::trunc);need(bool(out),"fixture report");
    out<<"{\n  \"schema\":1,\"api\":\"dx12\",\"pid\":"<<GetCurrentProcessId()<<",\"frames\":"<<completed
       <<",\"requestedFrames\":"<<frames<<",\"drawCalls\":"<<renderer.draws<<",\"actualSrgbSwapchain\":true,\"feederLoaded\":"<<(feeder?"true":"false")
       <<",\"resize\":"<<(resize?"true":"false")<<",\"resizeAt\":"<<resizeAt<<",\"minimumFrameTimeMs\":"<<minFrameMs
       <<",\"startedUtc\":\""<<started<<"\",\"resizeStartedUtc\":\""<<resizeStarted<<"\",\"resizeCompletedUtc\":\""<<resizeCompleted
       <<"\",\"nrWritebacksBeforeResize\":"<<coreBeforeResize.writeback_frames<<",\"gpu\":\""<<renderer.gpu<<"\",\n  \"samples\":[";
    bool first=true;for(const auto &s:renderer.samples){if(!first)out<<",";first=false;out<<"{\"frame\":"<<s.frame<<",\"changedRgbPixels\":"<<s.changed<<",\"changedAlphaPixels\":"<<s.alphaChanged
       <<",\"width\":"<<s.width<<",\"height\":"<<s.height<<",\"utc\":\""<<s.utc<<"\",\"coreQuery\":"<<(s.coreQuery?"true":"false")
       <<",\"nrWritebacks\":"<<s.core.writeback_frames<<",\"providerOwner\":"<<s.core.owner_provider_id<<",\"lastBypass\":"<<s.core.last_bypass
       <<",\"depthKinds\":"<<s.depthKinds<<",\"inputHash\":\""<<std::hex<<s.inputHash<<"\",\"outputHash\":\""<<s.outputHash<<"\",\"depthHash\":\""<<s.depthHash<<"\"}"<<std::dec;}
    out<<"],\n  \"exit\":\"clean\",\"runtimeAcceptance\":\"separate-feeder-completion-evidence-required\"\n}\n";out.close();
    // Release all GPU objects before reporting process success; the parent
    // verifies the real OS exit code as well as this report.
    CloseHandle(renderer.event);renderer.event=nullptr;DestroyWindow(window);return 0;
}
