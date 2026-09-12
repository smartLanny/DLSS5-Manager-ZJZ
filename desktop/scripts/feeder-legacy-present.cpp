// Controlled D3D10.0 / D3D11 renderer. Neural work comes only from installed
// ReShade callbacks; this fixture never calls Claim, Submit, Create or Evaluate.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <dxgi.h>
#include <d3dcompiler.h>
#include <wrl/client.h>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <fstream>
#include <string>
#include <vector>
#ifdef FEED_D3D10
#include <d3d10.h>
#define API(name) D3D10_##name
using Device=ID3D10Device; using Texture=ID3D10Texture2D; using View=ID3D10RenderTargetView;
using DepthView=ID3D10DepthStencilView; using Buffer=ID3D10Buffer;
using VS=ID3D10VertexShader; using PS=ID3D10PixelShader;
using Raster=ID3D10RasterizerState; using DepthState=ID3D10DepthStencilState; using Blend=ID3D10BlendState;
#else
#include <d3d11.h>
#define API(name) D3D11_##name
using Device=ID3D11Device; using Texture=ID3D11Texture2D; using View=ID3D11RenderTargetView;
using DepthView=ID3D11DepthStencilView; using Buffer=ID3D11Buffer;
using VS=ID3D11VertexShader; using PS=ID3D11PixelShader;
using Raster=ID3D11RasterizerState; using DepthState=ID3D11DepthStencilState; using Blend=ID3D11BlendState;
#endif
using Microsoft::WRL::ComPtr;
static void need(bool ok,const char* message) { if (!ok) { std::fprintf(stderr,"legacy fixture failed: %s\n",message); ExitProcess(12); } }
static void check(HRESULT h,const char* message) { if (FAILED(h)) { std::fprintf(stderr,"0x%08lX ",h); need(false,message); } }
static LRESULT CALLBACK wnd(HWND w,UINT m,WPARAM p,LPARAM l) { if(m==WM_DESTROY){PostQuitMessage(0);return 0;} return DefWindowProcW(w,m,p,l); }
static const char shader[]=R"hlsl(
cbuffer Draw : register(b0) { float4 transform; float4 tint; }
struct Vertex { float4 position:SV_Position; float2 uv:TEXCOORD0; };
Vertex VSMain(uint id:SV_VertexID) {
    float2 p[6]={float2(-1,-1),float2(1,-1),float2(-1,1),float2(-1,1),float2(1,-1),float2(1,1)};
    Vertex v;v.position=float4(p[id]*transform.z+transform.xy,transform.w,1);v.uv=p[id]*0.5+0.5;return v;
}
float4 PSMain(Vertex v):SV_Target { float grid=fmod(floor(v.uv.x*32)+floor(v.uv.y*18),2); return float4(tint.rgb*(0.55+0.45*grid),tint.a); }
)hlsl";
struct Sample { unsigned frame,changed,alpha; std::uint64_t before,after; UINT width,height; };
static std::uint64_t hash(const std::vector<unsigned char>& v) { std::uint64_t h=1469598103934665603ull;for(auto x:v)h=(h^x)*1099511628211ull;return h; }
struct Renderer {
    UINT width=640,height=360; HWND window{}; ComPtr<Device> device;
#ifndef FEED_D3D10
    ComPtr<ID3D11DeviceContext> context;
#endif
    ComPtr<IDXGISwapChain> swap; ComPtr<Texture> color,depth,readback; ComPtr<View> rtv; ComPtr<DepthView> dsv;
    ComPtr<Buffer> cb; ComPtr<VS> vs; ComPtr<PS> ps; std::vector<Sample> samples;
    ComPtr<Raster> raster_state; ComPtr<DepthState> depth_state; ComPtr<Blend> blend_state;
    auto* ctx() {
#ifdef FEED_D3D10
        return device.Get();
#else
        return context.Get();
#endif
    }
    void targets() {
        check(swap->GetBuffer(0,IID_PPV_ARGS(&color)),"backbuffer"); check(device->CreateRenderTargetView(color.Get(),nullptr,&rtv),"rtv");
        API(TEXTURE2D_DESC) td{};td.Width=width;td.Height=height;td.MipLevels=1;td.ArraySize=1;td.Format=DXGI_FORMAT_D32_FLOAT;
        td.SampleDesc.Count=1;td.BindFlags=API(BIND_DEPTH_STENCIL); check(device->CreateTexture2D(&td,nullptr,&depth),"depth");
        check(device->CreateDepthStencilView(depth.Get(),nullptr,&dsv),"dsv");
        td.Format=DXGI_FORMAT_R8G8B8A8_UNORM;td.BindFlags=0;td.Usage=API(USAGE_STAGING);td.CPUAccessFlags=API(CPU_ACCESS_READ);
        check(device->CreateTexture2D(&td,nullptr,&readback),"staging");
    }
    void init(HWND w) {
        window=w;ComPtr<IDXGIFactory> factory;check(CreateDXGIFactory(IID_PPV_ARGS(&factory)),"factory");ComPtr<IDXGIAdapter> adapter;
        for(UINT n=0;;++n){ComPtr<IDXGIAdapter> candidate;if(factory->EnumAdapters(n,&candidate)==DXGI_ERROR_NOT_FOUND)break;
            DXGI_ADAPTER_DESC d{};candidate->GetDesc(&d);if(d.VendorId==0x10DE){adapter=candidate;break;}}
        need(adapter!=nullptr,"NVIDIA adapter");
        DXGI_SWAP_CHAIN_DESC sd{};sd.BufferDesc.Width=width;sd.BufferDesc.Height=height;sd.BufferDesc.Format=DXGI_FORMAT_R8G8B8A8_UNORM;
        sd.SampleDesc.Count=1;sd.BufferUsage=DXGI_USAGE_RENDER_TARGET_OUTPUT;sd.BufferCount=1;sd.OutputWindow=w;sd.Windowed=TRUE;sd.SwapEffect=DXGI_SWAP_EFFECT_DISCARD;
#ifdef FEED_D3D10
        check(D3D10CreateDeviceAndSwapChain(adapter.Get(),D3D10_DRIVER_TYPE_HARDWARE,nullptr,0,D3D10_SDK_VERSION,&sd,&swap,&device),"create pure D3D10.0");
#else
        D3D_FEATURE_LEVEL fl{};const D3D_FEATURE_LEVEL requested[]={D3D_FEATURE_LEVEL_11_0};
        check(D3D11CreateDeviceAndSwapChain(adapter.Get(),D3D_DRIVER_TYPE_UNKNOWN,nullptr,0,requested,1,D3D11_SDK_VERSION,&sd,&swap,&device,&fl,&context),"create D3D11");
#endif
        targets();ComPtr<ID3DBlob> v,p,error;check(D3DCompile(shader,sizeof(shader)-1,"fixture",nullptr,nullptr,"VSMain","vs_4_0",0,0,&v,&error),"compile VS4");
        API(RASTERIZER_DESC) raster{};raster.FillMode=API(FILL_SOLID);raster.CullMode=API(CULL_NONE);raster.DepthClipEnable=TRUE;
        check(device->CreateRasterizerState(&raster,&raster_state),"raster");ctx()->RSSetState(raster_state.Get());
        API(DEPTH_STENCIL_DESC) depth_desc{};depth_desc.DepthEnable=TRUE;depth_desc.DepthWriteMask=API(DEPTH_WRITE_MASK_ALL);depth_desc.DepthFunc=API(COMPARISON_LESS);
        check(device->CreateDepthStencilState(&depth_desc,&depth_state),"depth state");
        API(BLEND_DESC) blend{};
#ifdef FEED_D3D10
        blend.RenderTargetWriteMask[0]=0xf;
#else
        blend.RenderTarget[0].RenderTargetWriteMask=0xf;
#endif
        check(device->CreateBlendState(&blend,&blend_state),"blend state");
        check(D3DCompile(shader,sizeof(shader)-1,"fixture",nullptr,nullptr,"PSMain","ps_4_0",0,0,&p,&error),"compile PS4");
#ifdef FEED_D3D10
        check(device->CreateVertexShader(v->GetBufferPointer(),v->GetBufferSize(),&vs),"VS");check(device->CreatePixelShader(p->GetBufferPointer(),p->GetBufferSize(),&ps),"PS");
#else
        check(device->CreateVertexShader(v->GetBufferPointer(),v->GetBufferSize(),nullptr,&vs),"VS");check(device->CreatePixelShader(p->GetBufferPointer(),p->GetBufferSize(),nullptr,&ps),"PS");
#endif
        API(BUFFER_DESC) bd{};bd.ByteWidth=32;bd.Usage=API(USAGE_DEFAULT);bd.BindFlags=API(BIND_CONSTANT_BUFFER);check(device->CreateBuffer(&bd,nullptr,&cb),"cb");
    }
    std::vector<unsigned char> pixels() {
        ctx()->CopyResource(readback.Get(),color.Get());
#ifdef FEED_D3D10
        D3D10_MAPPED_TEXTURE2D m{};check(readback->Map(0,D3D10_MAP_READ,0,&m),"readback map");
#else
        D3D11_MAPPED_SUBRESOURCE m{};check(context->Map(readback.Get(),0,D3D11_MAP_READ,0,&m),"readback map");
#endif
        std::vector<unsigned char> out;out.reserve(width*height*4);for(UINT y=0;y<height;++y){auto* row=static_cast<unsigned char*>(m.pData)+y*m.RowPitch;out.insert(out.end(),row,row+width*4);}
#ifdef FEED_D3D10
        readback->Unmap(0);
#else
        context->Unmap(readback.Get(),0);
#endif
        return out;
    }
    void draw(unsigned frame) {
        const float blend_factor[]={1,1,1,1};ctx()->RSSetState(raster_state.Get());ctx()->OMSetDepthStencilState(depth_state.Get(),0);ctx()->OMSetBlendState(blend_state.Get(),blend_factor,0xffffffff);
        const float clear[]={0.1f,0.2f,0.4f,0.37f};ctx()->ClearRenderTargetView(rtv.Get(),clear);ctx()->ClearDepthStencilView(dsv.Get(),API(CLEAR_DEPTH),1,0);
        View* rv=rtv.Get();ctx()->OMSetRenderTargets(1,&rv,dsv.Get());API(VIEWPORT) vp{};vp.Width=width;vp.Height=height;vp.MaxDepth=1;ctx()->RSSetViewports(1,&vp);
        ctx()->IASetPrimitiveTopology(API(PRIMITIVE_TOPOLOGY_TRIANGLELIST));
#ifdef FEED_D3D10
        ctx()->VSSetShader(vs.Get());ctx()->PSSetShader(ps.Get());
#else
        ctx()->VSSetShader(vs.Get(),nullptr,0);ctx()->PSSetShader(ps.Get(),nullptr,0);
#endif
        Buffer* constant=cb.Get();ctx()->VSSetConstantBuffers(0,1,&constant);ctx()->PSSetConstantBuffers(0,1,&constant);
        for(unsigned n=0;n<3;++n){float data[]={n==0?0.0f:std::sin(frame*0.015f+n)*0.5f,n==0?0.0f:(n==1?0.2f:-0.2f),n==0?1.0f:0.28f,n==0?0.85f:(n==1?0.45f:0.2f),n==0?0.2f:(n==1?0.8f:0.1f),n==0?0.3f:0.2f,n==0?0.7f:0.1f,0.37f};
            ctx()->UpdateSubresource(cb.Get(),0,nullptr,data,0,0);ctx()->Draw(6,0);}
        const bool sample=frame%60==0;std::vector<unsigned char> before;if(sample)before=pixels();
        check(swap->Present(1,0),"present");
        if(sample){auto after=pixels();Sample s{frame,0,0,hash(before),hash(after),width,height};for(std::size_t n=0;n<before.size();n+=4){s.changed+=before[n]!=after[n]||before[n+1]!=after[n+1]||before[n+2]!=after[n+2];s.alpha+=before[n+3]!=after[n+3];}samples.push_back(s);}
    }
    void resize() {ctx()->OMSetRenderTargets(0,nullptr,nullptr);rtv.Reset();dsv.Reset();color.Reset();depth.Reset();readback.Reset();ctx()->Flush();width=768;height=432;check(swap->ResizeBuffers(1,width,height,DXGI_FORMAT_R8G8B8A8_UNORM,0),"resize");targets();}
};
int WINAPI wWinMain(HINSTANCE instance,HINSTANCE,PWSTR,int) {
    unsigned frames=480;bool resize=false;int argc=0;auto args=CommandLineToArgvW(GetCommandLineW(),&argc);
    for(int i=1;i<argc;++i){if(std::wstring(args[i])==L"--frames"&&i+1<argc)frames=std::wcstoul(args[++i],nullptr,10);else if(std::wstring(args[i])==L"--resize")resize=true;}LocalFree(args);need(frames>=60&&frames<=1200,"bounded frames");
    WNDCLASSW wc{};wc.lpfnWndProc=wnd;wc.hInstance=instance;wc.lpszClassName=L"XiaofengFeederLegacyFixture";RegisterClassW(&wc);
    HWND window=CreateWindowW(wc.lpszClassName,L"Controlled legacy graphics fixture",WS_OVERLAPPEDWINDOW,0,0,800,600,nullptr,nullptr,instance,nullptr);need(window!=nullptr,"window");
    Renderer r;r.init(window);for(unsigned frame=1;frame<=frames;++frame){MSG m{};while(PeekMessageW(&m,nullptr,0,0,PM_REMOVE)){TranslateMessage(&m);DispatchMessageW(&m);}if(resize&&frame==frames/2+1)r.resize();r.draw(frame);Sleep(16);}
    std::ofstream out("feeder-legacy-report.json");out<<"{\"schema\":1,\"api\":\""
#ifdef FEED_D3D10
        <<"dx10"
#else
        <<"dx11"
#endif
        <<"\",\"architecture\":\""<<(sizeof(void*)==8?"x64":"x86")<<"\",\"frames\":"<<frames<<",\"resize\":"<<(resize?"true":"false")<<",\"samples\":[";
    for(std::size_t i=0;i<r.samples.size();++i){const auto&s=r.samples[i];if(i)out<<",";out<<"{\"frame\":"<<s.frame<<",\"width\":"<<s.width<<",\"height\":"<<s.height<<",\"changedRgbPixels\":"<<s.changed<<",\"changedAlphaPixels\":"<<s.alpha<<",\"inputHash\":\""<<std::hex<<s.before<<"\",\"outputHash\":\""<<s.after<<"\"}"<<std::dec;}
    out<<"],\"exit\":\"clean\",\"nrAcceptance\":\"separate-provider-and-host-completion-evidence-required\"}\n";return 0;
}
