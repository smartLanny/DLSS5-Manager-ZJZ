'use strict';

const branding = require('../../product.json');

const PRODUCT = Object.freeze({
  id: 'xiaofeng-dlss5-manager',
  ...branding,
  upstreamCommit: 'ccb67f4bc92cb5da1d25416dd6b338e12fa432c5'
});

// Keep the internal ID stable so the new compatibility payload directly
// replaces the former 0.4.5 catalog entry and existing per-game selections.
const DX11_COMPAT_VERSION = '0.4.5-ota';
const DX11_COMPAT_LABEL = '0.4.5-DX11-兼容增强';
const DX11_COMPAT_CARRIER = 'dlss5-native-carrier-045-dx11-compat.addon64';
const DX11_COMPAT_NOTES = '支持已有原生或模组 DLSS 的 DX11-x64 游戏，并保留 D3D12 原生 SR 与已知硬件深度 RR 路线；不支持无 DLSS 游戏、Feeder、Vulkan、DX9/DX10/OpenGL 或 x86 Legacy。安装时保留现有 INI，配套替换核心 Addon、nrchain 和 carrier；会移出旧核心与旧 carrier，禁止叠加混装。';

const PAYLOAD_FILES = Object.freeze({
  reshade: 'ReShade64.dll',
  addon: 'nr-before-sr.zh-CN.addon64',
  bridge: 'nrchain_nvngx.dll',
  runtime: 'nvngx_dlssnr.dll',
  config: 'nr_before_sr.ini'
});

const INSTALLED_NAMES = Object.freeze({
  reshade: 'dxgi.dll',
  addon: PAYLOAD_FILES.addon,
  bridge: PAYLOAD_FILES.bridge,
  runtime: PAYLOAD_FILES.runtime,
  config: PAYLOAD_FILES.config,
  carrier: DX11_COMPAT_CARRIER
});

// Historical fallback retained for older callers; reads resolve their installed
// Core contract and report missing/unknown defaults separately.
const { LEGACY_DEFAULTS: DEFAULT_NR_CONFIG, PUBLIC_NR_KEYS } = require('./nr-config-contract');

module.exports = {
  PRODUCT,
  DX11_COMPAT_VERSION,
  DX11_COMPAT_LABEL,
  DX11_COMPAT_CARRIER,
  DX11_COMPAT_NOTES,
  PAYLOAD_FILES,
  INSTALLED_NAMES,
  DEFAULT_NR_CONFIG,
  PUBLIC_NR_KEYS
};
