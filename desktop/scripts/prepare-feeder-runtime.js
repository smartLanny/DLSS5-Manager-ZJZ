'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { noLinks } = require('../src/product/launch-safety');
const { DIRECTORY, sha, fingerprint, fail, fileDigest, regularJson, resolveFile } = require('../src/product/feeder-runtime');
const { LICENSE } = require('./prepare-vulkan-reshade');
const acceptance = require('./feeder-dx12-acceptance');

const ID = 'nr-feeder-dx12-047-sdr-20260909';
const PINS = Object.freeze({
  core: '93011d9283615ea9dc8e92955f5ca6aeff01435925f63e941dc1eea1128a372c',
  chain: '46041a5ff91ae2fd907e310d132aabc3c4a1ecd48dace511b8672909d5d9c2fb',
  runtime: 'e16bcf15e16e13f527491cdf7845b2fe6521a738d8f7c9c721866a8496e1fc8e',
  loader: '0cee63f9c9f13f3ac909c5b4903f4dbb4b719a7ab3b4f13b0deaf83c814b94f7'
});
function setIni(text, key, value) {
  const line = new RegExp(`^${key}=.*$`, 'm');
  return line.test(text) ? text.replace(line, `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
}
async function prepare(input) {
  for (const key of ['runtimeRoot', 'loader', 'feeder', 'validation', 'output']) {
    if (!path.isAbsolute(input[key] || '')) fail('FEEDER_BUILD_INPUT', `${key} 必须是绝对路径。`);
    await noLinks(input[key]);
  }
  if (fs.existsSync(input.output)) fail('FEEDER_BUILD_EXISTS', 'Feeder 输出必须是新目录，保留已有候选。');
  const base = regularJson(path.join(input.runtimeRoot, 'recipe.json'));
  if (base?.id !== 'nr-vulkan-047-20260909' || base.coreVersion !== '0.4.7beta') fail('FEEDER_BUILD_BASE', '需要固定 047 Provider 配套作为只读来源。');
  const validation = regularJson(input.validation, 512 * 1024), stage = validation?.feeder_manifest;
  if (validation?.compile_link_verified !== true || stage?.feeder_commit_actual !== '26c002d5156d178c2db438327194077c9ad94418' ||
      stage?.dx12_sdr_candidate?.contract !== 'DX12 x64; actual swapchain srgb_nonlinear; RGBA8 UNORM only; full-size input; Core R8OutputEncoding=2' ||
      stage.dx12_sdr_candidate.private_nr_owner !== false || !/^[a-f0-9]{64}$/.test(validation.binary_sha256 || '') ||
      await fileDigest(input.feeder) !== validation.binary_sha256 || validation.binary_sha256 !== acceptance.providerSha256)
    fail('FEEDER_BUILD_PROVIDER', '需要真实 DX12 SDR Provider 构建及匹配摘要。');
  const assets = [];
  const from = async (file, target, role, expected, metadata, mutable = false, transform = null) => {
    if (await fileDigest(file) !== expected) fail('FEEDER_BUILD_HASH', '来源摘要不匹配。', { file: path.basename(file) });
    const original = await fsp.readFile(file), data = transform ? Buffer.from(transform(original.toString('utf8')), 'utf8') : original;
    assets.push({ target, data, role, mutable, provenance: metadata });
  };
  await from(input.loader, 'dxgi.dll', 'loader', PINS.loader, { project: 'ReShade', version: '6.8.0', sourceSha256: PINS.loader });
  for (const row of base.files) {
    let role;
    if (/\.addon64$/i.test(row.target) && !/dlss5-feed/i.test(row.target)) role = 'core';
    else if (/nrchain_nvngx\.dll$/i.test(row.target)) role = 'chain';
    else if (/nvngx_dlssnr\.dll$/i.test(row.target)) role = 'nr-runtime';
    else if (/nr_before_sr\.ini$/i.test(row.target)) role = 'core-config';
    else if (/dlss5-feed.*\.addon64$|dlss5-feed\.cfg$|ReShade\.ini$/i.test(row.target)) continue;
    else if (row.target === 'ReShadePreset.ini') role = 'preset';
    else role = row.target.startsWith('licenses/') ? 'license' : 'shader';
    const expected = ({ core: PINS.core, chain: PINS.chain, 'nr-runtime': PINS.runtime })[role] || row.sha256;
    if (row.sha256 !== expected) fail('FEEDER_BUILD_BASE', '047 Core/nrchain/runtime 来源与固定配套不符。');
    await from(resolveFile(input.runtimeRoot, row.source), `${DIRECTORY}/${row.target}`, role, expected, row.provenance,
      row.mutable, role === 'core-config' ? text => {
        const values = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => !/^\s*;/.test(line)).join('\n');
        return '; Fixed DX12 Feeder provider. Synthetic post-process; no SR or FG injection.\n' +
          setIni(setIni(values, 'R8OutputEncoding', '2'), 'AllowUnverifiedHdrColor', '0');
      } : null);
  }
  await from(input.feeder, `${DIRECTORY}/addons/dlss5-feed-dx12-sdr.addon64`, 'provider', validation.binary_sha256,
    { upstreamCommit: stage.feeder_commit_actual, stagedSourceSha256: stage.feed_cpp_sha256,
      transformSha256: stage.dx12_sdr_candidate.transform_sha256, build: 'full-msvc-dx12-sdr', compileLinkVerified: true });
  const definitions = 'DLSS5_MV_PROVIDER=2,V_MV_MODE=1,V_MV_USE_REST=0,V_MV_DEBUG=0,V_ENABLE_MOT_BLUR=0,V_ENABLE_TAA=0';
  const reshade = `[GENERAL]\nEffectSearchPaths=.\\${DIRECTORY}\\reshade-shaders\\Shaders\\**\nTextureSearchPaths=.\\${DIRECTORY}\\reshade-shaders\\Textures\\**\nPresetPath=.\\${DIRECTORY}\\ReShadePreset.ini\nStartupPresetPath=\nNoReloadOnInit=0\nPreprocessorDefinitions=${definitions}\n\n[ADDON]\nAddonPath=.\\${DIRECTORY}\\addons\n`;
  const cfg = '# Fixed DX12 Provider; only actual RGBA8 sRGB swapchains are admitted.\n' +
    'enabled=1\nmode=2\nhdr=-1\ndepth_inverted=-1\nflags=-1\nreset_every=0\nwarmup_rebuild=0\nrebuild=0\nlog_frames=3\ncreate_delay=0\npreset=0\nwork_resolution=100\nwork_upscale=0\nwork_sharpness=0.0\ngpu_timeout_ms=2000\nasync_home=0\npassthrough=0\nmv_scale_x=1.0\nmv_scale_y=1.0\nstall_log_ms=50\n';
  assets.push({ target: 'ReShade.ini', data: Buffer.from(reshade), role: 'reshade-config', mutable: true, provenance: 'DX12 fixed local loader/addon/search paths; no global layer registration' });
  assets.push({ target: `${DIRECTORY}/addons/dlss5-feed.cfg`, data: Buffer.from(cfg), role: 'feeder-config', mutable: true, provenance: 'DX12 only; full-size feed; no synthetic SR/work_upscale or FG' });
  if (!Buffer.isBuffer(LICENSE)) fail('FEEDER_LICENSE_MISSING', 'ReShade 许可来源缺失。');
  assets.push({ target: `${DIRECTORY}/licenses/ReShade-LICENSE.md`, data: LICENSE, role: 'license', mutable: false, provenance: 'Official ReShade BSD notice retained' });
  const recipe = { version: 1, id: ID, route: 'feeder-dx12', api: 'dx12', architecture: 64, hardwareFamily: 'RTX50',
    coreVersion: '0.4.7beta', sourceRevision: '4ecc6d02ca6058cb1ebb0faae5aa49b34b0614ad', provenance: 'Synthetic', scope: 'post-process',
    colorContract: 'rgba8-srgb-confirmed', srInjected: false, fgInjected: false,
    acceptance,
    files: assets.map(({ target, data, role, mutable, provenance }) => ({ source: target, target, role, sha256: sha(data), bytes: data.length, mutable, provenance })) };
  await fsp.mkdir(input.output, { recursive: true });
  for (const asset of assets) {
    const file = resolveFile(input.output, asset.target); await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, asset.data, { flag: 'wx' });
    if (await fileDigest(file) !== sha(asset.data)) fail('FEEDER_BUILD_WRITE', 'Feeder 输出校验失败。');
  }
  await fsp.writeFile(path.join(input.output, 'recipe.json'), JSON.stringify(recipe, null, 2) + '\n', { flag: 'wx' });
  return { id: ID, recipeFingerprint: fingerprint(recipe), files: assets.length, bytes: assets.reduce((sum, item) => sum + item.data.length, 0),
    coreSha256: PINS.core, providerSha256: validation.binary_sha256, acceptance: recipe.acceptance };
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 5) { console.error('Usage: node scripts/prepare-feeder-runtime.js <047-runtime-root> <ReShade64.dll> <DX12-provider.addon64> <build-validation.json> <new-output>'); process.exitCode = 1; }
  else prepare({ runtimeRoot: path.resolve(args[0]), loader: path.resolve(args[1]), feeder: path.resolve(args[2]), validation: path.resolve(args[3]), output: path.resolve(args[4]) })
    .then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(`${error.code || 'error'}: ${error.message}`); process.exitCode = 1; });
}
module.exports = { prepare, ID, PINS };
