'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inside, atomicJson } = require('./launch-safety');
const { HASH, PE, relative, regularJson, fingerprint, fail } = require('./feeder-runtime');
const lock = require('./legacy-runtime-lock');

const CONTRACT = lock.externalProvider;
const MANIFEST_NAME = 'external-provider-package.json';
const APIS = Object.freeze(['dx9', 'dx10', 'dx11', 'dx12', 'vulkan']);
const ARCHITECTURES = Object.freeze(['x86', 'x64']);
const HARDWARE = Object.freeze(['RTX40', 'RTX50']);
const BACKENDS = Object.freeze(['local', 'hoyoshade', 'vulkan-profile']);
const BASES = Object.freeze(['game', 'runtime', 'addon']);
const RESERVED_ROLES = new Set(['core', 'core-chain', 'core-config', 'nr-runtime']);
const ID = /^[a-z0-9][a-z0-9._+-]{0,127}$/i;

function exactKeys(value, allowed, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key))) fail(code, message);
  return value;
}
function strings(value, allowed, code, message, { empty = false } = {}) {
  if (!Array.isArray(value) || (!empty && !value.length) || value.length > 32 ||
      new Set(value).size !== value.length || value.some(row => typeof row !== 'string' || !allowed.includes(row)))
    fail(code, message);
  return value;
}
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function copy(value) { return JSON.parse(JSON.stringify(value)); }

function createExternalProviderPackages(options = {}) {
  const requestedRoot = options.root || (options.userData && path.join(options.userData, 'component-library'));
  if (!requestedRoot) fail('EXTERNAL_PROVIDER_ROOT', '外部 Provider 需要明确的组件库存目录。');
  const root = path.resolve(requestedRoot);
  const inventoryFile = path.join(root, 'inventory.json');
  let queue = Promise.resolve();
  const contextValue = (name, supplied) => supplied || (typeof options[name] === 'function' ? options[name]() : options[name]);

  function inventory() {
    const data = regularJson(inventoryFile, 1024 * 1024);
    if (!data) return { schemaVersion: 1, packages: [], selected: {} };
    if (data.schemaVersion !== 1 || !Array.isArray(data.packages) || data.packages.length > 256 ||
        !data.selected || typeof data.selected !== 'object' || Array.isArray(data.selected) ||
        data.selected.externalProviders !== undefined &&
          (!data.selected.externalProviders || typeof data.selected.externalProviders !== 'object' || Array.isArray(data.selected.externalProviders) ||
           Object.keys(data.selected.externalProviders).length > APIS.length ||
           Object.entries(data.selected.externalProviders).some(([api, id]) => !APIS.includes(api) || !ID.test(id || ''))) ||
        data.selected.externalProviderRoutes !== undefined &&
          (!data.selected.externalProviderRoutes || typeof data.selected.externalProviderRoutes !== 'object' || Array.isArray(data.selected.externalProviderRoutes) ||
           Object.keys(data.selected.externalProviderRoutes).length > APIS.length * ARCHITECTURES.length * BACKENDS.length ||
           Object.entries(data.selected.externalProviderRoutes).some(([key, id]) => !/^(?:dx9|dx10|dx11|dx12|vulkan)\|(?:x86|x64)\|(?:local|hoyoshade|vulkan-profile)$/.test(key) || !ID.test(id || ''))))
      fail('EXTERNAL_PROVIDER_INVENTORY', '组件库存结构无效。');
    return data;
  }
  function providerRows(data = inventory()) {
    return data.packages.filter(row => row?.kind === 'feeder' &&
      row.files?.some(file => file?.name === MANIFEST_NAME));
  }
  function routeKey(selection) {
    const api = selection?.api, architecture = selection?.architecture, loadingBackend = selection?.loadingBackend || 'local';
    return APIS.includes(api) && ARCHITECTURES.includes(architecture) && BACKENDS.includes(loadingBackend)
      ? `${api}|${architecture}|${loadingBackend}` : null;
  }
  function selectedRoutes(data = inventory()) { return { ...(data.selected.externalProviderRoutes || {}) }; }
  function selectedByApi(data = inventory()) {
    const result = { ...(data.selected.externalProviders || {}) };
    const routes = selectedRoutes(data);
    for (const api of APIS) {
      const ids = [...new Set(Object.entries(routes).filter(([key]) => key.startsWith(`${api}|`)).map(([, id]) => id))];
      if (!result[api] && ids.length === 1) result[api] = ids[0];
    }
    const legacy = data.selected.externalProvider;
    if (ID.test(legacy || '')) {
      const row = providerRows(data).find(value => value.id === legacy);
      for (const api of Array.isArray(row?.gameApis) ? row.gameApis : [])
        if (APIS.includes(api) && !result[api]) result[api] = legacy;
    }
    return result;
  }
  function selectedFor(data, selection) {
    const routes = selectedRoutes(data), api = selection?.api, architecture = selection?.architecture;
    if (APIS.includes(api) && ARCHITECTURES.includes(architecture)) {
      if (selection.loadingBackend) {
        const exact = routeKey(selection);
        if (exact && routes[exact]) return routes[exact];
      } else {
        const ids = [...new Set(Object.entries(routes)
          .filter(([key]) => key.startsWith(`${api}|${architecture}|`)).map(([, id]) => id))];
        if (ids.length === 1) return ids[0];
        if (ids.length > 1) return null;
      }
      // Once an API has route-scoped selections, another architecture or
      // backend must not inherit a package through the old API-wide field.
      if (Object.keys(routes).some(key => key.startsWith(`${api}|`))) return null;
    }
    return data.selected.externalProviders?.[api] || (selectedByApi(data)[api] ?? null);
  }
  function inventoryFileRow(data, file, expectedSha, label) {
    const absolute = path.resolve(root, file || '');
    if (!inside(root, absolute)) fail('EXTERNAL_PROVIDER_SOURCE', `${label}不在组件库存中。`);
    const source = relative(path.relative(root, absolute));
    const found = data.packages.flatMap(row => Array.isArray(row.files) ? row.files : [])
      .find(row => row.file === source && row.sha256 === expectedSha);
    if (!found || !HASH.test(found.sha256 || '') || !Number.isSafeInteger(found.bytes) || found.bytes < 1)
      fail('EXTERNAL_PROVIDER_SOURCE', `${label}没有受库存摘要保护。`);
    return { ...found, source };
  }
  function packageFiles(data, row) {
    if (!ID.test(row?.id || '') || typeof row.version !== 'string' || !row.version || row.version.length > 100 ||
        !['x86', 'x64', 'mixed'].includes(row.architecture) || row.interface !== CONTRACT.interface ||
        !['catalog', 'user-imported'].includes(row.source) || !['candidate', 'blocked'].includes(row.validation) ||
        !Array.isArray(row.files) || !row.files.length || row.files.length > 128)
      fail('EXTERNAL_PROVIDER_PACKAGE', '外部 Provider 库存条目不完整。');
    const byName = new Map();
    for (const item of row.files) {
      const name = relative(item?.name), source = relative(item?.file);
      if (!name || !source || byName.has(name.toLowerCase()) || !HASH.test(item.sha256 || '') ||
          !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > 1024 * 1024 * 1024 ||
          !new RegExp(`^objects/${item.sha256}/[^/]+$`, 'i').test(source) || path.basename(source) !== path.basename(name))
        fail('EXTERNAL_PROVIDER_PACKAGE', '外部 Provider 文件索引无效。');
      byName.set(name.toLowerCase(), { ...item, name, source });
    }
    const definition = byName.get(MANIFEST_NAME);
    if (!definition || [...byName.keys()].filter(name => name === MANIFEST_NAME).length !== 1 || definition.bytes > 256 * 1024)
      fail('EXTERNAL_PROVIDER_PACKAGE', `外部 Provider 必须包含唯一 ${MANIFEST_NAME}。`);
    const file = path.resolve(root, definition.source);
    if (!inside(root, file)) fail('EXTERNAL_PROVIDER_SOURCE', 'Provider 清单路径越界。');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size !== definition.bytes)
      fail('EXTERNAL_PROVIDER_SOURCE', 'Provider 清单不是受保护的普通文件。');
    const bytes = fs.readFileSync(file);
    if (sha(bytes) !== definition.sha256) fail('EXTERNAL_PROVIDER_SOURCE', 'Provider 清单摘要不一致。');
    let manifest;
    try { manifest = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
    catch { fail('EXTERNAL_PROVIDER_SCHEMA', 'Provider 配套清单无法读取。'); }
    return { byName, manifest };
  }
  function validateManifest(manifest) {
    exactKeys(manifest, ['schema', 'interface', 'contract', 'defaults', 'routes'], 'EXTERNAL_PROVIDER_SCHEMA', 'Provider 配套清单字段无效。');
    if (manifest.schema !== CONTRACT.schema) fail('EXTERNAL_PROVIDER_SCHEMA', 'Provider 配套清单版本不受支持。');
    exactKeys(manifest.interface, ['name', 'version', 'requiredCoreCapabilities'], 'EXTERNAL_PROVIDER_SCHEMA', 'Provider 接口声明无效。');
    if (manifest.interface.name !== CONTRACT.interface || manifest.interface.version !== CONTRACT.version ||
        !Array.isArray(manifest.interface.requiredCoreCapabilities) || manifest.interface.requiredCoreCapabilities.length > 32 ||
        new Set(manifest.interface.requiredCoreCapabilities).size !== manifest.interface.requiredCoreCapabilities.length ||
        manifest.interface.requiredCoreCapabilities.some(value => !ID.test(value)))
      fail('EXTERNAL_PROVIDER_INTERFACE', 'Provider 不是版本化 NRExternalProviderV1 配套。');
    exactKeys(manifest.contract, ['provenance', 'scope', 'colorContract', 'srInjected', 'fgInjected'], 'EXTERNAL_PROVIDER_SCHEMA', 'Provider 图像契约无效。');
    if (!['Native', 'Synthetic'].includes(manifest.contract.provenance) || typeof manifest.contract.scope !== 'string' ||
        !manifest.contract.scope || manifest.contract.scope.length > 100 || typeof manifest.contract.colorContract !== 'string' ||
        !manifest.contract.colorContract || manifest.contract.colorContract.length > 300 ||
        typeof manifest.contract.srInjected !== 'boolean' || typeof manifest.contract.fgInjected !== 'boolean')
      fail('EXTERNAL_PROVIDER_SCHEMA', 'Provider 图像契约不完整。');
    exactKeys(manifest.defaults, ['definitions', 'hostGuides', 'feeder'], 'EXTERNAL_PROVIDER_SCHEMA', 'Provider 默认配置无效。');
    if (Object.values(manifest.defaults).some(value => typeof value !== 'string' || Buffer.byteLength(value) > 256 * 1024))
      fail('EXTERNAL_PROVIDER_SCHEMA', 'Provider 默认配置过大或缺失。');
    if (!Array.isArray(manifest.routes) || !manifest.routes.length || manifest.routes.length > 128)
      fail('EXTERNAL_PROVIDER_SCHEMA', 'Provider 配套没有可用路线。');
    const ids = new Set();
    for (const route of manifest.routes) {
      exactKeys(route, ['id', 'api', 'architecture', 'hardwareFamilies', 'loadingBackend', 'proxyEntries', 'hostRequired',
        'transport', 'relay', 'wrapper', 'coreDirectory', 'runtimeDirectory', 'files'], 'EXTERNAL_PROVIDER_SCHEMA', 'Provider 路线字段无效。');
      if (!ID.test(route.id || '') || ids.has(route.id) || !APIS.includes(route.api) || !ARCHITECTURES.includes(route.architecture) ||
          !BACKENDS.includes(route.loadingBackend) || typeof route.hostRequired !== 'boolean' || typeof route.transport !== 'string' ||
          !route.transport || route.transport.length > 100 || !relative(route.coreDirectory || '_') || !relative(route.runtimeDirectory || '_'))
        fail('EXTERNAL_PROVIDER_ROUTE', 'Provider 路线身份无效。');
      ids.add(route.id);
      strings(route.hardwareFamilies, HARDWARE, 'EXTERNAL_PROVIDER_ROUTE', 'Provider 显卡范围无效。');
      if (!Array.isArray(route.proxyEntries) || route.proxyEntries.length > 16 || new Set(route.proxyEntries).size !== route.proxyEntries.length ||
          route.proxyEntries.some(value => typeof value !== 'string' || !/^(?:auto|d3d9|dxgi|d3d11|d3d12)$/.test(value)))
        fail('EXTERNAL_PROVIDER_ROUTE', 'Provider 加载入口无效。');
      if ((route.relay !== null && route.relay !== undefined && (typeof route.relay !== 'string' || route.relay.length > 100)) ||
          (route.wrapper !== null && route.wrapper !== undefined && (typeof route.wrapper !== 'object' || Array.isArray(route.wrapper))))
        fail('EXTERNAL_PROVIDER_ROUTE', 'Provider 转换路线声明无效。');
      if (route.wrapper) {
        exactKeys(route.wrapper, ['id', 'version', 'outputApi', 'entry', 'systemRuntime', 'privateRuntimeBundled', 'minimumWindows'],
          'EXTERNAL_PROVIDER_ROUTE', 'Provider 包装器声明无效。');
        if (!ID.test(route.wrapper.id || '') || typeof route.wrapper.version !== 'string' || !route.wrapper.version ||
            route.wrapper.version.length > 100 || route.wrapper.outputApi !== 'dx12' || !relative(route.wrapper.entry) ||
            typeof route.wrapper.systemRuntime !== 'boolean' || typeof route.wrapper.privateRuntimeBundled !== 'boolean' ||
            typeof route.wrapper.minimumWindows !== 'string' || route.wrapper.minimumWindows.length > 200)
          fail('EXTERNAL_PROVIDER_ROUTE', 'Provider 包装器声明无效。');
      }
      if (!Array.isArray(route.files) || !route.files.length || route.files.length > 128)
        fail('EXTERNAL_PROVIDER_ROUTE', 'Provider 路线没有运输文件。');
      const targets = new Set(); let providers = 0;
      for (const item of route.files) {
        exactKeys(item, ['role', 'file', 'base', 'target', 'architecture', 'mutable'], 'EXTERNAL_PROVIDER_SCHEMA', 'Provider 文件角色字段无效。');
        const file = relative(item.file), target = relative(item.target);
        if (!ID.test(item.role || '') || RESERVED_ROLES.has(item.role) || !file || !target || !BASES.includes(item.base) ||
            ![...ARCHITECTURES, null].includes(item.architecture) || typeof item.mutable !== 'boolean' ||
            (PE.test(target) && !ARCHITECTURES.includes(item.architecture)) || (item.mutable && PE.test(target)) ||
            targets.has(`${item.base}/${target}`.toLowerCase()))
          fail('EXTERNAL_PROVIDER_ROUTE', 'Provider 文件角色、路径或可变性无效。');
        targets.add(`${item.base}/${target}`.toLowerCase());
        if (item.role === 'provider') providers++;
      }
      if (providers !== 1) fail('EXTERNAL_PROVIDER_ROUTE', '每条 Provider 路线必须声明唯一运输 Provider。');
    }
    return manifest;
  }
  function definition(data, row) {
    const { byName, manifest } = packageFiles(data, row);
    validateManifest(manifest);
    for (const route of manifest.routes) for (const item of route.files)
      if (!byName.has(item.file.toLowerCase())) fail('EXTERNAL_PROVIDER_ROUTE', `Provider 路线缺少文件 ${item.file}。`);
    return { row, byName, manifest };
  }
  function interfaceMatch(currentCore, requirement) {
    const declared = Array.isArray(currentCore?.inputInterfaces) ? currentCore.inputInterfaces : [];
    const accepts = declared.some(value => value === requirement.name || value && typeof value === 'object' &&
      value.name === requirement.name && value.version === requirement.version);
    const capabilities = new Set(Array.isArray(currentCore?.capabilities) ? currentCore.capabilities : []);
    return accepts && requirement.requiredCoreCapabilities.every(value => capabilities.has(value));
  }
  function coreSources(data, currentCore, requirement) {
    if (!currentCore || !ID.test(currentCore.id || '') || typeof currentCore.version !== 'string' || !currentCore.version ||
        currentCore.version.length > 100 || currentCore.architecture !== 'x64' || !HASH.test(currentCore.sha256 || '') ||
        !interfaceMatch(currentCore, requirement))
      fail('EXTERNAL_PROVIDER_CORE_INCOMPATIBLE', '当前 Core 未声明这套 NRExternalProviderV1 能力，未回退到旧 Core。');
    if (!Array.isArray(currentCore.companions) || currentCore.companions.length !== 1)
      fail('EXTERNAL_PROVIDER_CORE_INCOMPATIBLE', '当前 Core 缺少唯一同源 nrchain_nvngx.dll。');
    const companion = currentCore.companions[0];
    if (!companion || companion.role !== 'core-chain' || companion.name !== 'nrchain_nvngx.dll' ||
        !relative(companion.file) || !HASH.test(companion.sha256 || '') ||
        !Number.isSafeInteger(companion.bytes) || companion.bytes < 1)
      fail('EXTERNAL_PROVIDER_CORE_INCOMPATIBLE', '当前 Core 的同源 NR chain 身份无效。');
    const config = currentCore.config;
    if (!config || config.role !== 'core-config' || config.name !== 'nr_before_sr.ini' ||
        !relative(config.file) || !HASH.test(config.sha256 || '') ||
        !Number.isSafeInteger(config.bytes) || config.bytes < 1)
      fail('EXTERNAL_PROVIDER_CORE_INCOMPATIBLE', '当前 Core 缺少同版本 nr_before_sr.ini。');
    const core = inventoryFileRow(data, currentCore.file, currentCore.sha256, '当前 Core');
    const chain = inventoryFileRow(data, companion.file, companion.sha256, '当前 Core NR chain');
    const configSource = inventoryFileRow(data, config.file, config.sha256, '当前 Core 配置');
    if (!/\.addon64$/i.test(core.name) || chain.name !== companion.name || chain.bytes !== companion.bytes ||
        !/\.dll$/i.test(chain.name) || configSource.name !== config.name || configSource.bytes !== config.bytes)
      fail('EXTERNAL_PROVIDER_SOURCE', '当前 Core、同源 NR chain 或配置文件身份无效。');
    return { core, chain, config: configSource };
  }
  function sourceContext(data, currentCore, currentRuntime, route, requirement) {
    const { core, chain, config } = coreSources(data, currentCore, requirement);
    if (!currentRuntime || !HASH.test(currentRuntime.sha256 || '') || !Number.isSafeInteger(currentRuntime.bytes) ||
        currentRuntime.bytes < 1 || !route.hardwareFamilies.includes(currentRuntime.family))
      fail('EXTERNAL_PROVIDER_RUNTIME_INCOMPATIBLE', '当前共享 NR Runtime 与所选路线或显卡系列不匹配。');
    const runtime = inventoryFileRow(data, currentRuntime.file, currentRuntime.sha256, '当前 NR Runtime');
    if (!/\.dll$/i.test(runtime.name) || runtime.bytes !== currentRuntime.bytes)
      fail('EXTERNAL_PROVIDER_SOURCE', '当前 NR Runtime 文件身份无效。');
    return { core, chain, config, runtime };
  }
  function routeFor(manifest, selection) {
    const proxy = selection.proxyEntry || 'auto';
    const route = manifest.routes.find(value => (!selection.routeId || value.id === selection.routeId) &&
      value.api === selection.api && value.architecture === selection.architecture &&
      value.loadingBackend === (selection.loadingBackend || 'local') && value.hardwareFamilies.includes(selection.hardwareFamily) &&
      (!value.proxyEntries.length || value.proxyEntries.includes(proxy)));
    if (!route) fail('EXTERNAL_PROVIDER_ROUTE_UNAVAILABLE', '所选 Provider 没有匹配 API、位数、显卡与加载方式的路线。');
    return route;
  }
  function build(data, row, selection, supplied = {}) {
    if (row.validation === 'blocked') fail('EXTERNAL_PROVIDER_BLOCKED', '所选 Provider 配套已被标记为阻止使用。');
    const item = definition(data, row), route = routeFor(item.manifest, selection), proxy = selection.proxyEntry || 'auto';
    const currentCore = contextValue('currentCore', supplied.currentCore);
    const currentRuntime = contextValue('currentRuntime', supplied.currentRuntime);
    const injected = sourceContext(data, currentCore, currentRuntime, route, item.manifest.interface);
    const files = route.files.map((spec, index) => {
      const file = item.byName.get(spec.file.toLowerCase());
      return { id: `${row.id}:${route.id}:${index}`, source: file.source, role: spec.role, base: spec.base, target: spec.target,
        architecture: spec.architecture, mutable: spec.mutable, sha256: file.sha256, bytes: file.bytes };
    });
    const directory = value => value === '' ? '' : `${relative(value)}/`;
    files.push({ id: `${row.id}:current-core`, source: injected.core.source, role: 'core', base: 'addon',
      target: `${directory(route.coreDirectory)}${path.basename(injected.core.name)}`, architecture: 'x64', mutable: false,
      sha256: injected.core.sha256, bytes: injected.core.bytes });
    files.push({ id: `${row.id}:current-core-chain`, source: injected.chain.source, role: 'core-chain', base: 'addon',
      target: `${directory(route.coreDirectory)}${injected.chain.name}`, architecture: 'x64', mutable: false,
      sha256: injected.chain.sha256, bytes: injected.chain.bytes });
    files.push({ id: `${row.id}:current-core-config`, source: injected.config.source, role: 'core-config', base: 'addon',
      target: `${directory(route.coreDirectory)}${injected.config.name}`, architecture: null, mutable: true,
      sha256: injected.config.sha256, bytes: injected.config.bytes });
    files.push({ id: `${row.id}:current-runtime`, source: injected.runtime.source, role: 'nr-runtime', base: 'addon',
      target: `${directory(route.runtimeDirectory)}nvngx_dlssnr.dll`, architecture: 'x64', mutable: false,
      sha256: injected.runtime.sha256, bytes: injected.runtime.bytes });
    const targets = new Set();
    for (const file of files) {
      const key = `${file.base}/${file.target}`.toLowerCase();
      if (targets.has(key)) fail('EXTERNAL_PROVIDER_ROUTE', 'Provider 注入后的目标文件发生冲突。');
      targets.add(key);
    }
    const proxyEntry = route.api === 'vulkan' || route.loadingBackend === 'hoyoshade' || route.loadingBackend === 'vulkan-profile' ? null :
      proxy === 'auto' ? route.api === 'dx9' ? 'd3d9' : 'dxgi' : proxy;
    const recipe = {
      schema: 3, id: row.id, providerPackageId: row.id, providerRouteId: route.id,
      selection: { api: route.api, architecture: route.architecture, hardwareFamily: selection.hardwareFamily,
        loadingBackend: route.loadingBackend, proxyEntry: proxy },
      route: 'external-provider', api: route.api, gameApi: route.api, renderApi: route.api,
      architecture: route.architecture, hardwareFamily: selection.hardwareFamily, loadingBackend: route.loadingBackend,
      proxyEntry, proxyEntries: route.proxyEntries, hostRequired: route.hostRequired, transport: route.transport,
      relay: route.relay || null, wrapper: route.wrapper || null, deliveryBlocked: false,
      upstream: { packageId: row.id, version: row.version, source: row.source },
      coreInterface: CONTRACT.interface, coreInterfaceVersion: CONTRACT.version,
      coreVersion: currentCore.version, coreVariant: { requiredInterface: CONTRACT.interface, interfaceVersion: CONTRACT.version,
        requiredCapabilities: [...item.manifest.interface.requiredCoreCapabilities], genericCoreInterchangeable: true,
        selected: { id: currentCore.id, sha256: currentCore.sha256,
          companions: [{ role: 'core-chain', name: injected.chain.name, source: injected.chain.source,
            sha256: injected.chain.sha256, bytes: injected.chain.bytes }],
          config: { role: 'core-config', name: injected.config.name, source: injected.config.source,
            sha256: injected.config.sha256, bytes: injected.config.bytes } } },
      provenance: item.manifest.contract.provenance, scope: item.manifest.contract.scope,
      colorContract: item.manifest.contract.colorContract, srInjected: item.manifest.contract.srInjected,
      fgInjected: item.manifest.contract.fgInjected, acceptance: { status: 'candidate', fileVerified: false,
        controlledRuntimeVerified: false, realGameVerified: false },
      files, defaults: copy(item.manifest.defaults), externalProvider: { schema: CONTRACT.recipeSchema, packageId: row.id,
        routeId: route.id, definition: { source: item.byName.get(MANIFEST_NAME).source,
          sha256: item.byName.get(MANIFEST_NAME).sha256, bytes: item.byName.get(MANIFEST_NAME).bytes },
        validation: 'candidate', runtimeVerified: false }
    };
    return { root, recipe, fingerprint: fingerprint(recipe) };
  }
  function load(input = {}) {
    const data = inventory(), selection = input.selection || input;
    const selected = input.id || input.providerId || (selection.api || input.gameApi
      ? selectedFor(data, { ...selection, api: selection.api || input.gameApi }) : data.selected.externalProvider);
    if (!selected) fail('EXTERNAL_PROVIDER_NOT_SELECTED', '尚未选择外部 Provider 配套。');
    const row = providerRows(data).find(value => value.id === selected);
    if (!row) fail('EXTERNAL_PROVIDER_SELECTION_INVALID', '已选 Provider 不在组件库存中，未回退到旧 Core。');
    return build(data, row, input.selection || input, input);
  }
  function validateRecipe(recipe) {
    if (!recipe || recipe.schema !== 3 || recipe.externalProvider?.schema !== CONTRACT.recipeSchema ||
        recipe.coreInterface !== CONTRACT.interface || recipe.coreInterfaceVersion !== CONTRACT.version ||
        !ID.test(recipe.providerPackageId || '') || recipe.id !== recipe.providerPackageId || !ID.test(recipe.providerRouteId || '') ||
        !recipe.selection || !APIS.includes(recipe.gameApi) || !ARCHITECTURES.includes(recipe.architecture) ||
        !HARDWARE.includes(recipe.hardwareFamily) || !BACKENDS.includes(recipe.loadingBackend) ||
        recipe.acceptance?.status !== 'candidate' || recipe.externalProvider.runtimeVerified !== false ||
        !relative(recipe.externalProvider.definition?.source) || !HASH.test(recipe.externalProvider.definition?.sha256 || '') ||
        !Number.isSafeInteger(recipe.externalProvider.definition?.bytes) || recipe.externalProvider.definition.bytes < 1 ||
        !Array.isArray(recipe.files) || recipe.files.length < 5 || recipe.files.length > 132 ||
        recipe.files.filter(row => row.role === 'core').length !== 1 || recipe.files.filter(row => row.role === 'nr-runtime').length !== 1 ||
        recipe.files.filter(row => row.role === 'core-chain').length !== 1 || recipe.files.filter(row => row.role === 'core-config').length !== 1 ||
        recipe.files.some(row => !BASES.includes(row.base) || !relative(row.source) || !relative(row.target) || !HASH.test(row.sha256 || '') ||
          !Number.isSafeInteger(row.bytes) || row.bytes < 1 || typeof row.mutable !== 'boolean' || row.mutable && PE.test(row.target)))
      fail('EXTERNAL_PROVIDER_RECEIPT', '外部 Provider 收据配套结构无效。');
    const data = inventory(), row = providerRows(data).find(value => value.id === recipe.providerPackageId);
    if (!row) fail('EXTERNAL_PROVIDER_RECEIPT', '外部 Provider 原配套已不在库存中，未改装其他版本。');
    const definitionRow = row.files.find(value => value.name === MANIFEST_NAME);
    if (!definitionRow || definitionRow.file !== recipe.externalProvider.definition.source ||
        definitionRow.sha256 !== recipe.externalProvider.definition.sha256 || definitionRow.bytes !== recipe.externalProvider.definition.bytes)
      fail('EXTERNAL_PROVIDER_RECEIPT', '外部 Provider 清单身份已改变。');
    const core = recipe.files.find(value => value.role === 'core');
    const chain = recipe.files.find(value => value.role === 'core-chain');
    const config = recipe.files.find(value => value.role === 'core-config');
    const runtime = recipe.files.find(value => value.role === 'nr-runtime');
    const companion = recipe.coreVariant?.selected?.companions;
    if (!Array.isArray(companion) || companion.length !== 1 || companion[0]?.role !== 'core-chain' ||
        companion[0].name !== 'nrchain_nvngx.dll' || companion[0].source !== chain.source ||
        companion[0].sha256 !== chain.sha256 || companion[0].bytes !== chain.bytes)
      fail('EXTERNAL_PROVIDER_RECEIPT', '外部 Provider 收据的 Core NR chain 身份无效。');
    const selectedConfig = recipe.coreVariant?.selected?.config;
    if (!selectedConfig || selectedConfig.role !== 'core-config' || selectedConfig.name !== 'nr_before_sr.ini' ||
        selectedConfig.source !== config.source || selectedConfig.sha256 !== config.sha256 || selectedConfig.bytes !== config.bytes)
      fail('EXTERNAL_PROVIDER_RECEIPT', '外部 Provider 收据的 Core 配置身份无效。');
    const expected = build(data, { ...row, validation: 'candidate' }, { ...recipe.selection, routeId: recipe.providerRouteId }, {
      currentCore: { id: recipe.coreVariant?.selected?.id, version: recipe.coreVersion, file: core.source,
        sha256: core.sha256, architecture: 'x64', inputInterfaces: [CONTRACT.interface],
        capabilities: recipe.coreVariant?.requiredCapabilities,
        companions: [{ role: 'core-chain', name: companion[0].name, file: companion[0].source,
          sha256: companion[0].sha256, bytes: companion[0].bytes }],
        config: { role: 'core-config', name: selectedConfig.name, file: selectedConfig.source,
          sha256: selectedConfig.sha256, bytes: selectedConfig.bytes } },
      currentRuntime: { file: runtime.source, sha256: runtime.sha256, bytes: runtime.bytes, family: recipe.hardwareFamily }
    }).recipe;
    if (fingerprint(expected) !== fingerprint(recipe))
      fail('EXTERNAL_PROVIDER_RECEIPT', '外部 Provider 收据与已认可 schema 或库存文件不一致。');
    return recipe;
  }
  function inspect(supplied = {}) {
    const data = inventory(), selections = selectedByApi(data), routeSelections = selectedRoutes(data);
    const selectedId = data.selected.externalProvider || Object.values(selections)[0] || null;
    const packages = providerRows(data).map(row => {
      try {
        const item = definition(data, row), core = contextValue('currentCore', supplied.currentCore);
        let compatible = false;
        if (core) { coreSources(data, core, item.manifest.interface); compatible = true; }
        const selectedRouteKeys = Object.keys(routeSelections).filter(key => routeSelections[key] === row.id);
        const selectedApis = [...new Set([...APIS.filter(api => selections[api] === row.id), ...selectedRouteKeys.map(key => key.split('|')[0])])];
        return { id: row.id, version: row.version, source: row.source, validation: row.validation,
          interface: CONTRACT.interface, interfaceVersion: CONTRACT.version,
          requiredCoreCapabilities: [...item.manifest.interface.requiredCoreCapabilities],
          gameApis: [...new Set(item.manifest.routes.map(route => route.api))], routes: item.manifest.routes.length,
          routeDescriptors: item.manifest.routes.map(route => ({ id: route.id, api: route.api,
            architecture: route.architecture, hardwareFamilies: [...route.hardwareFamilies],
            loadingBackend: route.loadingBackend, proxyEntries: [...route.proxyEntries],
            hostRequired: route.hostRequired, transport: route.transport, selectionKey: routeKey(route) })),
          selected: selectedApis.length > 0, selectedApis, selectedRouteKeys, compatible, selectable: row.validation !== 'blocked' && compatible,
          runtimeVerified: false, reason: row.validation === 'blocked' ? '配套已被标记为阻止使用。' :
            compatible ? null : '当前 Core 未声明所需 NRExternalProviderV1 能力。' };
      } catch (error) {
        const selectedRouteKeys = Object.keys(routeSelections).filter(key => routeSelections[key] === row?.id);
        const selectedApis = [...new Set([...APIS.filter(api => selections[api] === row?.id), ...selectedRouteKeys.map(key => key.split('|')[0])])];
        return { id: row?.id || null, version: row?.version || null, selected: selectedApis.length > 0, selectedApis, selectedRouteKeys,
          compatible: false, selectable: false, runtimeVerified: false, reason: error.message, code: error.code };
      }
    });
    const selectedIds = [...new Set([...Object.values(selections), ...Object.values(routeSelections), data.selected.externalProvider].filter(value => ID.test(value || '')))];
    const missing = selectedIds.filter(id => !packages.some(row => row.id === id));
    return { root, selectedId, selectedByApi: selections, selectedByRoute: routeSelections, packages, ready: missing.length === 0, runtimeVerified: false,
      reason: missing.length ? '已选 Provider 不在组件库存中，未回退到旧 Core。' : null };
  }
  async function select(id, supplied = {}) {
    const task = queue.then(async () => {
      const data = inventory();
      if (id === null) {
        delete data.selected.externalProvider;
        delete data.selected.externalProviders;
        delete data.selected.externalProviderRoutes;
      }
      else {
        const row = providerRows(data).find(value => value.id === id);
        if (!row) fail('EXTERNAL_PROVIDER_SELECTION_INVALID', '所选 Provider 不在组件库存中。');
        const item = definition(data, row), core = contextValue('currentCore', supplied.currentCore);
        if (row.validation === 'blocked') fail('EXTERNAL_PROVIDER_BLOCKED', '所选 Provider 配套已被标记为阻止使用。');
        coreSources(data, core, item.manifest.interface);
        const selections = selectedRoutes(data);
        for (const route of item.manifest.routes) {
          const key = routeKey(route);
          if (supplied.onlyUnselected !== true || !selections[key]) selections[key] = id;
        }
        data.selected.externalProviderRoutes = selections;
        if (!ID.test(data.selected.externalProvider || '')) data.selected.externalProvider = id;
      }
      await atomicJson(inventoryFile, data);
      return { selectedId: id, selectedByApi: selectedByApi(data), selectedByRoute: selectedRoutes(data), changedGames: false, runtimeVerified: false };
    });
    queue = task.catch(() => {});
    return task;
  }
  function selectedId(selection) {
    const data = inventory();
    if (selection && typeof selection === 'object') return selectedFor(data, selection);
    return selection ? selectedByApi(data)[selection] || null : data.selected.externalProvider || Object.values(selectedByApi(data))[0] || null;
  }

  return Object.freeze({ root, inspect, select, load, validateRecipe, selectedId });
}

module.exports = { createExternalProviderPackages, MANIFEST_NAME, APIS, ARCHITECTURES, HARDWARE, BACKENDS };
