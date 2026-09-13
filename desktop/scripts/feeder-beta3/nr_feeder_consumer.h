#pragma once
#include <windows.h>
#include <d3d12.h>
#include "nr_external_provider_producer.h"
#include "nr_external_provider_feeder_map.h"
#include "nr_external_provider_completion.h"
#include "nr_external_provider_vk_color.h"

// The only neural consumer in this build is this project's ExternalProvider V1
// Core. NGX initialization supplies allocation exports, never a Feature1 owner.
namespace nr_feeder {
inline std::uint64_t epoch = 1, frame_sequence = 0;
inline bool declined = false, recorded = false, quarantined = false, touched = false;
inline nr_external_provider_vk_color::Adapter color_adapter;
inline ID3D12Resource *packed_input = nullptr;
inline D3D12_PLACED_SUBRESOURCE_FOOTPRINT packed_footprint{};
inline char reason[160] = "starting";
inline ULONGLONG next_report = 0;
inline bool NormalizePrivateDevice(ID3D12Device *&device) {
    // Source-pinned ReShade 6.8 unwrapping contract. A private queue/list must
    // live entirely in one COM domain so Core sees the actual Execute queue.
    constexpr GUID unwrap = {0x7f2c9a11,0x3b4e,0x4d6a,{0x81,0x2f,0x5e,0x9c,0xd3,0x7a,0x1b,0x42}};
    if (!device) return false;
    const LUID expected = device->GetAdapterLuid();
    ID3D12Device *native = nullptr;
    HRESULT hr = device->QueryInterface(unwrap, reinterpret_cast<void **>(&native));
    if (hr == E_NOINTERFACE) return true;
    if (FAILED(hr) || !native) return false;
    const LUID actual = native->GetAdapterLuid();
    if (expected.HighPart != actual.HighPart || expected.LowPart != actual.LowPart) { native->Release(); return false; }
    IUnknown *identity = nullptr; hr = native->QueryInterface(IID_PPV_ARGS(&identity));
    if (identity) identity->Release();
    if (FAILED(hr) || !identity) { native->Release(); return false; }
    ID3D12Device *proxy = device; device = native; proxy->Release(); return true;
}
inline void Reset() {
    ++epoch; declined = false; recorded = false;
    nr_external_provider_client::Release();
    if (!quarantined) {
        color_adapter.Release();
        nr_external_provider_vk_color::Drop(packed_input);
    }
}
inline bool Claim() {
    return !quarantined && nr_external_provider_client::Claim(kNrExternalProviderIdDl5f);
}
inline void Transition(ID3D12GraphicsCommandList *list, ID3D12Resource *resource,
                       D3D12_RESOURCE_STATES before, D3D12_RESOURCE_STATES after) {
    if (!resource || before == after) return;
    D3D12_RESOURCE_BARRIER b{}; b.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    b.Transition = {resource, D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES, before, after};
    list->ResourceBarrier(1, &b);
}
inline bool PrepareColor(ID3D12Device *device, ID3D12Resource *color, UINT width, UINT height,
                         nr_external_provider_vk_color::Layout layout) {
    if (packed_input && color_adapter.width == width && color_adapter.height == height && color_adapter.layout == layout) return true;
    if (!device) return false;
    color_adapter.Release(); nr_external_provider_vk_color::Drop(packed_input);
    const auto desc = color->GetDesc(); UINT64 bytes = 0;
    device->GetCopyableFootprints(&desc, 0, 1, 0, &packed_footprint, nullptr, nullptr, &bytes);
    D3D12_RESOURCE_DESC buffer{}; buffer.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    buffer.Width = bytes; buffer.Height = buffer.DepthOrArraySize = buffer.MipLevels = 1;
    buffer.SampleDesc.Count = 1; buffer.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    D3D12_HEAP_PROPERTIES props{}; props.Type = D3D12_HEAP_TYPE_DEFAULT;
    bool ok = SUCCEEDED(device->CreateCommittedResource(&props, D3D12_HEAP_FLAG_NONE, &buffer,
        D3D12_RESOURCE_STATE_COMMON, nullptr, IID_PPV_ARGS(&packed_input))) &&
        color_adapter.Prepare(device, width, height, packed_footprint.Footprint.RowPitch,
            packed_footprint.Footprint.RowPitch, layout);
    return ok;
}
inline bool Record(ID3D12Device *device, ID3D12GraphicsCommandList *list, ID3D12CommandQueue *queue,
                   ID3D12Fence *fence, UINT64 fence_value,
                   ID3D12Resource *color, ID3D12Resource *output,
                   ID3D12Resource *depth, ID3D12Resource *motion,
                   UINT width, UINT height, float motion_x, float motion_y,
                   bool reset, bool inverted, bool hdr,
                   D3D12_RESOURCE_STATES input_state,
                   D3D12_RESOURCE_STATES output_state) {
    declined = true; recorded = false; touched = false;
    if (!list || !queue || !fence || !color || !output || !depth || !motion || !width || !height || !Claim()) {
        strcpy_s(reason, "project Core owner unavailable"); return false;
    }
    const auto c = color->GetDesc(), o = output->GetDesc(), d = depth->GetDesc(), m = motion->GetDesc();
    if (c.Width != width || c.Height != height || o.Width != width || o.Height != height ||
        d.Width != width || d.Height != height || m.Width != width || m.Height != height ||
        c.SampleDesc.Count != 1 || o.SampleDesc.Count != 1 || d.SampleDesc.Count != 1 || m.SampleDesc.Count != 1) {
        strcpy_s(reason, "input extent/sample contract mismatch"); return false;
    }
    nr_external_provider_feeder::FeedInputs in{};
    in.command_list = reinterpret_cast<std::uint64_t>(list);
    in.color = reinterpret_cast<std::uint64_t>(color); in.output = reinterpret_cast<std::uint64_t>(output);
    in.depth = reinterpret_cast<std::uint64_t>(depth); in.motion = reinterpret_cast<std::uint64_t>(motion);
    in.width = width; in.height = height;
    in.color_format = c.Format; in.depth_format = d.Format; in.motion_format = m.Format;
    in.color_state = in.depth_state = in.motion_state = input_state;
    in.output_state = output_state; in.mv_scale_x = motion_x; in.mv_scale_y = motion_y;
    in.pre_exposure = in.exposure_scale = 1.0f; in.reset = reset; in.depth_inverted = inverted; in.hdr_color = hdr;
    in.view_id = 1; in.epoch = epoch; in.frame_id = ++frame_sequence;
    in.provider_id = kNrExternalProviderIdDl5f;
    in.queue = reinterpret_cast<std::uint64_t>(queue); in.fence = reinterpret_cast<std::uint64_t>(fence); in.fence_value = fence_value;
    const auto layout = nr_external_provider_vk_color::Classify(c.Format,
        hdr ? reshade::api::color_space::unknown : reshade::api::color_space::srgb_nonlinear);
    const bool adapt = layout != nr_external_provider_vk_color::Layout::Unsupported;
    if (!adapt) { strcpy_s(reason, "only confirmed packed SDR color is admitted"); return false; }
    if (adapt) {
        if (nr_external_provider_vk_color::Classify(o.Format, reshade::api::color_space::srgb_nonlinear) != layout ||
            !PrepareColor(device, color, width, height, layout)) {
            strcpy_s(reason, "SDR color adapter unavailable"); return false;
        }
        touched = true;
        Transition(list, color, input_state, D3D12_RESOURCE_STATE_COPY_SOURCE);
        Transition(list, packed_input, D3D12_RESOURCE_STATE_COMMON, D3D12_RESOURCE_STATE_COPY_DEST);
        D3D12_TEXTURE_COPY_LOCATION source{}; source.pResource = color; source.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
        D3D12_TEXTURE_COPY_LOCATION target{}; target.pResource = packed_input; target.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
        target.PlacedFootprint = packed_footprint;
        list->CopyTextureRegion(&target, 0, 0, 0, &source, nullptr);
        Transition(list, packed_input, D3D12_RESOURCE_STATE_COPY_DEST, D3D12_RESOURCE_STATE_COMMON);
        Transition(list, color, D3D12_RESOURCE_STATE_COPY_SOURCE, input_state);
        color_adapter.Decode(list, packed_input);
        in.color = reinterpret_cast<std::uint64_t>(color_adapter.input);
        in.output = reinterpret_cast<std::uint64_t>(color_adapter.output);
        in.color_format = DXGI_FORMAT_R16G16B16A16_FLOAT;
        in.color_state = D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE;
        in.output_state = D3D12_RESOURCE_STATE_UNORDERED_ACCESS;
        in.hdr_color = true; // Adapter supplies linear FP16; packed SDR bytes never reach Core.
    }
    NrExternalFrameV1 frame{}; NrExternalSubmitResultV1 result{};
    if (!nr_external_provider_feeder::BuildSyntheticFrame(in, frame)) {
        strcpy_s(reason, "invalid synthetic frame"); return false;
    }
    frame.output.format = adapt ? DXGI_FORMAT_R16G16B16A16_FLOAT : o.Format;
    touched = true;
    recorded = nr_external_provider_client::Submit(frame, result) && result.writeback_performed;
    if (adapt) {
        if (recorded) {
            Transition(list, color_adapter.output, D3D12_RESOURCE_STATE_UNORDERED_ACCESS, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
            color_adapter.Bind(list, packed_input, color_adapter.encode);
            list->Dispatch((width + 7) / 8, (height + 7) / 8, 1);
            Transition(list, color_adapter.packed, D3D12_RESOURCE_STATE_UNORDERED_ACCESS, D3D12_RESOURCE_STATE_COPY_SOURCE);
            Transition(list, output, output_state, D3D12_RESOURCE_STATE_COPY_DEST);
            D3D12_TEXTURE_COPY_LOCATION source{}; source.pResource = color_adapter.packed;
            source.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT; source.PlacedFootprint = packed_footprint;
            source.PlacedFootprint.Footprint.Format = o.Format;
            D3D12_TEXTURE_COPY_LOCATION target{}; target.pResource = output; target.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
            list->CopyTextureRegion(&target, 0, 0, 0, &source, nullptr);
            Transition(list, output, D3D12_RESOURCE_STATE_COPY_DEST, output_state);
            Transition(list, color_adapter.packed, D3D12_RESOURCE_STATE_COPY_SOURCE, D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
            Transition(list, color_adapter.output, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE, D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
        }
        Transition(list, packed_input, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE, D3D12_RESOURCE_STATE_COMMON);
    }
    declined = !recorded;
    strncpy_s(reason, recorded ? "recorded" : result.bypass[0] ? result.bypass : "Core declined; original frame retained", _TRUNCATE);
    return recorded;
}
inline bool Complete(ID3D12Fence *fence, HANDLE event, UINT64 value, DWORD timeout = 2000) {
    const auto result = nr_external_provider_completion::Wait(fence, event, value, timeout);
    if (result == nr_external_provider_completion::Result::Complete) return true;
    quarantined = true; strcpy_s(reason, "GPU completion unconfirmed; resources quarantined"); return false;
}
}
