#!/usr/bin/env python3
"""Create an isolated, source-pinned Feeder 0.15.1 build using our sole NR Core.

All transformations apply to a new stage; the upstream and interop input trees
remain unchanged. The resulting manifest records exact transformed inputs.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path

PIN = '3f624855276c4bde55145c712782477639b30e85'
HEADERS = ['nr_external_provider_abi.h', 'nr_external_provider_producer.h',
           'nr_external_provider_feeder_map.h', 'nr_external_provider_completion.h', 'nr_external_provider_vk_color.h']

def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

def once(text: str, old: str, new: str, label: str = '') -> str:
    if text.count(old) != 1:
        raise ValueError(f'Expected one {label or old[:70]!r}, found {text.count(old)}')
    return text.replace(old, new, 1)

def function(text: str, signature: str, body: str) -> str:
    start = text.index(signature)
    brace = text.index('{', start)
    # These selected definitions have no braces in string literals or comments.
    level = 1
    end = brace + 1
    while level:
        level += (text[end] == '{') - (text[end] == '}')
        end += 1
    return text[:brace] + '{\n' + body.strip() + '\n}' + text[end:]

def native(text: str) -> str:
    text = once(text, '#include "feed_ngx.h"', '#include "nr_feeder_consumer.h"\n#include "feed_ngx.h"', 'consumer include')
    for name in ('DetectRenodxAddon()', 'DetectToolkitAddon()', 'DetectChickenAddon(int warmup_rebuild)', 'DetectOptiScaler()'):
        text = function(text, 'static void ' + name, '// This package has one project Core; no other consumer is discovered or configured.')
    text = text.replace('if (!avail)', 'if (!avail && false /* Feature1 capability does not govern project Feature18 */)')
    text = once(text, 'return float4(src_color.Sample(linear_smp, i.uv).rgb, 1.0);',
                'return src_color.Sample(linear_smp, i.uv);', 'native copy-home alpha')
    text = once(text, '        Log("dlss5-feed %s (built %s %s) attached.", FEED_VERSION, __DATE__, __TIME__);',
                '        Log("dlss5-feed %s (built %s %s) attached.", FEED_VERSION, __DATE__, __TIME__);\n        Log("[nr-feeder-session] pid=%lu source=0151-external-v1", GetCurrentProcessId());', 'native session marker')
    text = function(text, 'static bool WarmupRebuildDue(UINT64 n)', '(void)n; return false; // The project Core owns temporal warmup.')
    text = function(text, 'static bool FeatureMissingForMode()', 'return false; // No private Feature1 exists in a provider-only build.')
    text = function(text, 'static void DrawOverlay(reshade::api::effect_runtime *rt)', '''
    (void)rt;
    ImGui::TextUnformatted("NR Feeder 0.15.1 - managed provider");
    ImGui::TextWrapped("Synthetic post-process input. Adjust NR in the project's Core panel. This provider does not inject super resolution or frame generation.");
    ImGui::Text("Status: %s", nr_feeder::reason);
''')
    signature = 'static bool CreateDlssFeature(UINT w, UINT h, bool inverted, bool *crashed)\n{'
    at = text.index(signature)
    text = function(text, signature, '''
    if (crashed) *crashed = false;
    if (g_cfg.work_resolution != 100 || g_cfg.work_upscale != 0 || g.sr_active) {
        FeedDisable("project NR provider requires native-size post-process input"); return false;
    }
    nr_feeder::Claim();
    g.frame_ready = true; g.need_reset = true; g.warmup_done = true;
    Log("[nr-feeder] provider-only resources ready %ux%u; private Feature1 disabled", w, h);
    return true;
''')
    text = function(text, 'static NVSDK_NGX_Result SafeEvaluateDLSS(', '''
    *code = 0;
    if (PresentColorSpace() != reshade::api::color_space::srgb_nonlinear) {
        nr_feeder::declined = true;
        strcpy_s(nr_feeder::reason, "swapchain SDR color space is unconfirmed"); return NVSDK_NGX_Result_Fail;
    }
    const bool same_device = g.rs_dev && g.rs_dev->get_api() == reshade::api::device_api::d3d12;
    const auto state = same_device
        ? D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE | D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE
        : D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE;
    const bool done = nr_feeder::Record(g.dev12, g.list, g.queue, g.fence12, g.fence_value + 1,
        ep->Feature.pInColor, ep->Feature.pInOutput, ep->pInDepth, ep->pInMotionVectors,
        ep->InRenderSubrectDimensions.Width, ep->InRenderSubrectDimensions.Height,
        ep->InMVScaleX, ep->InMVScaleY, ep->InReset != 0,
        g_cfg.depth_inverted >= 0 ? g_cfg.depth_inverted != 0 : g.depth_reversed, false, state,
        D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
    if (!done && GetTickCount64() >= nr_feeder::next_report) {
        nr_feeder::next_report = GetTickCount64() + 1000;
        Log("[nr-feeder-retained] reason=%s", nr_feeder::reason);
    }
    return done ? static_cast<NVSDK_NGX_Result>(1) : NVSDK_NGX_Result_Fail;
''')
    # A declined warmup/disabled Core is not a reason to recreate a Feature1 or
    # mark output as delivered. The existing failed branch keeps the original.
    text = text.replace('FeedFail("evaluate");', 'if (!nr_feeder::declined) FeedFail("evaluate");')
    text = text.replace('NVSDK_NGX_FAILED(re)', '(nr_feeder::quarantined || NVSDK_NGX_FAILED(re))')
    text = text.replace('g.frame_ready = false;  // rebuild rather than repeat the same failure',
                        'g.frame_ready = nr_feeder::declined; // Core warmup retains the same resources')
    text = text.replace('FeedFail("evaluate");\n                    g.frame_ready = false;',
                        'FeedFail("evaluate");\n                    g.frame_ready = nr_feeder::declined;')
    # Commit/observe each NR submission before another API copies the result.
    close = '    const UINT64 v = ++g.fence_value;'
    end_start = text.index('static UINT64 EndCommands(')
    end_stop = text.index('\n}', end_start)
    end = text[end_start:end_stop]
    if 'return v;' not in end:
        raise ValueError('native EndCommands return changed')
    end = once(end, '    return v;', '''    if (nr_feeder::touched && !nr_feeder::Complete(g.fence12, g.fence_event, v)) {
        FeedDisable(nr_feeder::reason); return 0;
    }
    if (nr_feeder::recorded && (nr_feeder::frame_sequence <= 3 || nr_feeder::frame_sequence % 30 == 0)) {
        const LUID luid = g.dev12->GetAdapterLuid();
        Log("[nr-feeder-device] pid=%lu epoch=%llu luid=%08lX:%08lX",GetCurrentProcessId(),nr_feeder::epoch,luid.HighPart,luid.LowPart);
        Log("[nr-feeder-completion] frame=%llu epoch=%llu nr_completed=1 output_recorded=1 provenance=Synthetic", nr_feeder::frame_sequence, nr_feeder::epoch);
    }
    return v;''')
    text = text[:end_start] + end + text[end_stop:]
    text = once(text, 'static void ReleaseFrameResources()\n{',
                'static void ReleaseFrameResources()\n{\n    if (nr_feeder::quarantined) return;\n    nr_feeder::Reset();', 'native resource epoch')
    text = once(text, 'static void ShutdownSession()\n{',
                'static void ShutdownSession()\n{\n    if (nr_feeder::quarantined) return;', 'quarantined session')
    text = once(text, '        if (FAILED(hr) || g.dev12 == nullptr) goto fail;',
                '        if (FAILED(hr) || g.dev12 == nullptr || !nr_feeder::NormalizePrivateDevice(g.dev12)) goto fail;', 'native private device domain')
    # Expose only NR post-process. A user-edited config cannot start upstream
    # synthetic SR, a second consumer, or an unsupported color path.
    start = text.index('static void FeedFrameDispatch(')
    brace = text.index('{', start)
    text = text[:brace + 1] + '''
    if (nr_feeder::quarantined) return;
    if (g_cfg.work_resolution != 100 || g_cfg.work_upscale != 0) {
        FeedDisable("project NR uses full-size post-process frames; SR injection is disabled"); return;
    }
''' + text[brace + 1:]
    # Old official headers name these values explicitly; keep the fixed SDK.
    text = re.sub(r'color_space::srgb\b', 'color_space::srgb_nonlinear', text)
    text = re.sub(r'color_space::scrgb\b', 'color_space::extended_srgb_linear', text)
    text = re.sub(r'color_space::hdr10_pq\b', 'color_space::hdr10_st2084', text)
    return text

def host(text: str) -> str:
    text = once(text, '#include "../src/feed_ngx.h"', '#include "nr_feeder_consumer.h"\n#include "nr_feeder_host_guides.h"\n#include "nr_feeder_adapter_inventory.h"\n#include "../src/feed_ngx.h"', 'host consumer include')
    text = once(text, 'int main(int argc, char **argv)\n{', 'int main(int argc, char **argv)\n{\n    if (argc == 2 && strcmp(argv[1], "--list-adapters-json") == 0) return NrListAdaptersJson();', 'read-only adapter inventory')
    for name in ('DetectRenodxAddon()', 'DetectToolkitAddon()', 'DetectChickenAddon()', 'DetectOptiScaler()'):
        text = function(text, 'static void ' + name, '// This package has one project Core; no other consumer is discovered or configured.')
    text = text.replace('if (!avail) return false;', '// Feature1 availability cannot admit or decline the project Feature18 Core.')
    text = once(text, 'static bool ReShadeOwnsCreateDevice(', 'static LUID nr_game_luid{};\nstatic bool nr_game_luid_set = false;\n\nstatic bool ReShadeOwnsCreateDevice(', 'host LUID storage')
    text = once(text, '        else if (strcmp(argv[i], "--gpu-priority") == 0) gpu_priority = true;', '''        else if (strcmp(argv[i], "--gpu-priority") == 0) gpu_priority = true;
        else if (strncmp(argv[i], "--luid=", 7) == 0) {
            unsigned high = 0, low = 0;
            if (sscanf_s(argv[i] + 7, "%x:%x", &high, &low) != 2) return 1;
            nr_game_luid.HighPart = static_cast<LONG>(high); nr_game_luid.LowPart = low; nr_game_luid_set = true;
        }''', 'host LUID option')
    text = once(text, '    HRESULT hr = create_device(nullptr, D3D_FEATURE_LEVEL_11_0, __uuidof(ID3D12Device),', '''    IDXGIFactory1 *nr_factory = nullptr; IDXGIAdapter1 *nr_adapter = nullptr;
    if (!nr_game_luid_set || FAILED(create_factory(IID_PPV_ARGS(&nr_factory)))) return false;
    for (UINT index = 0; ; ++index) {
        IDXGIAdapter1 *candidate = nullptr;
        if (nr_factory->EnumAdapters1(index, &candidate) == DXGI_ERROR_NOT_FOUND) break;
        DXGI_ADAPTER_DESC1 desc{};
        if (candidate && SUCCEEDED(candidate->GetDesc1(&desc)) &&
            desc.AdapterLuid.HighPart == nr_game_luid.HighPart && desc.AdapterLuid.LowPart == nr_game_luid.LowPart) {
            nr_adapter = candidate; break;
        }
        if (candidate) candidate->Release();
    }
    nr_factory->Release();
    if (!nr_adapter) { Log("[nr-feeder-host-retained] game adapter absent"); return false; }
    HRESULT hr = create_device(nr_adapter, D3D_FEATURE_LEVEL_11_0, __uuidof(ID3D12Device),''', 'host matched adapter')
    text = once(text, '                               reinterpret_cast<void **>(&h.dev));', '                               reinterpret_cast<void **>(&h.dev));\n    nr_adapter->Release();\n    if (SUCCEEDED(hr) && !nr_feeder::NormalizePrivateDevice(h.dev)) hr = E_NOINTERFACE;', 'release selected adapter')
    text = function(text, 'static bool CreateFeature(UINT w, UINT h_, int flags, NVSDK_NGX_Result *out_r,', '''
    if ((target_w && target_w != w) || (target_h && target_h != h_)) {
        if (out_r) *out_r = NVSDK_NGX_Result_Fail; return false;
    }
    nr_feeder::Claim();
    if (out_r) *out_r = static_cast<NVSDK_NGX_Result>(1);
    Log("[nr-feeder-host] provider-only %ux%u flags=%d; private Feature1 disabled", w, h_, flags);
    return true;
''')
    text = function(text, 'static bool Evaluate(ID3D12Resource *color,', '''
    if (nr_feeder::quarantined || !h.actual_sdr) return false;
    const auto home_desc = h.tex[FEED_OUTPUT]->GetDesc(), source_desc = color->GetDesc();
    if (home_desc.Width != source_desc.Width || home_desc.Height != source_desc.Height ||
        nr_external_provider_vk_color::Classify(home_desc.Format, reshade::api::color_space::srgb_nonlinear) !=
        nr_external_provider_vk_color::Classify(source_desc.Format, reshade::api::color_space::srgb_nonlinear) || !BeginCommands()) return false;
    const auto input = D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE;
    for (auto *r : {color, depth, mv}) nr_feeder::Transition(h.list, r, D3D12_RESOURCE_STATE_COMMON, input);
    const bool recorded = nr_feeder::Record(h.dev, h.list, h.queue, h.fence, h.fence_value + 1,
        color, output, depth, mv, w, h_, mvsx, mvsy, reset != 0,
        (h.flags & NVSDK_NGX_DLSS_Feature_Flags_DepthInverted) != 0,
        false, input, D3D12_RESOURCE_STATE_COMMON);
    for (auto *r : {color, depth, mv}) nr_feeder::Transition(h.list, r, input, D3D12_RESOURCE_STATE_COMMON);
    // A declined Core must never expose old/uninitialized shared Output. The
    // same-frame identity copy is submitted on the very same queue/fence.
    if (!recorded) {
        nr_feeder::Transition(h.list, color, D3D12_RESOURCE_STATE_COMMON, D3D12_RESOURCE_STATE_COPY_SOURCE);
        nr_feeder::Transition(h.list, h.tex[FEED_OUTPUT], D3D12_RESOURCE_STATE_COMMON, D3D12_RESOURCE_STATE_COPY_DEST);
        h.list->CopyResource(h.tex[FEED_OUTPUT], color);
        nr_feeder::Transition(h.list, color, D3D12_RESOURCE_STATE_COPY_SOURCE, D3D12_RESOURCE_STATE_COMMON);
        nr_feeder::Transition(h.list, h.tex[FEED_OUTPUT], D3D12_RESOURCE_STATE_COPY_DEST, D3D12_RESOURCE_STATE_COMMON);
    } else if (output != h.tex[FEED_OUTPUT]) {
        nr_feeder::Transition(h.list, output, D3D12_RESOURCE_STATE_COMMON, D3D12_RESOURCE_STATE_COPY_SOURCE);
        nr_feeder::Transition(h.list, h.tex[FEED_OUTPUT], D3D12_RESOURCE_STATE_COMMON, D3D12_RESOURCE_STATE_COPY_DEST);
        h.list->CopyResource(h.tex[FEED_OUTPUT], output);
        nr_feeder::Transition(h.list, output, D3D12_RESOURCE_STATE_COPY_SOURCE, D3D12_RESOURCE_STATE_COMMON);
        nr_feeder::Transition(h.list, h.tex[FEED_OUTPUT], D3D12_RESOURCE_STATE_COPY_DEST, D3D12_RESOURCE_STATE_COMMON);
    }
    const UINT64 submitted = EndCommands();
    if (!nr_feeder::Complete(h.fence, h.fence_event, submitted)) {
        Log("[nr-feeder-host-retained] reason=%s", nr_feeder::reason); return false;
    }
    if (nr_feeder::frame_sequence <= 3 || nr_feeder::frame_sequence % 60 == 0)
        Log("[nr-feeder-host-completion] frame=%llu epoch=%llu nr_completed=%d output_recorded=1 provenance=Synthetic reason=%s",
            nr_feeder::frame_sequence, nr_feeder::epoch, recorded ? 1 : 0, nr_feeder::reason);
    return true;
''')
    # Saved flags are needed independently of a private NGX feature handle.
    text = once(text, '    int             sr_quality;', '    int             flags;\n    bool            actual_sdr;\n    bool            host_guides;\n    int             sr_quality;', 'host flags')
    text = once(text, '''            if (!WaitFenceValue(h.fence, h.fence_value, 2000))
                Log("[host] rebuild: the previous frame's GPU work did not retire within 2 s");''',
                '''            if (h.fence_value && !nr_feeder::Complete(h.fence, h.fence_event, h.fence_value)) ExitProcess(32);
            nr_feeder_host_guides::guides.Release();
            if (nr_feeder_host_guides::guides.retained) ExitProcess(32);''', 'host rebuild retires exact guide generation')
    text = once(text, '                if (b.flags_override >= 0) flags_active = b.flags_override;',
                '                if (b.flags_override >= 0) flags_active = b.flags_override;\n                h.flags = flags_active;\n                h.actual_sdr = b.actual_sdr == 1;\n                h.host_guides = (b.client_flags & FEED_BUILD_NR_HOST_GUIDES) != 0;\n                nr_feeder::Reset();', 'host epoch')
    text = once(text, 'const bool no_uav         = host_creates_b && (b.client_flags & FEED_BUILD_OUTPUT_NO_UAV) != 0;',
                'const bool no_uav         = (b.client_flags & FEED_BUILD_OUTPUT_NO_UAV) != 0;', 'producer-owned no-UAV output')
    text = once(text, 'if (ok && no_uav && b.transport == 0)',
                'if (false && ok && no_uav && b.transport == 0) // Core adapter owns its FP16 UAV output', 'no separate private BGRA UAV')
    before = '            bool done = false;\n            if (transport_only)'
    text = once(text, before, '''            bool guides_ready = true;
            if (h.host_guides) {
                guides_ready = nr_feeder_host_guides::guides.Render(h.dev, h.queue, h.tex[FEED_COLOR], h.tex[FEED_DEPTH], h.tex[FEED_MV]);
                if (nr_feeder::quarantined) ExitProcess(32);
                if (fm.n <= 3 || fm.n % 60 == 0)
                    Log("[nr-feeder-host-guides] frame=%llu completed=%d source=VORT-pixel reason=%s", fm.n, guides_ready ? 1 : 0, nr_feeder_host_guides::guides.reason);
            }
            bool done = false;
            if (transport_only || !guides_ready)''', 'host generated guide admission')
    text = function(text, '            if (transport_only || !guides_ready)', '''
                nr_feeder::recorded = false;
                if (BeginCommands()) {
                    nr_feeder::Transition(h.list,h.tex[FEED_COLOR],D3D12_RESOURCE_STATE_COMMON,D3D12_RESOURCE_STATE_COPY_SOURCE);
                    nr_feeder::Transition(h.list,h.tex[FEED_OUTPUT],D3D12_RESOURCE_STATE_COMMON,D3D12_RESOURCE_STATE_COPY_DEST);
                    h.list->CopyResource(h.tex[FEED_OUTPUT],h.tex[FEED_COLOR]);
                    nr_feeder::Transition(h.list,h.tex[FEED_COLOR],D3D12_RESOURCE_STATE_COPY_SOURCE,D3D12_RESOURCE_STATE_COMMON);
                    nr_feeder::Transition(h.list,h.tex[FEED_OUTPUT],D3D12_RESOURCE_STATE_COPY_DEST,D3D12_RESOURCE_STATE_COMMON);
                    EndCommands(); done = true;
                }
''')
    text = text.replace('warm_done = transport_only || g_renodx_lazy || g_opti.routed || (g_chicken_present && !g_chicken_created_unarmed);',
                        'warm_done = true; // Our Core owns all NR warmup/history.')
    text = once(text, '            if (h.feature == nullptr && !transport_only) { h.fence_out->Signal(fm.n); PumpPresent(); continue; }',
                '            // No private Feature1 exists; the project Core owns the feature lifecycle.', 'host feature gate')
    # This project extension of base IPC v9 acknowledges the completed frame.
    # The game may only enqueue its copy-home after a positive result. Merely
    # CPU-signalling a failed host's fence must never expose stale Output.
    result_anchor = '''            if (fm.n <= 3 || (fm.n % 1800) == 0)
            {'''
    text = once(text, result_anchor, '''            if (done && !nr_feeder::Complete(h.fence, h.fence_event, h.fence_value)) done = false;
            const FeedFrameResult project_result = {FEED_IPC_MAGIC, fm.n, done ? 1u : 0u,
                done && !transport_only && nr_feeder::recorded ? 1u : 0u};
            if (nr_feeder::quarantined) ExitProcess(32);
            if (!WriteFull(pipe, &project_result, sizeof(project_result))) break;
            if (fm.n <= 3 || fm.n % 30 == 0)
                Log("[nr-feeder-host-ack] pid=%lu game_pid=%lu frame=%llu epoch=%llu output_ready=%u nr_completed=%u luid=%08lX:%08lX",
                    GetCurrentProcessId(), hello.pid, fm.n, nr_feeder::epoch, project_result.output_ready, project_result.nr_completed,
                    nr_game_luid.HighPart, nr_game_luid.LowPart);

''' + result_anchor, 'host completion response')
    return text

def client(text: str) -> str:
    text = once(text, 'return float4(src_color.Sample(smp, i.uv).rgb, 1.0);',
                'return src_color.Sample(smp, i.uv);', 'client copy-home alpha')
    text = once(text, '#include "feed_ipc.h"', '#include "feed_ipc.h"\n#include "nr_external_provider_vk_color.h"\nstatic bool nr_sdr_confirmed = false;', 'client color-space tracker')
    for name in ('DetectChickenHost()', 'DetectOptiHost()', 'DetectStrayHostAddon()'):
        text = function(text, 'static void ' + name, '// The managed package contains only the project NR Core.')
    text = function(text, 'static void DrawOverlay(reshade::api::effect_runtime *rt)', '''
    (void)rt;
    ImGui::TextUnformatted("NR Feeder 0.15.1 - managed host transport");
    ImGui::TextWrapped("The x64 host runs the project's Core. Only a completed same-frame response may return to this game. No super resolution or frame generation is injected.");
''')
    text = once(text, '        Log("dlss5-feed32 %s (built %s %s) attached%s.", FEED_VERSION, __DATE__, __TIME__,',
                '        Log("[nr-feeder-session] pid=%lu source=0151-external-v1", GetCurrentProcessId());\n        Log("dlss5-feed32 %s (built %s %s) attached%s.", FEED_VERSION, __DATE__, __TIME__,', 'client session marker')
    text = text.replace('FeedBuild b = {};', 'FeedBuild b = {}; b.actual_sdr = nr_sdr_confirmed ? 1u : 0u;')
    for verb in ('register', 'unregister'):
        anchor = f'        reshade::{verb}_event<reshade::addon_event::create_device>(OnCreateDevice);'
        text = once(text, anchor, anchor + f'''\n        reshade::{verb}_event<reshade::addon_event::init_swapchain>(nr_external_provider_vk_color::RememberSwapchain);
        reshade::{verb}_event<reshade::addon_event::destroy_swapchain>(nr_external_provider_vk_color::ForgetSwapchain);''', 'client tracked swapchains ' + verb)
    text = text.replace('ID3D10Device1  *d10_dev;', 'ID3D10Device   *d10_dev;')
    text = text.replace('g_cfg.async_home != 0', 'false /* project same-frame contract */')
    text = once(text, 'char exe[MAX_PATH], cmd[MAX_PATH + 32], wd[MAX_PATH];', 'char exe[MAX_PATH], cmd[MAX_PATH + 96], wd[MAX_PATH];', 'longer host command')
    text = once(text, '''    sprintf_s(cmd, "\\"%s\\" %lu%s%s", exe, GetCurrentProcessId(),
              g_cfg.host_window ? "" : " --behind",
              g_cfg.host_gpu_priority ? " --gpu-priority" : "");''', '''    IDXGIDevice *nr_dxgi = nullptr; IDXGIAdapter *nr_adapter = nullptr; DXGI_ADAPTER_DESC nr_desc{};
    if (!g.dev || FAILED(g.dev->QueryInterface(IID_PPV_ARGS(&nr_dxgi)))) return false;
    HRESULT nr_hr = nr_dxgi->GetAdapter(&nr_adapter); nr_dxgi->Release();
    if (FAILED(nr_hr) || !nr_adapter) return false;
    nr_hr = nr_adapter->GetDesc(&nr_desc); nr_adapter->Release();
    if (FAILED(nr_hr)) return false;
    sprintf_s(cmd, "\\"%s\\" %lu --hide --luid=%08lX:%08lX", exe, GetCurrentProcessId(),
        nr_desc.AdapterLuid.HighPart, nr_desc.AdapterLuid.LowPart);''', 'client adapter handoff')
    text = once(text, '    const bool ok = PipeWrite(&msg, sizeof(msg));', '''    bool ok = PipeWrite(&msg, sizeof(msg));
    FeedFrameResult result{};
    if (ok) ok = PipeXfer(g.pipe, PipeEvent(), false, &result, sizeof(result), fm.n <= 3 ? kPipeHelloMs : kPipeFrameMs);
    if (ok) ok = result.magic == FEED_IPC_MAGIC && result.frame == fm.n && result.output_ready == 1;
    if (!ok) Log("[nr-feeder-client-retained] frame=%llu host completion absent; no copy-home", fm.n);
    else if (fm.n <= 3 || fm.n % 30 == 0)
        Log("[nr-feeder-client-completion] frame=%llu output_ready=1 nr_completed=%u", fm.n, result.nr_completed);''', 'client completion read')
    start = text.index('static void FeedFrameDispatch(')
    brace = text.index('{', start)
    text = text[:brace + 1] + '''
    nr_sdr_confirmed = nr_external_provider_vk_color::ColorSpace(rt) == reshade::api::color_space::srgb_nonlinear;
    if (!nr_sdr_confirmed) return;
    g_cfg.async_home = 0;
    if (g_cfg.work_resolution != 100 || g_cfg.work_upscale != 0) {
        FeedDisable("project NR uses same-frame full-size input; synthetic SR is disabled"); return;
    }
''' + text[brace + 1:]
    return text

def ipc(text: str) -> str:
    text = once(text, '#define FEED_IPC_MAGIC   0x35534C44u', '#define FEED_IPC_MAGIC   0x3352464Eu', 'project protocol magic')
    text = once(text, '#define FEED_BUILD_HOST_CREATES  1u', '#define FEED_BUILD_NR_HOST_GUIDES 0x10000000u // Project VORT runs in the x64 host.\n#define FEED_BUILD_HOST_CREATES  1u', 'host guide flag')
    text = once(text, 'struct FeedBuild        // game -> host, on every resolution/format change\n{',
                'struct FeedBuild        // game -> host, on every resolution/format change\n{\n    uint32_t actual_sdr; // Project extension: independent actual swapchain color space.', 'build SDR contract')
    return once(text, '#pragma pack(pop)', '''// Project-only completion extension over the source-pinned v9 protocol. A
// distinct magic refuses stock/mixed binaries before exchanging any handles.
struct FeedFrameResult {
    uint32_t magic;
    uint64_t frame;
    uint32_t output_ready;
    uint32_t nr_completed;
};
static_assert(sizeof(FeedFrameResult) == 20);

#pragma pack(pop)''', 'project completion struct')

def relay(text: str) -> str:
    text = text.replace('ID3D10Device1       *game;', 'ID3D10Device        *game;')
    old = '''    HRESULT hr = game_device->QueryInterface(__uuidof(ID3D10Device1), (void **)&d->game);
    if (FAILED(hr)) { FeedD3D10Fail(d, "ID3D10Device1 (this is a Direct3D 10.0 device)", hr); return false; }
    d->game->Release();   // not owned; the QI reference would outlive our interest in it'''
    text = once(text, old, '''    // All operations below are ID3D10Device copies/event queries. The private
    // relay supplies D3D11.1 sharing, so a 10.0 game requires no 10.1 interface.
    d->game = game_device;
    HRESULT hr = S_OK;''', 'D3D10.0 device')
    text = text.replace('        if (GetTickCount64() > deadline) return false;',
                        '        if (GetTickCount64() >= deadline) { FeedD3D10Fail(d, "bounded GPU drain", HRESULT_FROM_WIN32(WAIT_TIMEOUT)); return false; } else Sleep(0);')
    text = text.replace('return SUCCEEDED(hr);', 'return hr == S_OK && done != FALSE;')
    return text

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upstream', type=Path, required=True)
    parser.add_argument('--interop', type=Path, required=True)
    parser.add_argument('--dependencies', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    upstream, output = args.upstream.resolve(), args.output.resolve()
    actual = subprocess.check_output(['git', '-C', str(upstream), 'rev-parse', 'HEAD'], text=True).strip()
    if actual != PIN or output.exists():
        raise ValueError('Expected pinned upstream and a new output directory')
    shutil.copytree(upstream, output, ignore=shutil.ignore_patterns('.git', 'build', 'external'))
    headers = output / 'nr_lab_interop'; headers.mkdir()
    for name in HEADERS:
        shutil.copyfile(args.interop / name, headers / name)
    color_header = headers / 'nr_external_provider_vk_color.h'
    color_text = color_header.read_text().replace('if (!swapchain || swapchain->get_device()->get_api() != reshade::api::device_api::vulkan) return;',
        'if (!swapchain) return; // Project tracker covers every admitted game API.')
    color_text = once(color_text, '#include <d3d12.h>', '#include <d3d12.h>\n#include <dxgi.h>', 'legacy swapchain descriptor include')
    color_text = once(color_text, 'if (same) { result = swapchain->get_color_space(); ++matched; }', '''if (same) {
            result = swapchain->get_color_space();
            // ReShade 6.8's D3D10 getter always returns unknown. The Windows
            // legacy blt model can only display SDR. Admit its actual packed
            // RGB8 descriptor; modern flip-model/other formats stay unknown.
            // https://learn.microsoft.com/windows/win32/api/dxgi/ne-dxgi-dxgi_swap_effect
            if (result == reshade::api::color_space::unknown &&
                swapchain->get_device()->get_api() == reshade::api::device_api::d3d10) {
                auto *dxgi = reinterpret_cast<IDXGISwapChain *>(swapchain->get_native());
                DXGI_SWAP_CHAIN_DESC desc{};
                if (dxgi && SUCCEEDED(dxgi->GetDesc(&desc)) &&
                    (desc.SwapEffect == DXGI_SWAP_EFFECT_DISCARD || desc.SwapEffect == DXGI_SWAP_EFFECT_SEQUENTIAL) &&
                    Classify(desc.BufferDesc.Format, reshade::api::color_space::srgb_nonlinear) != Layout::Unsupported)
                    result = reshade::api::color_space::srgb_nonlinear;
            }
            ++matched;
        }''', 'D3D10 legacy SDR descriptor')
    color_header.write_text(color_text, encoding='utf8', newline='\n')
    shutil.copyfile(Path(__file__).parent / 'feeder-beta3/nr_feeder_consumer.h', headers / 'nr_feeder_consumer.h')
    shutil.copyfile(Path(__file__).parent / 'feeder-beta3/nr_feeder_host_guides.h', headers / 'nr_feeder_host_guides.h')
    shutil.copyfile(Path(__file__).parent / 'feeder-beta3/nr_feeder_adapter_inventory.h', headers / 'nr_feeder_adapter_inventory.h')
    for folder in ('reshade', 'ngx', 'vulkan', 'imgui', 'minhook'):
        shutil.copytree(args.dependencies / folder, output / 'external' / folder)
    cpp, helper, d10 = output / 'src/dlss5-feed.cpp', output / 'host/dlss5-feed-host64.cpp', output / 'src/feed_d3d10.h'
    cpp.write_text(native(cpp.read_text(encoding='utf8')), encoding='utf8', newline='\n')
    helper.write_text(host(helper.read_text(encoding='utf8')), encoding='utf8', newline='\n')
    d10.write_text(relay(d10.read_text(encoding='utf8')), encoding='utf8', newline='\n')
    client_file = output / 'src/dlss5-feed32.cpp'
    client_file.write_text(client(client_file.read_text(encoding='utf8')), encoding='utf8', newline='\n')
    ipc_file = output / 'src/feed_ipc.h'
    ipc_file.write_text(ipc(ipc_file.read_text(encoding='utf8')), encoding='utf8', newline='\n')
    manifest = { 'schema': 1, 'upstreamCommit': PIN, 'upstreamVersion': '0.15.1', 'ipcVersion': 9,
        'coreInterface': 'NRExternalProviderV1', 'privateFeature1': False, 'syntheticSr': False,
        'ipcExtension': 'project-frame-completion-v1',
        'files': {p.relative_to(output).as_posix(): sha(p) for p in [cpp, helper, d10, client_file, ipc_file, *headers.iterdir()]},
        'compileLinkVerified': False, 'controlledRuntimeVerified': False, 'realGameVerified': False }
    (output / 'beta3-source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf8')
    print(json.dumps({'stage': str(output), 'upstreamCommit': PIN, 'files': len(manifest['files'])}))

if __name__ == '__main__':
    main()
