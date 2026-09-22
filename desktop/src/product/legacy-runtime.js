'use strict';

const fs = require('node:fs');
const path = require('node:path');
const catalog = require('./legacy-runtime-catalog');
const { noLinks } = require('./launch-safety');
const { HASH, PE, relative, regularJson, fingerprint, resolveFile, fileDigest, fail } = require('./feeder-runtime');

const DIRECTORY = '_DLSS5_Feeder15';
const RECEIPT = '_DLSS5_Backup/xiaofeng-feeder-v2.json';
const BASES = Object.freeze(['game', 'runtime', 'addon']);
const DEFAULTS = Object.freeze({
  definitions: 'DLSS5_MV_PROVIDER=2,V_MV_MODE=1,V_MV_USE_REST=0,V_MV_DEBUG=0,V_ENABLE_MOT_BLUR=0,V_ENABLE_TAA=0',
  hostGuides: '[GENERAL]\nNoReloadOnInit=0\nEffectSearchPaths=.\\..\\..\\reshade-shaders\\Shaders\\**\nTextureSearchPaths=.\\..\\..\\reshade-shaders\\Textures\\**\nPresetPath=.\\..\\..\\ReShadePreset.ini\nPreprocessorDefinitions=DLSS5_MV_PROVIDER=2,V_MV_MODE=1,V_MV_USE_REST=0,V_MV_DEBUG=0,V_ENABLE_MOT_BLUR=0,V_ENABLE_TAA=0\n[ADDON]\nAddonPath=.\\addons\n[INPUT]\nKeyOverlay=0,0,0,0\n[OVERLAY]\nTutorialProgress=4\nShowFPS=0\n',
  feeder: 'enabled=1\nmode=2\nhdr=-1\ndepth_inverted=-1\nflags=-1\nreset_every=0\nwarmup_rebuild=0\nrebuild=0\nlog_frames=3\ncreate_delay=0\nwork_resolution=100\nwork_upscale=0\nwork_sharpness=0.0\ngpu_timeout_ms=2000\nasync_home=0\npassthrough=0\nmv_scale_x=1.0\nmv_scale_y=1.0\nhost_window=0\nhost_gpu_priority=0\n'
});

function createLegacyRuntime(options = {}) {
  const root = options.root || (options.resourcesPath && fs.existsSync(path.join(options.resourcesPath, 'legacy-runtime', 'manifest.json'))
    ? path.join(options.resourcesPath, 'legacy-runtime') : path.join(options.appDir, 'resources', 'legacy-runtime'));
  const lock = options.lock || require('./legacy-runtime-lock');
  const pe = options.pe || require('../core/pe');
  const externalProviders = options.externalProviders || require('./external-provider-package').createExternalProviderPackages({
    root: options.componentLibraryRoot || path.join(options.userData || options.appDir || root, 'component-library'),
    currentCore: options.currentCore || options.getCurrentCore,
    currentRuntime: options.currentRuntime || options.getCurrentRuntime,
    selectCandidate: options.selectCandidate
  });
  function pool() {
    const manifest = regularJson(path.join(root, 'manifest.json'), 512 * 1024);
    if (!manifest) fail('LEGACY_PACKAGE_MISSING', '当前管理器缺少旧版 Feeder 固定配套。请更新完整管理器，并选用其配套 Core 与 Feeder；仅重复导入 NR 运行库无法补齐。', { file: 'legacy-runtime/manifest.json' });
    if (!manifest || manifest.schema !== 1 || !HASH.test(lock.manifestFingerprint || '') || fingerprint(manifest) !== lock.manifestFingerprint ||
        manifest.upstream?.commit !== catalog.UPSTREAM.commit || manifest.coreInterface !== 'NRExternalProviderV1' ||
        !Array.isArray(manifest.assets) || manifest.assets.length < 10 || manifest.assets.length > 128)
      fail('LEGACY_PACKAGE_UNTRUSTED', 'Feeder 0.15.1 配套清单缺失或身份校验不符。');
    const ids = new Set(), sources = new Set();
    for (const item of manifest.assets) {
      if (!/^[a-z0-9_.-]+$/.test(item.id || '') || ids.has(item.id) || !relative(item.source) || sources.has(item.source.toLowerCase()) ||
          !HASH.test(item.sha256 || '') || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > 512 * 1024 * 1024 ||
          !['x86', 'x64', null].includes(item.architecture) || typeof item.mutable !== 'boolean' || item.mutable && PE.test(item.source))
        fail('LEGACY_PACKAGE_UNTRUSTED', 'Feeder 组件清单无效。');
      ids.add(item.id); sources.add(item.source.toLowerCase());
    }
    return manifest;
  }
  function loadBundled(input) {
    const selection = catalog.resolve(input);
    if (selection.deliveryBlocked) fail('LEGACY_COMPONENT_DELIVERY_BLOCKED', selection.wrapper.reason);
    const manifest = pool(), files = [];
    const add = (id, base, target, role) => {
      const asset = manifest.assets.find(row => row.id === id);
      if (!asset || !BASES.includes(base) || !relative(target)) fail('LEGACY_COMPONENT_MISSING', 'Feeder 配套缺少匹配组件。', { id });
      files.push({ ...asset, base, target, role: role || asset.role });
    };
    const host = selection.hostRequired, provider = selection.gameApi === 'dx9' ? `provider-dx9-${selection.architecture}` : selection.architecture === 'x86' ? 'provider-x86' : selection.gameApi === 'dx10' ? 'provider-relay-x64' : 'provider-x64';
    if (selection.gameApi === 'dx9') {
      add(`shim-dx9-${selection.architecture}`, 'game', 'd3d9.dll', 'api-wrapper');
      add(`loader-${selection.architecture}`, 'runtime', selection.architecture === 'x86' ? 'ReShade32.dll' : 'ReShade64.dll', 'game-loader');
    } else if (selection.loadingBackend === 'local') add(`loader-${selection.architecture}`, 'game', `${selection.proxyEntry}.dll`, 'game-loader');
    add(provider, 'addon', selection.architecture === 'x86' ? 'dlss5-feed.addon32' : 'dlss5-feed.addon64', 'provider');
    const consumer = host ? 'host64/addons/' : '';
    if (host) {
      add('host-x64', 'addon', 'host64/dlss5-feed-host64.exe', 'host');
      add('loader-x64', 'addon', 'host64/dxgi.dll', 'host-loader');
    }
    add('core', 'addon', consumer + manifest.coreFileName, 'core');
    add('chain', 'addon', consumer + 'nrchain_nvngx.dll', 'chain');
    add(`runtime-${selection.hardwareFamily.toLowerCase()}`, 'addon', consumer + 'nvngx_dlssnr.dll', 'nr-runtime');
    add('core-config', 'addon', consumer + 'nr_before_sr.ini', 'core-config');
    add('preset', 'runtime', 'ReShadePreset.ini', 'preset');
    for (const asset of manifest.assets.filter(row => ['shader', 'texture', 'license'].includes(row.role)))
      add(asset.id, 'runtime', asset.target, asset.role);
    const seen = new Set();
    for (const item of files) {
      const key = `${item.base}/${item.target}`.toLowerCase();
      if (seen.has(key)) fail('LEGACY_PACKAGE_UNTRUSTED', 'Feeder 目标路径重复。'); seen.add(key);
    }
    const controlled = manifest.acceptance?.[`${selection.gameApi}-${selection.architecture}-${selection.hardwareFamily}-${selection.loadingBackend}-${selection.proxyEntry || 'profile'}`] || {};
    const recipe = { ...selection, schema: 2, id: selection.id, selection: { api: selection.gameApi, architecture: selection.architecture,
      hardwareFamily: selection.hardwareFamily, loadingBackend: selection.loadingBackend, proxyEntry: input.proxyEntry || 'auto' },
      coreVersion: manifest.coreVersion, coreVariant: manifest.coreVariant, poolFingerprint: lock.manifestFingerprint,
      acceptance: { compileLinkVerified: true, controlledRuntimeVerified: false, realGameVerified: false, ...controlled },
      files, defaults: DEFAULTS };
    return { root, recipe, fingerprint: fingerprint(recipe) };
  }
  function load(input = {}) {
    const selection = input?.selection || input;
    const providerId = input?.providerId || externalProviders.selectedId(selection);
    if (!providerId) return loadBundled(input);
    return externalProviders.load({ ...input, id: providerId, selection: input.selection || input });
  }
  function validate(recipe) {
    if (recipe?.externalProvider && recipe.externalProvider.schema === lock.externalProvider?.recipeSchema)
      return externalProviders.validateRecipe(recipe);
    if (!recipe || !recipe.selection) fail('LEGACY_RECEIPT_INVALID', 'Feeder 收据缺少固定配套选择。');
    // A newly selected external Provider must not reinterpret an existing
    // bundled receipt. Historical ownership and exact pinned recipes keep
    // validating against the bundled pool that created them.
    const current = loadBundled(recipe.selection);
    if (fingerprint(recipe) !== current.fingerprint) fail('LEGACY_RECEIPT_INVALID', 'Feeder 收据的组件、配置或版本身份已改变。');
    return recipe;
  }
  function validateStored(recipe) {
    if (recipe?.externalProvider && recipe.externalProvider.schema === lock.externalProvider?.recipeSchema)
      return externalProviders.validateRecipe(recipe);
    const hash = fingerprint(recipe);
    if (!lock.restorableRecipeFingerprints?.includes(hash)) return validate(recipe);
    if (recipe.schema !== 2 || !recipe.selection || !Array.isArray(recipe.files) || recipe.files.length < 8 || recipe.files.length > 128 ||
        recipe.files.some(item => !BASES.includes(item.base) || !relative(item.target) || !relative(item.source) ||
          !HASH.test(item.sha256 || '') || typeof item.mutable !== 'boolean' || item.mutable && PE.test(item.target)))
      fail('LEGACY_RECEIPT_INVALID', 'Feeder 历史收据结构无效。');
    return recipe;
  }
  async function verify(value) {
    const pkg = value?.recipe ? value : load(value);
    validateStored(pkg.recipe);
    const packageRoot = pkg.recipe.externalProvider ? externalProviders.root : pkg.root;
    await noLinks(packageRoot);
    const sources = {};
    for (const item of pkg.recipe.files) {
      let file = resolveFile(packageRoot, item.source);
      // Thin Manager packages share their NR runtime with the normal DLC. The
      // recipe still pins its exact family, byte count and hash; only that role
      // may resolve outside the fixed pool. Existing but altered pool files are
      // never hidden by a fallback, and no path is persisted into the recipe.
      if (!pkg.recipe.externalProvider && item.role === 'nr-runtime' && !fs.existsSync(file)) {
        const shared = typeof options.getCurrentRuntime === 'function' ? options.getCurrentRuntime() : options.currentRuntime;
        if (shared?.family === pkg.recipe.hardwareFamily && shared.sha256 === item.sha256 && shared.bytes === item.bytes &&
            options.componentLibraryRoot && relative(shared.file)) file = resolveFile(options.componentLibraryRoot, shared.file);
        else if (options.resourcesPath) file = resolveFile(path.join(options.resourcesPath, 'payload', 'nr-before-sr'),
          `fixed/${pkg.recipe.hardwareFamily}/nvngx_dlssnr.dll`);
      }
      if (await fileDigest(file) !== item.sha256 || fs.statSync(file).size !== item.bytes)
        fail('LEGACY_PACKAGE_HASH', 'Feeder 配套组件缺失或摘要不符。', { file: item.source });
      if (PE.test(item.source) && pe.getBitness(file) !== (item.architecture === 'x86' ? 32 : 64))
        fail('LEGACY_PACKAGE_ARCH', 'Feeder 配套组件位数与固定清单不符。', { file: item.source });
      sources[item.source] = file;
    }
    return { ...pkg, root: packageRoot, sources };
  }
  function adapterProbe() {
    const manifest = pool();
    const asset = manifest.assets.find(row => row.id === 'host-x64');
    if (manifest.protocols?.adapterEnumeration !== 1 || !asset || asset.architecture !== 'x64')
      fail('LEGACY_ADAPTER_ENUMERATION_UNAVAILABLE', '当前固定宿主尚不支持只读显卡枚举。');
    return Object.freeze({ file: resolveFile(root, asset.source), sha256: asset.sha256, args: Object.freeze(['--list-adapters-json']) });
  }
  return { load, verify, validate, validateStored, adapterProbe, externalProviders, lock, root, defaults: DEFAULTS };
}

module.exports = { DIRECTORY, RECEIPT, BASES, DEFAULTS, createLegacyRuntime };
