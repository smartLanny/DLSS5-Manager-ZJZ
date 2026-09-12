#pragma once
#include <windows.h>
#include <d3d12.h>
#include <d3dcompiler.h>
#include <wrl/client.h>

namespace nr_feeder_depth {
using Microsoft::WRL::ComPtr;
struct Copy {
    ComPtr<ID3D12Resource> sampled;
    ComPtr<ID3D12DescriptorHeap> heap;
    ComPtr<ID3D12RootSignature> root;
    ComPtr<ID3D12PipelineState> pipeline;
    UINT width=0,height=0,stride=0;bool ready=false;
    D3D12_RESOURCE_DESC source_desc{};ID3D12Resource *output_identity=nullptr;
    static constexpr char shader[]=R"hlsl(
cbuffer Extent : register(b0) { uint width; uint height; }
Texture2D<float> original_depth : register(t0);
RWTexture2D<float> shared_depth : register(u0);
[numthreads(8,8,1)] void Main(uint3 i:SV_DispatchThreadID) {
    if(i.x<width&&i.y<height) shared_depth[i.xy]=original_depth.Load(int3(i.xy,0));
}
)hlsl";
    static bool Formats(DXGI_FORMAT format,DXGI_FORMAT &storage,DXGI_FORMAT &srv) {
        storage=srv=DXGI_FORMAT_UNKNOWN;
        if(format==DXGI_FORMAT_D24_UNORM_S8_UINT||format==DXGI_FORMAT_R24G8_TYPELESS){storage=DXGI_FORMAT_R24G8_TYPELESS;srv=DXGI_FORMAT_R24_UNORM_X8_TYPELESS;}
        else if(format==DXGI_FORMAT_D32_FLOAT||format==DXGI_FORMAT_R32_TYPELESS){storage=DXGI_FORMAT_R32_TYPELESS;srv=DXGI_FORMAT_R32_FLOAT;}
        else if(format==DXGI_FORMAT_D16_UNORM||format==DXGI_FORMAT_R16_TYPELESS){storage=DXGI_FORMAT_R16_TYPELESS;srv=DXGI_FORMAT_R16_UNORM;}
        return storage!=DXGI_FORMAT_UNKNOWN;
    }
    static bool Supported(const D3D12_RESOURCE_DESC &desc) {
        DXGI_FORMAT storage,srv;
        return desc.Dimension==D3D12_RESOURCE_DIMENSION_TEXTURE2D&&desc.Width>0&&desc.Width<=UINT_MAX&&desc.Height>0&&
            desc.DepthOrArraySize==1&&desc.MipLevels==1&&desc.SampleDesc.Count==1&&desc.SampleDesc.Quality==0&&Formats(desc.Format,storage,srv);
    }
    static bool SameSource(const D3D12_RESOURCE_DESC &a,const D3D12_RESOURCE_DESC &b) {
        return a.Dimension==b.Dimension&&a.Alignment==b.Alignment&&a.Width==b.Width&&a.Height==b.Height&&a.DepthOrArraySize==b.DepthOrArraySize&&
            a.MipLevels==b.MipLevels&&a.Format==b.Format&&a.SampleDesc.Count==b.SampleDesc.Count&&a.SampleDesc.Quality==b.SampleDesc.Quality&&a.Layout==b.Layout&&a.Flags==b.Flags;
    }
    bool Matches(const D3D12_RESOURCE_DESC &desc,ID3D12Resource *output) const {
        return ready&&sampled&&heap&&root&&pipeline&&output_identity==output&&Supported(desc)&&SameSource(source_desc,desc);
    }
    void Release(){ready=false;sampled.Reset();heap.Reset();root.Reset();pipeline.Reset();width=height=stride=0;source_desc={};output_identity=nullptr;}
    bool Prepare(ID3D12Device *device,ID3D12Resource *source,ID3D12Resource *output) {
        const auto desc=source->GetDesc(),target=output->GetDesc();
        if(!Supported(desc)||target.Dimension!=D3D12_RESOURCE_DIMENSION_TEXTURE2D||target.Width!=desc.Width||target.Height!=desc.Height||
            target.DepthOrArraySize!=1||target.MipLevels!=1||target.SampleDesc.Count!=1||target.SampleDesc.Quality!=0||
            target.Format!=DXGI_FORMAT_R32_FLOAT||!(target.Flags&D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS)){Release();return false;}
        if(Matches(desc,output))return true;
        Release();const auto failed=[this](){Release();return false;};width=static_cast<UINT>(desc.Width);height=desc.Height;
        DXGI_FORMAT storage=DXGI_FORMAT_UNKNOWN,srv_format=DXGI_FORMAT_UNKNOWN;
        if(!Formats(desc.Format,storage,srv_format))return failed();
        auto own=desc;own.Format=storage;own.Flags=D3D12_RESOURCE_FLAG_NONE;D3D12_HEAP_PROPERTIES props{};props.Type=D3D12_HEAP_TYPE_DEFAULT;
        if(FAILED(device->CreateCommittedResource(&props,D3D12_HEAP_FLAG_NONE,&own,D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE,nullptr,IID_PPV_ARGS(&sampled))))return failed();
        D3D12_DESCRIPTOR_HEAP_DESC hd{D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV,2,D3D12_DESCRIPTOR_HEAP_FLAG_SHADER_VISIBLE,0};
        if(FAILED(device->CreateDescriptorHeap(&hd,IID_PPV_ARGS(&heap))))return failed();stride=device->GetDescriptorHandleIncrementSize(hd.Type);
        auto cpu=heap->GetCPUDescriptorHandleForHeapStart();D3D12_SHADER_RESOURCE_VIEW_DESC sv{};sv.Format=srv_format;sv.ViewDimension=D3D12_SRV_DIMENSION_TEXTURE2D;sv.Shader4ComponentMapping=D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;sv.Texture2D.MipLevels=1;
        device->CreateShaderResourceView(sampled.Get(),&sv,cpu);cpu.ptr+=stride;
        D3D12_UNORDERED_ACCESS_VIEW_DESC uv{};uv.Format=DXGI_FORMAT_R32_FLOAT;uv.ViewDimension=D3D12_UAV_DIMENSION_TEXTURE2D;device->CreateUnorderedAccessView(output,nullptr,&uv,cpu);
        D3D12_DESCRIPTOR_RANGE ranges[]={{D3D12_DESCRIPTOR_RANGE_TYPE_SRV,1,0,0,0},{D3D12_DESCRIPTOR_RANGE_TYPE_UAV,1,0,0,0}};
        D3D12_ROOT_PARAMETER params[3]{};params[0].ParameterType=D3D12_ROOT_PARAMETER_TYPE_32BIT_CONSTANTS;params[0].Constants={0,0,2};params[1].ParameterType=params[2].ParameterType=D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE;params[1].DescriptorTable={1,&ranges[0]};params[2].DescriptorTable={1,&ranges[1]};
        D3D12_ROOT_SIGNATURE_DESC signature{3,params,0,nullptr,D3D12_ROOT_SIGNATURE_FLAG_NONE};ComPtr<ID3DBlob> blob,error;
        HMODULE d3d=LoadLibraryExW(L"d3d12.dll",nullptr,LOAD_LIBRARY_SEARCH_SYSTEM32);auto serialize=d3d?reinterpret_cast<decltype(&D3D12SerializeRootSignature)>(GetProcAddress(d3d,"D3D12SerializeRootSignature")):nullptr;
        HRESULT hr=serialize?serialize(&signature,D3D_ROOT_SIGNATURE_VERSION_1,&blob,&error):E_NOINTERFACE;
        if(SUCCEEDED(hr))hr=device->CreateRootSignature(0,blob->GetBufferPointer(),blob->GetBufferSize(),IID_PPV_ARGS(&root));blob.Reset();error.Reset();if(d3d)FreeLibrary(d3d);if(FAILED(hr))return failed();
        static HMODULE compiler=LoadLibraryExW(L"d3dcompiler_47.dll",nullptr,LOAD_LIBRARY_SEARCH_SYSTEM32);
        auto compile=compiler?reinterpret_cast<decltype(&D3DCompile)>(GetProcAddress(compiler,"D3DCompile")):nullptr;
        hr=compile?compile(shader,sizeof(shader)-1,"nr-depth-copy",nullptr,nullptr,"Main","cs_5_0",D3DCOMPILE_ENABLE_STRICTNESS,0,&blob,&error):E_NOINTERFACE;
        if(FAILED(hr))return failed();D3D12_COMPUTE_PIPELINE_STATE_DESC pso{};pso.pRootSignature=root.Get();pso.CS={blob->GetBufferPointer(),blob->GetBufferSize()};
        if(FAILED(device->CreateComputePipelineState(&pso,IID_PPV_ARGS(&pipeline))))return failed();
        source_desc=desc;output_identity=output;ready=true;return true;
    }
    static void Transition(ID3D12GraphicsCommandList *list,ID3D12Resource *resource,D3D12_RESOURCE_STATES from,D3D12_RESOURCE_STATES to){D3D12_RESOURCE_BARRIER b{};b.Type=D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;b.Transition={resource,D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES,from,to};list->ResourceBarrier(1,&b);}
    bool Record(ID3D12GraphicsCommandList *list,ID3D12Resource *source,ID3D12Resource *output) {
        if(!Matches(source->GetDesc(),output))return false;
        Transition(list,source,D3D12_RESOURCE_STATE_COMMON,D3D12_RESOURCE_STATE_COPY_SOURCE);
        Transition(list,sampled.Get(),D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE,D3D12_RESOURCE_STATE_COPY_DEST);list->CopyResource(sampled.Get(),source);
        Transition(list,sampled.Get(),D3D12_RESOURCE_STATE_COPY_DEST,D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
        Transition(list,source,D3D12_RESOURCE_STATE_COPY_SOURCE,D3D12_RESOURCE_STATE_COMMON);
        Transition(list,output,D3D12_RESOURCE_STATE_COMMON,D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
        ID3D12DescriptorHeap *heaps[]={heap.Get()};list->SetDescriptorHeaps(1,heaps);list->SetComputeRootSignature(root.Get());list->SetPipelineState(pipeline.Get());
        UINT extent[]={width,height};list->SetComputeRoot32BitConstants(0,2,extent,0);auto gpu=heap->GetGPUDescriptorHandleForHeapStart();list->SetComputeRootDescriptorTable(1,gpu);gpu.ptr+=stride;list->SetComputeRootDescriptorTable(2,gpu);list->Dispatch((width+7)/8,(height+7)/8,1);
        Transition(list,output,D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_STATE_COMMON);
        return true;
    }
};
}
