'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fixture, peBytes, put, sha } = require('./operation-integration-fixture');
const { createVulkanService } = require('../../src/product/vulkan-service');
const { createFeederService } = require('../../src/product/feeder-service');
const { createFeederRuntime, fingerprint, DIRECTORY } = require('../../src/product/feeder-runtime');

const broker = { inspect: async () => ({ elevated: false, launchable: true }), launch: async () => { throw new Error('integration tests never launch a game'); } };
async function specialFixture(t, route) {
  return fixture(t, { api: route === 'vulkan' ? 'vulkan' : 'dx12', family: 'RTX50', noDlss: route === 'feeder',
    specialSetup: async ({ root, userData, resourcesPath, hardware, guards, pe }) => {
      if (route === 'vulkan') {
        const runtimeRoot = path.join(resourcesPath, 'vulkan-runtime'), layerRoot = path.join(resourcesPath, 'vulkan-reshade');
        const items = [['addons/core.addon64', peBytes('fixed Vulkan Core'), false], ['addons/nr_before_sr.ini', '[NRBeforeSR]\nIntensity=1\n', true],
          ['ReShade.ini', '[ADDON]\nAddonPath=addons\n[GENERAL]\nPresetPath=ReShadePreset.ini\n', true], ['ReShadePreset.ini', 'Techniques=\n', true]];
        const recipe = { version: 1, id: 'fixture-vulkan-fixed', coreVersion: 'fixture-core-vulkan', sourceRevision: 'e7df0fc', architecture: 64,
          acceptance: { status: 'processed', hardwareFamily: 'RTX50' }, files: items.map(([name, data, mutable]) => {
            put(path.join(runtimeRoot, name), data); return { source: name, target: name, sha256: sha(data), mutable };
          }) };
        put(path.join(runtimeRoot, 'recipe.json'), JSON.stringify(recipe));
        const manifest = JSON.stringify({ file_format_version: '1.2.0', layer: { name: 'VK_LAYER_reshade', type: 'GLOBAL', library_path: '.\\ReShade64.dll', disable_environment: { DISABLE_RESHADER: '1' } } });
        const dll = peBytes('Vulkan ReShade layer'); put(path.join(layerRoot, 'ReShade64.json'), manifest); put(path.join(layerRoot, 'ReShade64.dll'), dll);
        put(path.join(layerRoot, 'recipe.json'), JSON.stringify({ version: 1, id: 'fixture-vulkan-layer', release: '6.8.0', architecture: 64,
          layer: { manifest: 'ReShade64.json', library: 'ReShade64.dll', manifestSha256: sha(manifest), librarySha256: sha(dll), name: 'VK_LAYER_reshade' },
          activation: { interface: 'reshade-ini-v1' } }));
        const values = new Map(), writes = [], control = { failRegistryOnce: false };
        const registry = { identity: { scope: 'HKCU', view: '64', key: 'Software\\Khronos\\Vulkan\\ImplicitLayers' },
          async read(name) { return structuredClone(values.get(name.toLowerCase()) || { exists: false }); },
          async list() { return [...values].map(([name, row]) => ({ name, ...row })); }, async listMachine() { return []; },
          async write(name, expected, desired) { assert.deepEqual(await this.read(name), expected); writes.push({ name, desired });
            if (desired.exists) values.set(name.toLowerCase(), structuredClone(desired)); else values.delete(name.toLowerCase());
            if (control.failRegistryOnce) { control.failRegistryOnce = false; throw Object.assign(new Error('fixture registry reply lost after write'), { code: 'EACCES' }); } } };
        const service = createVulkanService({ userData, appDir: root, resourcesPath, hardware, overrides: { guards, pe, broker, registry, executionLevel: () => 'asInvoker' } });
        return { overrides: { vulkan: service }, owner: service, packageId: recipe.id, version: recipe.coreVersion, registry: values, writes, control };
      }
      const packageRoot = path.join(resourcesPath, 'feeder-runtime');
      const items = [
        ['dxgi.dll', 'loader', false, peBytes('ReShade Searching for add-ons')],
        [`${DIRECTORY}/addons/core.addon64`, 'core', false, peBytes('fixed Feeder Core')],
        [`${DIRECTORY}/addons/provider.addon64`, 'provider', false, peBytes('fixed Feeder provider')],
        [`${DIRECTORY}/addons/nrchain_nvngx.dll`, 'chain', false, peBytes('fixed Feeder chain')],
        [`${DIRECTORY}/addons/nvngx_dlssnr.dll`, 'nr-runtime', false, peBytes('fixed Feeder NR runtime')],
        [`${DIRECTORY}/addons/nr_before_sr.ini`, 'core-config', true, '[NRBeforeSR]\nEnabled=1\nIntensity=1.2\nR8OutputEncoding=2\n'],
        [`${DIRECTORY}/addons/dlss5-feed.cfg`, 'feeder-config', true, 'enabled=1\nmode=2\n'],
        [`${DIRECTORY}/ReShadePreset.ini`, 'preset', true, 'Techniques=motion,feed\n'],
        [`${DIRECTORY}/reshade-shaders/Shaders/Feed.fx`, 'shader', false, 'fixture shader source'],
        [`${DIRECTORY}/reshade-shaders/Textures/noise.png`, 'shader', false, 'fixture texture'],
        ['ReShade.ini', 'reshade-config', true, `[GENERAL]\nEffectSearchPaths=.\\${DIRECTORY}\\reshade-shaders\\Shaders\\**\nTextureSearchPaths=.\\${DIRECTORY}\\reshade-shaders\\Textures\\**\nPresetPath=.\\${DIRECTORY}\\ReShadePreset.ini\n[ADDON]\nAddonPath=.\\${DIRECTORY}\\addons\n`]
      ];
      const recipe = { version: 1, id: 'nr-feeder-dx12-047-sdr-20260909', route: 'feeder-dx12', api: 'dx12', architecture: 64, hardwareFamily: 'RTX50',
        coreVersion: '0.4.7beta', provenance: 'Synthetic', scope: 'post-process', colorContract: 'rgba8-srgb-confirmed',
        acceptance: { status: 'candidate', realGameVerified: false }, files: items.map(([name, role, mutable, content]) => {
          const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content); put(path.join(packageRoot, name), bytes);
          return { source: name, target: name, role, mutable, bytes: bytes.length, sha256: sha(bytes) };
        }) };
      put(path.join(packageRoot, 'recipe.json'), JSON.stringify(recipe));
      const runtime = createFeederRuntime({ appDir: root, resourcesPath, pe, lock: { id: recipe.id, recipeFingerprint: fingerprint(recipe) } });
      const control = { failCopyOnce: false };
      const service = createFeederService({ userData, appDir: root, resourcesPath, hardware,
        overrides: { guards, pe, broker, runtime, executionLevel: () => 'asInvoker', async copyFile(...args) {
          await fsp.copyFile(...args);
          if (control.failCopyOnce) { control.failCopyOnce = false; throw Object.assign(new Error('fixture process exit after Feeder copy'), { preservePending: true }); }
        } } });
      return { overrides: { feeder: service }, owner: service, packageId: recipe.id, version: recipe.coreVersion, control };
    }
  });
}
module.exports = { specialFixture };
