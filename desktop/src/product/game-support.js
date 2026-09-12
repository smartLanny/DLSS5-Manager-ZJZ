'use strict';

const ROUTES = new Set(['dx9', 'dx10', 'dx11', 'dx12', 'vulkan', 'opengl', 'mixed', 'unknown', 'unsupported']);
function normalizeApi(value) {
  const compact = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return ({ d3d9: 'dx9', directx9: 'dx9', dx9: 'dx9', d3d10: 'dx10', directx10: 'dx10', dx10: 'dx10',
    d3d11: 'dx11', directx11: 'dx11', dx11: 'dx11', d3d12: 'dx12', directx12: 'dx12', dx12: 'dx12',
    vulkan: 'vulkan', opengl: 'opengl', ogl: 'opengl' })[compact] || null;
}

function classifyApi(chosen) {
  if (!chosen) return 'unknown';
  const resolved = chosen.apiResolution && chosen.apiResolution.api;
  if (ROUTES.has(resolved)) return resolved;
  const label = String(chosen.apiLabel || '');
  const direct = normalizeApi(chosen.api);
  const compactMixed = /(?:DirectX|D3D|DX)\s*11\s*[/&,或-]\s*(?:(?:DirectX|D3D|DX)\s*)?12\b/i.test(label);
  const dx11 = direct === 'dx11' || chosen.dx11 === true || /(?:DirectX|D3D|DX)\s*11\b/i.test(label);
  const dx12 = direct === 'dx12' || chosen.dx12 === true || /(?:DirectX|D3D|DX)\s*12\b/i.test(label) || compactMixed;
  if (dx11 && dx12) return 'mixed';
  if (direct && !['dx11', 'dx12'].includes(direct)) return direct;
  if (chosen.api && !direct && !['dxgi', 'unknown'].includes(String(chosen.api).toLowerCase())) return 'unsupported';
  if (dx12) return 'dx12';
  // API detection and bridge admission are independent. annotateApi resolves
  // multi-backend engines and current settings before this legacy fallback.
  if (dx11) return 'dx11';
  return 'unknown';
}

function isDx11Only(chosen) {
  return classifyApi(chosen) === 'dx11';
}

function apiSupported(chosen, options = {}) {
  if (!chosen) return false;
  // D3D12 remains supported by the ordinary core path. Pure DX11 is admitted
  // only for the compatibility payload and still requires an existing native
  // or mod-provided nvngx_dlss.dll; this is not a no-DLSS/Feeder route.
  const api = classifyApi(chosen);
  return api === 'dx12' || (options.allowDx11 === true && api === 'dx11');
}

function assess(scan, options = {}) {
  if (!scan || !scan.chosen) return { supported: false, code: 'ERR_NO_GAME_EXE' };
  if (scan.chosen.emulator || scan.emulator) return { supported: false, code: 'ERR_EMULATOR_UNSUPPORTED' };
  if (Number(scan.chosen.bitness) !== 64) return { supported: false, code: 'ERR_UNSUPPORTED_BITNESS' };
  if (['mixed', 'unknown'].includes(classifyApi(scan.chosen))) return { supported: false, code: 'ERR_API_SELECTION_REQUIRED' };
  if (!apiSupported(scan.chosen, options)) return { supported: false, code: 'ERR_UNSUPPORTED_API' };
  if ((!scan.primaryDlss || !/^nvngx_dlss\.dll$/i.test(scan.primaryDlss.name || '')) &&
      !(options.supportsPresent === true && classifyApi(scan.chosen) === 'dx12')) {
    return { supported: false, code: 'ERR_NO_DLSS' };
  }
  return { supported: true, code: null };
}

// An independent post-process route. Native installation retains its ordinary
// DLSS requirement above; Feeder does not imply SR or FG availability.
function assessFeeder(scan) {
  const reject = (code, message) => ({ supported: false, code, message });
  if (!scan?.chosen) return reject('FEEDER_GAME_REQUIRED', '请先选择游戏 EXE。');
  if (scan.chosen.emulator || scan.emulator) return reject('FEEDER_EMULATOR_UNSUPPORTED', '首批 Feeder 不支持模拟器。');
  if (Number(scan.chosen.bitness) !== 64) return reject('FEEDER_GAME_ARCH', '首批 Feeder 只支持 x64 游戏。');
  if (classifyApi(scan.chosen) !== 'dx12') return reject('FEEDER_API_REQUIRED', '先确认所选 EXE 使用 DirectX 12；其他 API 不使用此配套。');
  if (scan.primaryDlss && /^nvngx_dlss\.dll$/i.test(scan.primaryDlss.name || '') &&
      !/(?:^|[\\/])_DLSS5_Feeder(?:[\\/]|$)/i.test(scan.primaryDlss.path || ''))
    return reject('FEEDER_NATIVE_DLSS_PRESENT', '已发现原生或模组 DLSS，请使用原生 NR 路线。');
  return { supported: true, code: null, message: null, provenance: 'Synthetic', scope: 'post-process' };
}

module.exports = { assess, assessFeeder, apiSupported, isDx11Only, classifyApi };
