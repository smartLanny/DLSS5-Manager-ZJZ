'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createFgComponents } = require('../src/product/fg-legacy-components');
const { createLaunchSettingsService } = require('../src/product/launch-settings-service');
const { enhancementEvidence } = require('./helpers/enhancement-evidence');

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

test('RTX40 components gate launch settings and both layers restore their own files', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-fg-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, 'game'), exeDir = path.join(game, 'Binaries', 'Win64'), exe = path.join(exeDir, 'Game.exe');
  fs.mkdirSync(exeDir, { recursive: true }); fs.writeFileSync(exe, 'synthetic-x64-exe');

  const resources = path.join(root, 'resources', 'fg-components'); fs.mkdirSync(resources, { recursive: true });
  const sourceFiles = {
    core: ['RTX40MFGCore.dll', 'core-v1.2'], asi: ['RTX40MFG.asi', 'asi-v1.2'], overlay: ['RTX40MFG-UI.addon64', 'overlay-v1.2'],
    ual: ['ual-x64.dll', 'ual-v9.7.4'], ualConfig: ['global.ini', '[GlobalSets]\nLoadPlugins=1\nLoadFromScriptsOnly=1\nLoadExtraPlugins=RTX40MFG.asi\nDontLoadFromDllMain=0\nForceEntryPointHook=0\n']
  };
  const manifestFiles = {};
  for (const [role, [name, content]] of Object.entries(sourceFiles)) {
    fs.writeFileSync(path.join(resources, name), content); manifestFiles[role] = { file: name, sha256: sha256(Buffer.from(content)) };
  }
  fs.writeFileSync(path.join(resources, 'manifest.json'), JSON.stringify({ version: 1, id: 'integration-v1', protocol: 11,
    files: manifestFiles, ualProxyNames: ['version.dll'], sources: [] }));
  const reshadeSource = path.join(root, 'ReShade64.dll'); fs.writeFileSync(reshadeSource, 'reshade-addon');
  const reshadeHash = sha256(Buffer.from('reshade-addon'));

  const proxy = path.join(exeDir, 'version.dll'), proxyIni = path.join(exeDir, 'version.ini');
  fs.copyFileSync(path.join(resources, 'ual-x64.dll'), proxy);
  const originalIni = '[GlobalSets]\nLoadPlugins=0\nLoadFromScriptsOnly=0\nLoadExtraPlugins=Keep.asi\n[FileLoader]\nOverloadFromFolder=keep\n';
  fs.writeFileSync(proxyIni, originalIni);

  const components = createFgComponents({ resourcesPath: path.join(root, 'resources'), appDir: root,
    gameDirectory: () => game, gameExecutable: () => exe,
    detectHardware: async () => ({ family: 'RTX40', series: ['RTX40'] }), scan: async () => ({ api: 'dx12', streamlineFg: true, reshadeAddon: false }),
    pe: { getBitness: () => 64, getImports: () => ['version.dll'] }, assertGameClosed: async () => {}, antiCheatPresent: () => false,
    inspectRuntime: () => ({ status: 'available', ready: true, missing: [], message: 'fixture base files only' }),
    getReShadeSource: async () => ({ file: reshadeSource, sha256: reshadeHash }) });
  const assertComponents = async id => {
    const status = await components.inspect(id);
    if (!status.ready) throw Object.assign(new Error(status.blockers.join('\n') || `缺少组件：${status.missing.join('、')}`), { code: 'SETTINGS_FG_COMPONENTS_REQUIRED' });
  };
  // Seed a historical v1 request/receipt through the retained adapter; production
  // defaults reject this route and only expose its restore operation.
  const settings = createLaunchSettingsService({ userData: path.join(root, 'user'), appDir: root, allowLegacyControl: true,
    getFeatureEvidence: async () => enhancementEvidence(),
    gameDirectory: () => game, gameExecutable: () => exe, detectHardware: async () => ({ family: 'RTX40', series: ['RTX40'] }),
    environment: async () => ({ verified: true, running: [] }), peBitness: () => 64, assertComponents });
  const request = { backend: 'rtx40', mode: 'fixed', multiplier: 3 };

  await assert.rejects(settings.preview('g', 'fg', request), { code: 'SETTINGS_FG_COMPONENTS_REQUIRED' });
  assert.equal((await components.prepare('g')).prepared, true);

  let plan = await settings.preview('g', 'fg', request);
  fs.unlinkSync(path.join(exeDir, 'RTX40MFGCore.dll'));
  await assert.rejects(settings.apply(plan.id, { confirm: true }), { code: 'SETTINGS_FG_COMPONENTS_REQUIRED' });
  assert.equal((await components.prepare('g')).prepared, true, 'component repair preserves the original receipt');

  plan = await settings.preview('g', 'fg', request);
  assert.equal((await settings.apply(plan.id, { confirm: true })).applied, true);
  const changed = JSON.parse(fs.readFileSync(path.join(exeDir, 'RTX40MFG-Universal.json'), 'utf8'));
  assert.equal(changed.mode, 'fixed'); assert.equal(changed.multiplier, 3);
  const afterApply = await components.inspect('g');
  assert.equal(afterApply.ready, true, `launch-settings-owned control change must remain component-ready: ${afterApply.blockers.join(' | ')}`);

  fs.unlinkSync(path.join(exeDir, 'RTX40MFGCore.dll'));
  assert.equal((await components.prepare('g')).prepared, true, 'repair after settings apply recreates only the missing component');
  assert.equal((await components.inspect('g')).ready, true, 'repair retains both the component baseline and settings-owned control state');

  await settings.restore('g', 'fg');
  assert.equal(JSON.parse(fs.readFileSync(path.join(exeDir, 'RTX40MFG-Universal.json'), 'utf8')).mode, 'follow');

  const dxgi = path.join(exeDir, 'dxgi.dll'), backup = path.join(game, '_DLSS5_Backup'); fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, 'xiaofeng-manager.json'), JSON.stringify({ version: 1, product: 'xiaofeng-dlss5-manager', installId: crypto.randomUUID(),
    game: { dir: game, exe: path.relative(game, exe), api: 'dx12' }, files: [{ rel: path.relative(game, dxgi), kind: 'reshade', original: { existed: false } }], conflicts: [] }));
  const restored = await components.restore('g'); assert.equal(restored.restored, true);
  assert.deepEqual(restored.retained, [path.relative(game, dxgi)]); assert.equal(fs.existsSync(dxgi), true, 'NR-owned shared ReShade remains');
  assert.equal(fs.readFileSync(proxyIni, 'utf8'), originalIni); assert.equal(fs.existsSync(proxy), true, 'pre-existing verified UAL remains');
  for (const name of ['RTX40MFGCore.dll', 'RTX40MFG.asi', 'RTX40MFG-UI.addon64', 'RTX40MFG-Universal.json']) assert.equal(fs.existsSync(path.join(exeDir, name)), false);
  assert.equal(fs.existsSync(components.receiptFile('g')), false); assert.deepEqual((await settings.inspect('g')).applied, {}); assert.deepEqual(await settings.pending('g'), []);
});
