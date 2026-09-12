'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createAppService } = require('../../src/product/app-service');
const { createInstaller } = require('../../src/product/installer');
const { createCompactBundle } = require('../../src/product/payload');
const { readManifest } = require('../../src/product/manifest');
const { PAYLOAD_FILES, INSTALLED_NAMES, DX11_COMPAT_CARRIER } = require('../../src/product/constants');
const { createOperationPlans } = require('../../src/product/operation-plan');
const { createLaunchSettingsService } = require('../../src/product/launch-settings-service');
const { createFgComponents } = require('../../src/product/fg-components');
const { createFgWorkflow } = require('../../src/product/fg-workflow');
const { createLaunchCoordinator } = require('../../src/product/launch-coordinator');
const { enhancementEvidence } = require('./enhancement-evidence');
const policy = require('../../src/product/launch-settings-policy');
const pe = require('../../src/core/pe');

const PROJECT = path.resolve(__dirname, '../..');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const hashFile = file => fs.existsSync(file) ? sha(fs.readFileSync(file)) : null;
function peBytes(label = '') {
  const bytes = Buffer.alloc(1024); bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(128, 60);
  bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(0x8664, 132); bytes.writeUInt16LE(0xf0, 148);
  bytes.writeUInt16LE(1, 134); // A real section count lets the read-only launch-level parser validate this inert fixture.
  bytes.writeUInt16LE(0x20b, 152); bytes.write(label, 512, 'utf8'); return bytes;
}
function put(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
function createPayload(root) {
  const folder = path.join(root, 'resources/payload/nr-before-sr');
  for (const family of ['RTX40', 'RTX50']) for (const name of ['ReShade64.dll', 'nrchain_nvngx.dll', 'nvngx_dlssnr.dll'])
    put(path.join(folder, 'fixed', family, name), peBytes(name === 'ReShade64.dll' ? 'ReShade Searching for add-ons' : family + ':' + name));
  for (const version of ['fixture-core-1', 'fixture-core-2']) {
    const dir = path.join(folder, 'versions', version);
    put(path.join(dir, PAYLOAD_FILES.addon), peBytes(version + ':Core'));
    put(path.join(dir, PAYLOAD_FILES.config), '[NRBeforeSR]\r\nEnabled=1\r\nIntensity=1\r\n');
    put(path.join(dir, PAYLOAD_FILES.bridge), peBytes('same chain'));
    put(path.join(dir, DX11_COMPAT_CARRIER), peBytes('same DX11 carrier'));
  }
  const entries = ['fixture-core-1', 'fixture-core-2'].map(id => ({ id, label: id, compatibility: 'dx11' }));
  put(path.join(folder, 'bundle.json'), JSON.stringify(createCompactBundle(folder, entries, entries[0].id)));
  return folder;
}
function driverFixture(events) {
  const absent = () => ({ kind: 'absent', value: null, location: null, predefined: null });
  let state = { profile: null, settings: Object.fromEntries([...policy.IDS.sr, ...policy.IDS.fg].map(id => [id, absent()])) };
  let failure = null;
  return {
    async read() { return structuredClone(state); }, peek() { return structuredClone(state); },
    failOnce() { failure = Object.assign(new Error('fixture NVAPI response lost after the write'), { code: 'NVAPI_READBACK_MISMATCH' }); },
    async write(exe, before, after) {
      assert.deepEqual(state, before, 'the driver fixture enforces the full production compare-and-set contract');
      events.push('driver-write'); state = structuredClone(after);
      if (!state.profile && Object.values(state.settings).some(row => row.kind === 'explicit'))
        state.profile = { name: 'fixture-only profile', appName: exe, exclusive: true, owned: true };
      if (failure) { const error = failure; failure = null; throw error; }
      return structuredClone(state);
    }
  };
}
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-op-int-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const gameRoot = path.join(root, 'game'), exeDir = path.join(gameRoot, 'bin'), exe = path.join(exeDir, options.exeName || 'Game.exe');
  const userData = path.join(root, 'user'), resourcesPath = path.join(root, 'resources');
  put(exe, peBytes('temporary test executable; never launched'));
  put(path.join(exeDir, 'nvngx_dlss.dll'), peBytes('original native DLSS'));
  put(path.join(exeDir, 'nvngx_dlssg.dll'), peBytes('original native DLSS-G'));
  put(path.join(exeDir, 'unknown.dll.bak'), 'unrelated backup');
  const payload = createPayload(root), id = 'fixture-game', events = [];
  const guards = { assertGameClosed: async () => {}, antiCheatPresent: () => false };
  const family = options.family || 'RTX50', hardware = { family, families: [family], series: [family], vendor: 'NVIDIA' };
  const api = options.api || 'dx12';
  const chosen = { path: exe, rel: 'bin/' + path.basename(exe), name: path.basename(exe), bitness: 64, api,
    detectedApi: api, detectedApiResolution: { api, source: 'fixture', evidence: [] }, supportedApis: ['dx11', 'dx12', 'vulkan'], apiResolution: { api, source: 'fixture', evidence: [] } };
  const scan = { gameDir: gameRoot, chosen, exeCandidates: [chosen], emulator: null, reshade: { installed: false },
    dlssFiles: [{ path: path.join(exeDir, 'nvngx_dlss.dll'), name: 'nvngx_dlss.dll', bitness: 64 }],
    primaryDlss: { path: path.join(exeDir, 'nvngx_dlss.dll'), name: 'nvngx_dlss.dll', bitness: 64 },
    streamlineFiles: [], dlssgFiles: [{ path: path.join(exeDir, 'nvngx_dlssg.dll'), name: 'nvngx_dlssg.dll', bitness: 64 }] };
  const scanAdapter = {
    async scanGame() { return structuredClone(scan); }, selectPrimaryDlss: files => files[0] || null,
    inspectReShade(dir) {
      const file = ['dxgi.dll', 'd3d12.dll'].find(name => fs.existsSync(path.join(dir, name)));
      return file ? { installed: true, file, addonSupport: fs.readFileSync(path.join(dir, file)).includes('Searching for add-ons') } : { installed: false, file: null, addonSupport: false };
    }
  };
  const library = { async scanAll(state) {
    const saved = state.gameOverrides[path.resolve(gameRoot).toLowerCase()] || {}, selectedApi = saved.api && saved.api !== 'auto' ? saved.api : api;
    const selected = { ...chosen, apiResolution: { api: selectedApi, source: saved.api ? 'override' : 'fixture', evidence: [] } };
    const manifest = readManifest(gameRoot);
    return [{ id, name: 'Integration fixture', launcher: 'manual', dir: gameRoot, chosen: selected, apiOverride: saved.api || 'auto',
      supported: !options.noDlss, installed: Boolean(manifest), installedVersion: manifest?.payloadVersion,
      scan: { ...scan, chosen: selected, ...(options.noDlss ? { primaryDlss: null, dlssFiles: [], streamlineFiles: [] } : {}) } }];
  }, dispose() {} };
  const installer = createInstaller({ guards, pe, scan: scanAdapter });
  const special = options.specialSetup ? await options.specialSetup({ root, userData, resourcesPath, gameRoot, exeDir, exe, hardware, guards, pe, scan }) : {};
  const service = createAppService({ userData, resourcesPath, appDir: root, version: 'test-only',
    overrides: { library, installer, detectGpu: () => hardware, assertGameClosed: guards.assertGameClosed,
      externalDeploymentOptions: { guards, pe, ...(options.external || {}) }, ...special.overrides, ...(options.serviceOverrides || {}) } });
  await service.boot();
  const layout = () => service.getLayout(id), driver = driverFixture(events);
  const componentsOptions = { resourcesPath: path.join(PROJECT, 'resources'), appDir: PROJECT,
    gameDirectory: () => gameRoot, gameExecutable: () => exe, getLayout: layout, guards, assertGameClosed: guards.assertGameClosed,
    detectHardware: async () => hardware, antiCheatPresent: () => false,
    pe: { ...pe, getFileVersion: () => '310.8.0.0' },
    scan: async () => ({ api: (await service.listGames())[0].chosen.apiResolution.api, streamlineFg: true, reshadeAddon: true,
      reshadeAddonDirectory: layout().addonDirectory }), ...(options.components || {}) };
  const rawComponents = createFgComponents(componentsOptions);
  const components = { ...rawComponents,
    async prepare(...args) { events.push('components-prepare'); return rawComponents.prepare(...args); },
    async restore(...args) { events.push('components-restore'); return rawComponents.restore(...args); },
    async recoverPending(...args) { events.push('components-recover'); return rawComponents.recoverPending(...args); } };
  const rawSettings = createLaunchSettingsService({ userData, appDir: root, resourcesPath, gameDirectory: () => gameRoot, gameExecutable: () => exe,
    getLayout: layout, driver, peBitness: pe.getBitness, detectHardware: async () => hardware,
    environment: async () => ({ verified: true, running: [] }), assertGameClosed: guards.assertGameClosed,
    getFeatureEvidence: async () => enhancementEvidence(),
    assertComponents: async (_id, backend) => { if (backend === 'mfgunlock' && !(await components.inspect(id)).ready)
      throw Object.assign(new Error('fixture MFG addon needs preparation'), { code: 'SETTINGS_COMPONENTS_NOT_READY' }); } });
  const settings = { ...rawSettings, async restore(...args) { events.push('settings-restore-' + args[1]); return rawSettings.restore(...args); } };
  const workflow = createFgWorkflow({ settings, components, assertClosed: async () => {} });
  const applyEnhancement = async (gameId, domain, request, consent = {}) => {
    events.push('apply-' + domain);
    if (domain === 'fg' && request.backend === 'mfgunlock' && request.mode !== 'restore') return workflow.apply(gameId, request, consent);
    if (policy.isRestore(domain, request)) return { ...await settings.restore(gameId, domain), saved: true };
    if (domain === 'fg' && request.mode !== 'restore') {
      const status = await components.inspect(gameId); assert.equal(status.route, 'native');
      if (status.needsCleanup) { await settings.restore(gameId, 'fg'); await components.restore(gameId); }
      else if (!status.ready) await components.prepare(gameId, { allowAntiCheat: consent.allowAntiCheat === true });
    }
    const preview = await settings.preview(gameId, domain, request, { reapplyExternalChanges: consent.reapplyExternalChanges === true });
    const result = await settings.apply(preview.id, { confirm: true }); await settings.save(gameId, domain, request); return result;
  };
  const coordinator = createLaunchCoordinator({ service, settings, components, guards, explicitApply: true,
    legacySrModel: { migrationInfo: async () => ({ configured: false, baselineCaptured: false }), prepareMigration: async () => ({ unchanged: true }) },
    launchGame: async () => { throw new Error('integration tests never launch a game'); } });
  // These owners are intentionally absent from the fixture. Deployment, settings,
  // MFG files, and their recovery owners below all use their production services.
  const planOptions = { userData, service, settings, components, fgWorkflow: workflow, guards, applyEnhancement,
    environment: { assertReady: async () => {}, recoverPending: async () => ({ recovered: false }) },
    preparation: { assertReady: async () => {}, inspect: async () => ({ pending: false }) },
    restoreForUninstall: gameId => coordinator.restoreForUninstall(gameId),
    setLaunchMode: async () => {}, inspectLaunchMode: async () => ({ steamAvailable: false }), ...(options.plan || {}) };
  const plans = createOperationPlans(planOptions);
  const apply = async request => { const preview = await plans.preview(id, request); assert.deepEqual(preview.blockers, []);
    return { preview, result: await plans.apply(preview.planId, { confirm: true, fingerprint: preview.fingerprint }) }; };
  return { root, gameRoot, exeDir, exe, id, userData, resourcesPath, payload, family, hardware, scan, guards, service, installer,
    plans, planOptions, apply, layout, events, driver, settings, components, workflow, coordinator, componentsOptions, special };
}
module.exports = { fixture, peBytes, put, hashFile, sha, PROJECT, INSTALLED_NAMES, PAYLOAD_FILES, DX11_COMPAT_CARRIER };
