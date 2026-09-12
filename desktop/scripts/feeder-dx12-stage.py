#!/usr/bin/env python3
"""Stage the existing pinned external Provider with a DX12-only SDR boundary.

The upstream checkout and existing lab worktree remain read-only. This is a
small follow-on transform, not a second NR implementation. Compile the result
with the lab's build-feeder-recovery-msvc.ps1 and its real pinned dependencies.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

TRANSFORM_SHA256 = "4b698b0ef946af6576a2016c48d69eb0410c93fc154121c6fc92133b68c24949"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def once(text: str, old: str, new: str, name: str) -> str:
    if text.count(old) != 1:
        raise ValueError(f"DX12 provider anchor changed: {name}")
    return text.replace(old, new, 1)


def transform(text: str) -> str:
    start = text.index("static void FeedFrame12(")
    end = text.index("static void FeedFrameVk(", start)
    frame = text[start:end]
    anchor = "    const UINT w = static_cast<UINT>(cd.Width), h = cd.Height;\n"
    guard = r'''
    // Format alone does not identify SDR. Use the actual registered swapchain,
    // matched through this runtime's exact set of back buffers.
    const auto source_space = nr_external_provider_vk_color::ColorSpace(rt);
    if (cd.Format != DXGI_FORMAT_R8G8B8A8_UNORM ||
        source_space != reshade::api::color_space::srgb_nonlinear ||
        g_cfg.hdr > 0 || g_cfg.work_resolution != 100 || g_cfg.work_upscale != 0)
    {
        static ULONGLONG next_contract_log = 0;
        const ULONGLONG now = GetTickCount64();
        if (now >= next_contract_log) {
            next_contract_log = now + 5000;
            Log("[nr-feeder-dx12-retained] reason=requires-confirmed-rgba8-srgb format=%u space=%u hdr=%d work=%d upscale=%d",
                static_cast<unsigned>(cd.Format), static_cast<unsigned>(source_space),
                g_cfg.hdr, g_cfg.work_resolution, g_cfg.work_upscale);
        }
        return; // no copy, allocator use or NR recording on an unknown contract
    }
'''
    frame = once(frame, anchor, anchor + guard, "actual swapchain SDR guard")
    delivered = '                        Log("[feed] frame %llu delivered (%ux%u, reset=%d, same-device)", n, g.width, g.height, reset);\n'
    frame = once(frame, delivered, delivered + r'''
                    if (external_delegated && (n <= 3 || (n % 60) == 0))
                        Log("[nr-feeder-dx12-completion] frame=%llu nr_completed=1 output_recorded=1 provenance=Synthetic", n);
''', "completed NR/output recording evidence")
    # The Core owns warmup/history. A private Feature1 rebuild is irrelevant.
    old = "                    if (WarmupRebuildDue(n))\n"
    frame = once(frame, old, "                    if (!external_attempted && WarmupRebuildDue(n))\n", "Core-owned warmup")
    text = text[:start] + frame + text[end:]
    text = once(text, '    case reshade::api::device_api::d3d11: FeedFrame11(rt, cl, rtv); break;\n', '', "disable DX11")
    text = once(text, '    case reshade::api::device_api::vulkan: FeedFrameVk(rt, cl, rtv); break;\n', '', "disable Vulkan")
    text = once(text, '    case reshade::api::device_api::opengl: FeedFrameGl(rt, cl, rtv); break;\n', '', "disable OpenGL")
    text = text.replace('default: FeedDisable("only Direct3D 11/12, Vulkan and OpenGL games are supported"); break;',
                        'default: FeedDisable("this fixed external Provider supports only confirmed DX12 SDR"); break;')
    for signature in (
        'static void OnInitEffectRuntime(reshade::api::effect_runtime *rt)\n{\n',
        'static void OnDestroyEffectRuntime(reshade::api::effect_runtime *rt)\n{\n',
        'static void OnReloadedEffects(reshade::api::effect_runtime *rt)\n{\n',
    ):
        text = once(text, signature, signature +
                    '    if (!rt || rt->get_device()->get_api() != reshade::api::device_api::d3d12) return;\n', signature)
    text = once(text, '    if (g_cfg.enabled) FeedVkFramePresentInstall(rt);\n',
                '    static bool dx12_session_logged = false;\n'
                '    if (!dx12_session_logged) { dx12_session_logged = true; Log("[nr-feeder-dx12-session] pid=%lu", GetCurrentProcessId()); }\n',
                "DX12-only runtime marker")
    render = text.index('static void OnRenderTechnique(')
    opening = text.index('{\n', render) + 2
    text = text[:opening] + '    if (!rt || rt->get_device()->get_api() != reshade::api::device_api::d3d12) return;\n' + text[opening:]
    create = 'static bool OnCreateDevice(reshade::api::device_api api, uint32_t & /*api_version*/)\n{\n'
    text = once(text, create, create + '    if (api != reshade::api::device_api::d3d12) return false;\n', "no Vulkan device side effects")
    return text


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--feeder', required=True, type=Path)
    parser.add_argument('--lab', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    lab = args.lab.resolve()
    sys.dont_write_bytecode = True
    source_transform = lab / 'scripts/patch-feeder-external-nr.py'
    if digest(source_transform) != TRANSFORM_SHA256:
        raise ValueError('The existing external Provider transformer differs from the reviewed input')
    spec = importlib.util.spec_from_file_location('existing_provider_transform', source_transform)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    output = args.output.resolve()
    manifest = module.stage_feeder(args.feeder.resolve(), output, lab / 'src/interop')
    cpp = output / 'src/dlss5-feed.cpp'
    before = digest(cpp)
    result = transform(cpp.read_text(encoding='utf8'))
    cpp.write_text(result, encoding='utf8', newline='\n')
    colors = output / 'nr_lab_interop/nr_external_provider_vk_color.h'
    color_text = colors.read_text(encoding='utf8')
    color_text = once(color_text, 'swapchain->get_device()->get_api() != reshade::api::device_api::vulkan',
                      'swapchain->get_device()->get_api() != reshade::api::device_api::d3d12', 'track DX12 swapchains')
    colors.write_text(color_text, encoding='utf8', newline='\n')
    manifest['feed_cpp_sha256'] = digest(cpp)
    manifest['producer_header_sha256'][colors.name] = digest(colors)
    manifest['dx12_sdr_candidate'] = {
        'version': 1, 'transform_sha256': digest(Path(__file__)),
        'base_transform_sha256': TRANSFORM_SHA256, 'base_staged_cpp_sha256': before,
        'contract': 'DX12 x64; actual swapchain srgb_nonlinear; RGBA8 UNORM only; full-size input; Core R8OutputEncoding=2',
        'private_nr_owner': False, 'sr_injected': False, 'fg_injected': False,
        'gpu_verified': False, 'real_game_verified': False,
    }
    (output / 'feeder-external-nr-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf8')
    print(json.dumps({'stage': str(output), 'feed_cpp_sha256': manifest['feed_cpp_sha256'], 'gpu_verified': False}, indent=2))


if __name__ == '__main__':
    main()
