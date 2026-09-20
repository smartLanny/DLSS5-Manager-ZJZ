'use strict';
const fs = require('node:fs'), path = require('node:path');
const { createAppService } = require('../../src/product/app-service');
const { createInstaller } = require('../../src/product/installer');
const { createLibraryService } = require('../../src/product/library-service');
const { createCompactBundle, sha256 } = require('../../src/product/payload');
const { createOperationPlans } = require('../../src/product/operation-plan');
const { createGameAssessment } = require('../../src/product/game-assessment');
const { createDeferredOperations } = require('../../src/product/deferred-operations');
const { createWorkScheduler } = require('../../src/product/work-scheduler');
const { PAYLOAD_FILES } = require('../../src/product/constants');

async function createExperienceFixture(root, options = {}) {
  const gameDir = path.join(root, 'NTE-fixture'), exeDir = path.join(gameDir, 'Binaries', 'Win64'), exe = path.join(exeDir, 'Game.exe');
  fs.mkdirSync(exeDir, { recursive: true }); fs.writeFileSync(exe, 'synthetic selected EXE; never executed');
  const payload = path.join(root, 'resources/payload/nr-before-sr');
  for (const family of ['RTX40', 'RTX50']) {
    const dir = path.join(payload, 'fixed', family); fs.mkdirSync(dir, { recursive: true });
    for (const name of ['ReShade64.dll', 'nrchain_nvngx.dll', 'nvngx_dlssnr.dll']) fs.writeFileSync(path.join(dir, name), name === 'ReShade64.dll' ? 'ReShade Searching for add-ons' : name);
  }
  for (const version of ['0.4.7beta', '0.4.2']) {
    const dir = path.join(payload, 'versions', version); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, PAYLOAD_FILES.addon), version + ' synthetic Core');
    fs.writeFileSync(path.join(dir, PAYLOAD_FILES.config), '[NRBeforeSR]\nEnabled=1\nIntensity=1.23456789\nWorkMode=0\n');
  }
  const bundle = createCompactBundle(payload, ['0.4.7beta', '0.4.2'].map(id => ({ id, label: id })), '0.4.7beta');
  for (const entry of Object.values(bundle.versions)) Object.assign(entry, { supportsPresent: true, inputInterfaces: ['NGX-D3D12-Feature1'] });
  fs.writeFileSync(path.join(payload, 'bundle.json'), JSON.stringify(bundle));
  fs.unlinkSync(path.join(payload, 'fixed/RTX40/nvngx_dlssnr.dll'));
  fs.unlinkSync(path.join(payload, 'fixed/RTX50/nvngx_dlssnr.dll'));
  const dlc = path.join(root, 'dlc'); fs.mkdirSync(dlc);
  const bytes = Buffer.alloc(16 * 1024 * 1024); bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(2, 84); bytes.writeUInt16LE(0x20b, 88);
  const runtime = path.join(dlc, 'nvngx_dlssnr.dll'); fs.writeFileSync(runtime, bytes);
  fs.writeFileSync(path.join(dlc, 'component-manifest.json'), JSON.stringify({ schema: 'dlss5-component-v1', id: 'experience-runtime', kind: 'nr-runtime', version: 'fixture', architecture: 'x64', interface: 'NGX-Feature18', hardwareFamilies: ['RTX40'], files: [{ path: 'nvngx_dlssnr.dll', bytes: bytes.length, sha256: sha256(runtime) }] }));
  const chosen = { path: exe, rel: path.relative(gameDir, exe), name: 'Game.exe', size: 1, api: 'dxgi', apiLabel: 'DirectX 11/12', bitness: 64 };
  const native = { path: path.join(exeDir, 'nvngx_dlss.dll'), name: 'nvngx_dlss.dll', bitness: 64 };
  const scan = { gameDir, gameName: '异环反馈 · 混合 API 回归', chosen, exeCandidates: [chosen], dlssFiles: [native], primaryDlss: native, emulator: null, reshade: { installed: false } };
  const scanner = { scanGame: async () => structuredClone(scan), selectPrimaryDlss: files => files[0], inspectReShade: dir => ({ installed: fs.existsSync(path.join(dir, 'dxgi.dll')), file: 'dxgi.dll', addonSupport: true }) };
  if (options.existingInstallation) {
    if (!['reshade-standard', 'unknown-proxy'].includes(options.existingInstallation)) throw new Error('unknown synthetic installation scenario');
    fs.writeFileSync(path.join(exeDir, 'dxgi.dll'), options.existingInstallation === 'reshade-standard' ? 'ReShade ordinary synthetic build without Add-on support' : 'unidentified synthetic user proxy; never executed');
    fs.writeFileSync(path.join(exeDir, 'nrchain_nvngx.dll'), 'prior synthetic chain');
    fs.writeFileSync(path.join(exeDir, 'nr_before_sr.ini'), '[NRBeforeSR]\r\nEnabled=1\r\nIntensity=0.87654321\r\nWorkMode=0\r\n; original personal configuration\r\n');
    fs.writeFileSync(path.join(exeDir, 'ReShade.ini'), '[ADDON]\r\nAddonPath=.\r\n[STYLE]\r\nFont=Original personal font\r\n');
    scanner.inspectReShade = dir => {
      const file = path.join(dir, 'dxgi.dll'), bytes = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
      return { installed: bytes.includes('ReShade'), file: bytes.includes('ReShade') ? 'dxgi.dll' : null, addonSupport: bytes.includes('Searching for add-ons') };
    };
  }
  const hardware = { family: 'RTX40', series: ['RTX30'], names: ['Synthetic RTX 3070'], source: 'fixture' }, guards = { antiCheatPresent: () => false, assertGameClosed: async () => {} };
  const library = createLibraryService({ scan: scanner, library: { discover: () => ({ games: [], roots: [] }), dedupe: rows => rows } });
  const userData = path.join(root, 'user-data');
  const service = createAppService({ userData, resourcesPath: path.join(root, 'resources'), appDir: root, version: '0.5.0-beta.3', overrides: { library, detectGpu: () => hardware, assertGameClosed: guards.assertGameClosed,
    ...(options.existingInstallation ? { inspectReShade: scanner.inspectReShade,
      adoptionPe: { getBitness: () => 64, versionMentions: file => fs.readFileSync(file).includes('ReShade') } } : {}),
    installer: createInstaller({ scan: scanner, guards, pe: { getBitness: () => 64 } }), externalDeploymentOptions: { guards, pe: { getImports: () => [] } } } });
  const settings = { assertReady: async () => {}, inspect: async () => ({ applied: {}, requests: {}, pending: [] }), pending: async () => [] };
  const environment = { assertReady: async () => {}, inspect: async () => ({ files: [], remainingFiles: [] }), recoverPending: async () => {} };
  const operations = createOperationPlans({ userData, service, settings, components: { inspect: async () => ({}) }, environment,
    preparation: { assertReady: async () => {}, inspect: async () => ({ pending: false }) }, guards });
  const scheduler = createWorkScheduler(); let running = false;
  const deferred = createDeferredOperations({ userData, service, operations, run: (key, fn) => scheduler.run(key, fn), assertClosed: async () => { if (running) throw Object.assign(new Error('game running'), { code: 'errGameRunning' }); } });
  const assessment = createGameAssessment({ service, operations, deferred, environment, hardware: () => hardware, antiCheatPresent: () => false,
    coordinator: { inspect: async () => ({ hardware, featureStates: {}, applied: {}, requests: {} }) }, launches: { inspect: async () => null }, launchMode: async () => ({ selected: 'exe' }) });
  return { root, service, assessment, operations, deferred, exe, gameDir, dlc, setRunning: value => { running = value; },
    add: () => service.addManualGame(gameDir, { name: '异环反馈 · 混合 API 回归', executable: exe }) };
}
module.exports = { createExperienceFixture };
