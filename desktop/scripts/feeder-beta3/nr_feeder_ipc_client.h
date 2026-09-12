#pragma once
#include <windows.h>
#include <d3d12.h>
#include <wrl/client.h>
#include <string>
#include <vector>
#include <cstring>
#include <new>
#include "feed_ipc.h"

namespace nr_feeder_ipc {
struct Client {
    HANDLE pipe=INVALID_HANDLE_VALUE,process=nullptr,event=nullptr;
    Microsoft::WRL::ComPtr<ID3D12Fence> input_fence,output_fence;
    DWORD host_pid=0;UINT64 frame=0;bool lost=false,nr_seen=false,fence_pending=false;const char* reason="not connected";
    bool Transfer(bool write,void *data,DWORD size,DWORD timeout) {
        if(pipe==INVALID_HANDLE_VALUE||lost)return false;
        DWORD offset=0;auto *bytes=static_cast<unsigned char*>(data);const auto deadline=GetTickCount64()+timeout;
        struct Operation{OVERLAPPED ov{};std::vector<BYTE> buffer;~Operation(){if(ov.hEvent)CloseHandle(ov.hEvent);}};
        while(offset<size){auto *op=new(std::nothrow) Operation;if(!op)return false;op->buffer.resize(size-offset);op->ov.hEvent=CreateEventW(nullptr,TRUE,FALSE,nullptr);if(!op->ov.hEvent){delete op;return false;}DWORD done=0;
            if(write)std::memcpy(op->buffer.data(),bytes+offset,op->buffer.size());
            BOOL started=write?WriteFile(pipe,op->buffer.data(),static_cast<DWORD>(op->buffer.size()),nullptr,&op->ov):ReadFile(pipe,op->buffer.data(),static_cast<DWORD>(op->buffer.size()),nullptr,&op->ov);
            if(!started&&GetLastError()!=ERROR_IO_PENDING){delete op;return false;}
            auto now=GetTickCount64();DWORD remaining=now<deadline?static_cast<DWORD>(deadline-now):0;
            if(WaitForSingleObject(op->ov.hEvent,remaining)!=WAIT_OBJECT_0){CancelIoEx(pipe,&op->ov);lost=true;reason="bounded IPC wait expired";
                // An unconfirmed cancellation retains both OVERLAPPED and its
                // buffer until process exit; no stack storage can outlive IO.
                if(WaitForSingleObject(op->ov.hEvent,1000)==WAIT_OBJECT_0)delete op;
                return false;
            }
            if(!GetOverlappedResult(pipe,&op->ov,&done,FALSE)||!done||done>op->buffer.size()){delete op;return false;}
            if(!write)std::memcpy(bytes+offset,op->buffer.data(),done);offset+=done;delete op;
        }
        return true;
    }
    bool Connect(const std::wstring &host_directory,const LUID &luid) {
        if(pipe!=INVALID_HANDLE_VALUE)return !lost;
        std::wstring exe=host_directory+L"\\dlss5-feed-host64.exe";
        wchar_t suffix[160]{};swprintf_s(suffix,L"\" %lu --hide --luid=%08lX:%08lX",GetCurrentProcessId(),luid.HighPart,luid.LowPart);
        std::wstring command=L"\""+exe+suffix;STARTUPINFOW startup{sizeof(startup)};PROCESS_INFORMATION created{};
        if(!CreateProcessW(exe.c_str(),command.data(),nullptr,nullptr,FALSE,CREATE_NO_WINDOW,nullptr,host_directory.c_str(),&startup,&created)){reason="managed host could not start";return false;}
        process=created.hProcess;host_pid=created.dwProcessId;CloseHandle(created.hThread);
        wchar_t pipe_name[100]{};swprintf_s(pipe_name,L"\\\\.\\pipe\\dlss5-feed.%lu",GetCurrentProcessId());
        const auto deadline=GetTickCount64()+15000;
        while(GetTickCount64()<deadline){
            pipe=CreateFileW(pipe_name,GENERIC_READ|GENERIC_WRITE,0,nullptr,OPEN_EXISTING,FILE_FLAG_OVERLAPPED,nullptr);
            if(pipe!=INVALID_HANDLE_VALUE)break;
            if(WaitForSingleObject(process,0)==WAIT_OBJECT_0){reason="host exited before handshake";return false;}
            Sleep(20);
        }
        if(pipe==INVALID_HANDLE_VALUE){reason="host handshake pipe unavailable";return false;}
        event=CreateEventW(nullptr,TRUE,FALSE,nullptr);if(!event)return false;
        HANDLE self=nullptr;if(!DuplicateHandle(GetCurrentProcess(),GetCurrentProcess(),process,&self,PROCESS_DUP_HANDLE|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,0))return false;
        FeedHello hello{FEED_IPC_MAGIC,FEED_IPC_VERSION,GetCurrentProcessId(),FEED_CLIENT_D3D11,reinterpret_cast<UINT64>(self)};FeedHelloAck ack{};
        if(!Transfer(true,&hello,sizeof(hello),15000)||!Transfer(false,&ack,sizeof(ack),15000)||ack.magic!=FEED_IPC_MAGIC||ack.version!=FEED_IPC_VERSION){reason="host protocol mismatch";lost=true;return false;}
        reason="connected";return true;
    }
    bool Build(ID3D12Device *device,UINT width,UINT height,DXGI_FORMAT format,const HANDLE (&textures)[FEED_SLOTS]) {
        FeedBuild build{};build.actual_sdr=1;build.width=width;build.height=height;build.color_fmt=build.output_fmt=format;
        build.hdr=0;build.depth_inverted=0;build.flags_override=-1;build.mv_scale_x=build.mv_scale_y=1;
        build.client_flags=FEED_BUILD_NR_HOST_GUIDES|FEED_BUILD_OUTPUT_NO_UAV;
        for(int n=0;n<FEED_SLOTS;++n)build.tex[n]=reinterpret_cast<UINT64>(textures[n]);
        BYTE tag='B';FeedBuildAck ack{};
        if(!Transfer(true,&tag,1,15000)||!Transfer(true,&build,sizeof(build),15000)||!Transfer(false,&ack,sizeof(ack),15000)||ack.ok!=1||ack.flags&FEED_ACK_SR_ACTIVE){reason="host resource build rejected";return false;}
        auto open=[&](UINT64 remote,Microsoft::WRL::ComPtr<ID3D12Fence>&f){HANDLE handle=reinterpret_cast<HANDLE>(static_cast<uintptr_t>(remote));f.Reset();if(!handle)return false;HRESULT hr=device->OpenSharedHandle(handle,IID_PPV_ARGS(&f));CloseHandle(handle);return SUCCEEDED(hr);};
        // These handles are duplicated once for the whole host session. A resize
        // repeats their numeric values after the first copies were consumed.
        if((!input_fence&&!open(ack.fence_in,input_fence))||(!output_fence&&!open(ack.fence_out,output_fence))){reason="host fences unavailable";return false;}
        if(ack.output_fmt!=static_cast<UINT>(format)){reason="host output layout changed";return false;}
        reason="shared set ready";return true;
    }
    bool Submit(ID3D12CommandQueue *queue,bool reset,FeedFrameResult &result) {
        if(lost||!input_fence||!output_fence)return false;
        const UINT64 n=++frame;if(FAILED(queue->Signal(input_fence.Get(),n))){lost=true;reason="input fence signal failed";return false;}
        BYTE tag='F';FeedFrameMsg message{n,reset?1u:0u,0,0};
        bool ok=Transfer(true,&tag,1,4000)&&Transfer(true,&message,sizeof(message),4000)&&Transfer(false,&result,sizeof(result),nr_seen?4000:15000);
        if(!ok||result.magic!=FEED_IPC_MAGIC||result.frame!=n||result.output_ready!=1){lost=true;reason="same-frame host completion absent";return false;}
        UINT64 completed=output_fence->GetCompletedValue();
        if(completed==UINT64_MAX){lost=true;reason="host output device removed";return false;}
        if(completed<n){ResetEvent(event);if(FAILED(output_fence->SetEventOnCompletion(n,event))){lost=true;return false;}fence_pending=true;
            if(WaitForSingleObject(event,2000)!=WAIT_OBJECT_0){lost=true;reason="host output fence unconfirmed";return false;}
            fence_pending=false;completed=output_fence->GetCompletedValue();
            if(completed==UINT64_MAX||completed<n){lost=true;reason="host output fence invalid";return false;}
        }
        if(FAILED(queue->Wait(output_fence.Get(),n))){lost=true;reason="output queue wait failed";return false;}
        nr_seen|=result.nr_completed!=0;
        reason=result.nr_completed?"NR completed":"same-frame identity retained";return true;
    }
    void Close() {
        if(pipe!=INVALID_HANDLE_VALUE){CancelIoEx(pipe,nullptr);CloseHandle(pipe);pipe=INVALID_HANDLE_VALUE;}
        if(event){if(!fence_pending)CloseHandle(event);event=nullptr;}
        if(process){WaitForSingleObject(process,2000);CloseHandle(process);process=nullptr;}
        input_fence.Reset();if(fence_pending)output_fence.Detach();else output_fence.Reset();
    }
};
}
