'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createInstaller } = require('../src/product/installer');
const journal = require('../src/core/file-journal');
const { sha256 } = require('../src/product/payload');
const { PAYLOAD_FILES, INSTALLED_NAMES, DX11_COMPAT_VERSION, DX11_COMPAT_CARRIER } = require('../src/product/constants');
const { manifestPath, readManifest } = require('../src/product/manifest');
const { normalizeError } = require('../src/product/errors');

test('installation does not quarantine inactive subdirectory addons', async t => {
  const f = fixture(t), nested = path.join(f.exeDir, 'unused-addon-archive');
  fs.mkdirSync(nested); const file = path.join(nested, 'renodx-dlss5.addon64'); fs.writeFileSync(file, 'inactive old addon');
  await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  assert.equal(fs.readFileSync(file, 'utf8'), 'inactive old addon');
  assert.deepEqual(readManifest(f.gameDir).conflicts, []);
});

test('custom or bypassed ReShade loading is diagnosed and refuses install or repair before file changes', async t => {
  const f = fixture(t), ini = path.join(f.exeDir, 'ReShade.ini');
  fs.writeFileSync(ini, '[ADDON]\nAddonPath=custom-addons\n');
  await assert.rejects(f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan }), { code: 'ERR_ADDON_SEARCH_PATH' });
  assert.equal(readManifest(f.gameDir), null);
  assert.equal(fs.existsSync(path.join(f.exeDir, INSTALLED_NAMES.addon)), false);
  fs.writeFileSync(ini, '[ADDON]\nAddonPath=.\n');
  await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  fs.appendFileSync(ini, '[ADDON]\nLoadFromDllMain=dlss5-bridge.addon64\n');
  const receipt = fs.readFileSync(manifestPath(f.gameDir));
  const diagnostic = await f.installer.diagnose({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  assert.equal(diagnostic.complete, false);
  assert.match(diagnostic.components.find(row => row.key === 'addon-layout').detail, /直接加载/);
  await assert.rejects(f.installer.repair({ gameDir: f.gameDir, payload: f.payload, scan: f.scan }), { code: 'ERR_ADDON_DIRECT_LOAD' });
  assert.deepEqual(fs.readFileSync(manifestPath(f.gameDir)), receipt);
  assert.equal((await f.installer.uninstall({ gameDir: f.gameDir })).removed, true, 'a deployment gate cannot trap restoration');
});

test('repeated conflict quarantine restores the pre-install addon and indexes later copies', async t => {
  const f = fixture(t), name = path.join(f.exeDir, 'renodx-dlss5.addon64');
  fs.writeFileSync(name, 'original addon');
  await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  fs.writeFileSync(name, 'later manually copied addon');
  await f.installer.repair({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  const before = readManifest(f.gameDir);
  assert.equal(before.conflicts.length, 2);
  const result = await f.installer.uninstall({ gameDir: f.gameDir });
  assert.equal(result.removed, true); assert.equal(result.archivedConflictCopies, 1);
  assert.equal(fs.readFileSync(name, 'utf8'), 'original addon');
  assert.equal(fs.readFileSync(path.join(f.gameDir, before.conflicts[1].backupRel), 'utf8'), 'later manually copied addon');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.gameDir, result.historyRel))).conflicts.length, 2);
  assert.equal(readManifest(f.gameDir), null);
});

test('uninstall accepts an already restored identical external addon', async t => {
  const f = fixture(t), name = path.join(f.exeDir, 'old-nr-before-sr.addon64');
  fs.writeFileSync(name, 'old addon');
  await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  fs.writeFileSync(name, 'old addon');
  const result = await f.installer.uninstall({ gameDir: f.gameDir });
  assert.equal(result.removed, true); assert.equal(fs.readFileSync(name, 'utf8'), 'old addon');
});

test('uninstall archives only newly owned sidecars and preserves unrelated or reused bak files', async t => {
  const f = fixture(t), runtime = path.join(f.exeDir, INSTALLED_NAMES.runtime), bridge = path.join(f.exeDir, INSTALLED_NAMES.bridge);
  fs.writeFileSync(runtime, 'old runtime'); fs.writeFileSync(`${runtime}.bak`, 'user backup');
  fs.writeFileSync(bridge, 'old bridge'); fs.writeFileSync(`${bridge}.bak`, 'old bridge');
  await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  assert.equal(readManifest(f.gameDir).sidecars.length, 1, 'matching pre-existing bak is reused without adopting ownership');
  const result = await f.installer.uninstall({ gameDir: f.gameDir });
  assert.equal(result.removed, true);
  assert.equal(fs.readFileSync(runtime, 'utf8'), 'old runtime');
  assert.equal(fs.readFileSync(`${runtime}.bak`, 'utf8'), 'user backup');
  assert.equal(fs.readFileSync(`${bridge}.bak`, 'utf8'), 'old bridge');
  assert.equal(fs.existsSync(`${runtime}.bak.1`), false);
  const history = JSON.parse(fs.readFileSync(path.join(f.gameDir, result.historyRel)));
  assert.equal(fs.readFileSync(path.join(f.gameDir, history.restoration.archivedSidecars[0].backupRel), 'utf8'), 'old runtime');
});

test('externally changed sidecar is retained and reported without blocking active-file restoration', async t => {
  const f = fixture(t), runtime = path.join(f.exeDir, INSTALLED_NAMES.runtime);
  fs.writeFileSync(runtime, 'original runtime');
  await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  fs.writeFileSync(`${runtime}.bak`, 'external change');
  const result = await f.installer.uninstall({ gameDir: f.gameDir });
  assert.equal(result.removed, true); assert.equal(result.retainedSidecars.length, 1);
  assert.equal(fs.readFileSync(runtime, 'utf8'), 'original runtime');
  assert.equal(fs.readFileSync(`${runtime}.bak`, 'utf8'), 'external change');
});

test('late conflict restoration failure rolls all removed manager files and receipt back', async t => {
  const f = fixture(t), name = path.join(f.exeDir, 'renodx-dlss5.addon64');
  fs.writeFileSync(name, 'old addon');
  await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  const receipt = fs.readFileSync(manifestPath(f.gameDir));
  const copy = fs.promises.copyFile; let failed = false;
  fs.promises.copyFile = async (source, target, flags) => {
    if (!failed && path.resolve(target) === path.resolve(name)) { failed = true; throw Object.assign(new Error('restore locked'), { code: 'EBUSY' }); }
    return copy(source, target, flags);
  };
  try { await assert.rejects(f.installer.uninstall({ gameDir: f.gameDir }), /restore locked/); }
  finally { fs.promises.copyFile = copy; }
  assert.equal(failed, true); assert.deepEqual(fs.readFileSync(manifestPath(f.gameDir)), receipt);
  assert.equal(fs.existsSync(name), false);
  for (const kind of ['addon', 'bridge', 'runtime', 'reshade']) assert.equal(sha256(path.join(f.exeDir, INSTALLED_NAMES[kind])), f.payload[kind].actual);
  assert.equal(fs.existsSync(journal.pendingPath(f.gameDir)), false);
  assert.equal((await f.installer.uninstall({ gameDir: f.gameDir })).removed, true);
});

test('repair does not recopy unchanged owned payload files or accumulate bak files', async t => {
  let copies = 0;
  const f = fixture(t, 'dx12', { copyFile: async (source, target) => { copies++; return fs.promises.copyFile(source, target); } });
  await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  copies = 0;
  assert.equal((await f.installer.repair({ gameDir: f.gameDir, payload: f.payload, scan: f.scan })).complete, true);
  assert.equal(copies, 0);
  assert.equal(fs.readdirSync(f.exeDir).some(name => /[.]bak/.test(name)), false);
});

function fixture(t, api = 'dx12', options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-route-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gameDir = path.join(root, 'Game');
  const exeDir = path.join(gameDir, 'bin');
  const payloadDir = path.join(root, 'payload');
  fs.mkdirSync(exeDir, { recursive: true });
  fs.mkdirSync(payloadDir, { recursive: true });
  const exePath = path.join(exeDir, 'game.exe');
  fs.writeFileSync(exePath, 'game');
  const payload = {};
  for (const [kind, name] of Object.entries(PAYLOAD_FILES)) {
    const file = path.join(payloadDir, name);
    fs.writeFileSync(file, kind === 'reshade' ? 'PE64 ReShade Searching for add-ons' : `payload-${kind}`);
    payload[kind] = { file, name, actual: sha256(file) };
  }
  const carrierFile = path.join(payloadDir, DX11_COMPAT_CARRIER);
  fs.writeFileSync(carrierFile, 'payload-carrier');
  payload.carrier = { file: carrierFile, name: DX11_COMPAT_CARRIER, actual: sha256(carrierFile) };
  payload.version = DX11_COMPAT_VERSION;
  payload.versionInfo = { compatibility: 'dx11' };
  const scan = {
    chosen: {
      path: exePath, rel: 'bin/game.exe', bitness: 64, api: 'dxgi',
      apiLabel: api === 'dx11' ? 'DirectX 11' : 'DirectX 12',
      apiResolution: { api, source: 'test', evidence: [] }, emulator: null
    },
    primaryDlss: { name: 'nvngx_dlss.dll' }, emulator: null
  };
  const scanModule = {
    async scanGame() { return scan; },
    inspectReShade(dir) {
      const file = path.join(dir, 'dxgi.dll');
      return fs.existsSync(file)
        ? { installed: true, addonSupport: fs.readFileSync(file).includes('Searching for add-ons'), file: 'dxgi.dll' }
        : { installed: false, addonSupport: false, file: null };
    }
  };
  const installer = createInstaller({
    journal,
    scan: scanModule,
    guards: options.guards || { antiCheatPresent: () => false, assertGameClosed: async () => {} },
    pe: { getBitness: () => 64 },
    ...(options.copyFile ? { copyFile: options.copyFile } : {})
  });
  return { root, gameDir, exeDir, exePath, payload, scan, installer };
}

test('DX12 keeps nrchain, never deploys carrier, and restores an unmanaged old carrier on uninstall', async t => {
  const f = fixture(t, 'dx12');
  const oldCarrier = path.join(f.exeDir, 'r3-nr-native-neutral.addon64');
  fs.writeFileSync(oldCarrier, 'user old carrier');

  const result = await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  assert.equal(result.complete, true);
  assert.equal(fs.existsSync(path.join(f.exeDir, INSTALLED_NAMES.bridge)), true);
  assert.equal(fs.existsSync(path.join(f.exeDir, INSTALLED_NAMES.carrier)), false);
  assert.equal(fs.existsSync(oldCarrier), false);
  assert.equal(result.components.find(row=>row.key==='carrier').label,'NIGos Bridge · DX11 桥接器');
  assert.equal(result.components.find(row=>row.key==='carrier').detail,'无需启用（DirectX 12）');
  assert.match(result.components.find(row=>row.key==='conflicts').detail, /外部冲突备份/);

  const removed = await f.installer.uninstall({ gameDir: f.gameDir, scan: f.scan });
  assert.equal(removed.removed, true);
  assert.equal(fs.readFileSync(oldCarrier, 'utf8'), 'user old carrier');
});

test('DX11 deploys the matched carrier and restores the prior carrier on uninstall', async t => {
  const f = fixture(t, 'dx11');
  const target = path.join(f.exeDir, INSTALLED_NAMES.carrier);
  fs.writeFileSync(target, 'prior carrier');
  const reshadeIni = path.join(f.exeDir, 'ReShade.ini');
  fs.writeFileSync(reshadeIni,
    `[ADDON]\r\nDisabledAddons=@${INSTALLED_NAMES.carrier},@user,,name.addon64\r\n` +
    `[OTHER]\r\nDisabledAddons=@${INSTALLED_NAMES.carrier}\r\n` +
    `[ADDON]\r\nDisabledAddons=@keep.addon64,@${INSTALLED_NAMES.carrier.toUpperCase()}\r\n`);

  const result = await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  assert.equal(result.complete, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'payload-carrier');
  const enabledIni = fs.readFileSync(reshadeIni, 'utf8');
  assert.match(fs.readFileSync(`${reshadeIni}.bak`, 'utf8'), new RegExp(INSTALLED_NAMES.carrier, 'i'));
  assert.match(enabledIni, /DisabledAddons=@user,,name\.addon64/);
  assert.match(enabledIni, /\[OTHER\]\r\nDisabledAddons=@dlss5-native-carrier/i);
  assert.match(enabledIni, /DisabledAddons=@keep\.addon64/);
  assert.equal((enabledIni.match(new RegExp(`@${INSTALLED_NAMES.carrier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'ig')) || []).length, 2,
    'the token outside ADDON and the case-mismatched ReShade token remain');

  fs.writeFileSync(reshadeIni, `[ADDON]\nDisabledAddons=@${INSTALLED_NAMES.carrier}\n`);
  const disabled = await f.installer.diagnose({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  assert.equal(disabled.complete, false);
  assert.match(disabled.components.find(row => row.key === 'carrier').detail, /禁用/);
  await f.installer.repair({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  const removed = await f.installer.uninstall({ gameDir: f.gameDir, scan: f.scan });
  assert.equal(removed.removed, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'prior carrier');
});

test('DX11 clears exact bare and named carrier exclusions using ReShade section rules', async t => {
  const f = fixture(t, 'dx12');
  const reshadeIni = path.join(f.exeDir, 'ReShade.ini');
  const dx12 = await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  assert.equal(dx12.complete, true);
  assert.equal(fs.existsSync(path.join(f.exeDir, INSTALLED_NAMES.bridge)), true);
  assert.equal(fs.existsSync(path.join(f.exeDir, INSTALLED_NAMES.carrier)), false);
  f.scan.chosen.apiLabel = 'DirectX 11';
  f.scan.chosen.apiResolution = { api: 'dx11', source: 'manual', evidence: [] };
  const original = Buffer.from(
    `\uFEFF[ADDON] accepted trailing text\r\nDisabledAddons=@core.addon64,@${INSTALLED_NAMES.carrier},用户,,条目\r\n` +
    `[ADDON]\r\nDisabledAddons=用户命名@${INSTALLED_NAMES.carrier},name-only,@keep.addon64\r\n` +
    `LoadFromDllMain=manual-third-party.addon64\r\n`, 'utf8');
  fs.writeFileSync(reshadeIni, original);

  const result = await f.installer.repair({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  assert.equal(result.complete, true);
  const enabledIni = fs.readFileSync(reshadeIni, 'utf8');
  assert.doesNotMatch(enabledIni, /用户命名@/);
  assert.doesNotMatch(enabledIni, new RegExp(INSTALLED_NAMES.carrier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  assert.match(enabledIni, /DisabledAddons=@core\.addon64,用户,,条目/);
  assert.match(enabledIni, /DisabledAddons=name-only,@keep\.addon64/);
  assert.match(enabledIni, /LoadFromDllMain=manual-third-party\.addon64/);
  assert.equal(enabledIni.charCodeAt(0), 0xFEFF, 'UTF-8 BOM is preserved');
  assert.equal(fs.readFileSync(`${reshadeIni}.bak`).equals(original), true, 'Manager keeps its own exact INI backup');
  if (process.env.MANAGER_INTEROP_EVIDENCE_DIR) {
    const evidenceDir = path.resolve(process.env.MANAGER_INTEROP_EVIDENCE_DIR);
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, '10-exact-carrier-before.ini'), original);
    fs.writeFileSync(path.join(evidenceDir, '11-exact-carrier-after.ini'), enabledIni);
  }
});

test('ReShade case-sensitive keys stay untouched and the fixed carrier registration name blocks completion', async t => {
  const f = fixture(t, 'dx11');
  const reshadeIni = path.join(f.exeDir, 'ReShade.ini');
  const ineffective =
    `[addon]\nDisabledAddons=@${INSTALLED_NAMES.carrier}\n` +
    `[ADDON]\ndisabledaddons=@${INSTALLED_NAMES.carrier}\n` +
    `[ADDON]\nDisabledAddons=@${INSTALLED_NAMES.carrier.toUpperCase()}\n` +
    `[ADDON]\nDisabledAddons=@${INSTALLED_NAMES.carrier} ,Other, DLSS 5 Bridge 1.4.12\n`;
  fs.writeFileSync(reshadeIni, ineffective);
  const installed = await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  assert.equal(installed.complete, true, 'lowercase section/key do not disable an add-on in ReShade');
  assert.equal(fs.readFileSync(reshadeIni, 'utf8'), ineffective + '\n[INPUT]\nKeyOverlay=36,0,0,0\n');

  const nameOnly = '[ADDON]\nDisabledAddons=DLSS 5 Bridge 1.4.12\n';
  fs.writeFileSync(reshadeIni, nameOnly);
  const diagnosed = await f.installer.diagnose({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  assert.equal(diagnosed.complete, false);
  assert.match(diagnosed.components.find(row => row.key === 'carrier').detail, /注册名.*手动启用/);
  const repaired = await f.installer.repair({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  assert.equal(repaired.complete, false, 'Manager must not claim repair removed a name-only user entry');
  assert.equal(fs.readFileSync(reshadeIni, 'utf8'), nameOnly + '\n[INPUT]\nKeyOverlay=36,0,0,0\n');
  if (process.env.MANAGER_INTEROP_EVIDENCE_DIR) {
    const evidenceDir = path.resolve(process.env.MANAGER_INTEROP_EVIDENCE_DIR);
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, '20-case-sensitive-ineffective.ini'), ineffective);
    fs.writeFileSync(path.join(evidenceDir, '21-name-only-before.ini'), nameOnly);
    fs.writeFileSync(path.join(evidenceDir, '22-name-only-after-repair.ini'), fs.readFileSync(reshadeIni));
    fs.writeFileSync(path.join(evidenceDir, '23-name-only-diagnosis.json'), `${JSON.stringify({
      complete: repaired.complete,
      carrier: repaired.components.find(row => row.key === 'carrier')
    }, null, 2)}\n`);
  }
});

test('real PR160 receipt refuses restore after Manager changes its applied INI', {
  skip: !process.env.PR160_CARRIER_TOOL
}, async t => {
  const f = fixture(t, 'dx12');
  const tool = path.resolve(process.env.PR160_CARRIER_TOOL);
  const python = process.env.PYTHON || 'python';
  const runTool = args => spawnSync(python, [tool, ...args], {
    encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
  });
  await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  const reshadeIni = path.join(f.exeDir, 'ReShade.ini');
  fs.copyFileSync(f.payload.carrier.file, path.join(f.exeDir, INSTALLED_NAMES.carrier));
  fs.writeFileSync(reshadeIni, '[ADDON] trailing text\r\nAddonPath=.\r\nDisabledAddons=Custom,,Name,@keep.addon64\r\n');
  const beforeApply = fs.readFileSync(reshadeIni);

  const appliedRun = runTool(['--ini', reshadeIni, '--api', 'd3d12', '--apply']);
  assert.equal(appliedRun.status, 0, appliedRun.stderr || appliedRun.stdout);
  const applied = JSON.parse(appliedRun.stdout);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.schema, 1);
  const receiptFile = path.join(f.exeDir, applied.receipt);
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  assert.equal(receipt.operation, 'carrier-exclusion');
  assert.equal(receipt.afterSha256, sha256(reshadeIni));
  const afterApply = fs.readFileSync(reshadeIni);

  f.scan.chosen.apiLabel = 'DirectX 11';
  f.scan.chosen.apiResolution = { api: 'dx11', source: 'manual', evidence: [] };
  const repaired = await f.installer.repair({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  assert.equal(repaired.complete, true);
  assert.match(fs.readFileSync(reshadeIni, 'utf8'), /AddonPath=\./);
  assert.equal(fs.existsSync(receiptFile), true);
  assert.equal(fs.existsSync(path.join(f.exeDir, applied.backup)), true);

  const restoreRun = runTool(['--ini', reshadeIni, '--restore', applied.receipt]);
  assert.equal(restoreRun.status, 2, restoreRun.stderr || restoreRun.stdout);
  const refused = JSON.parse(restoreRun.stdout);
  assert.equal(refused.status, 'error');
  assert.equal(refused.error, 'current-hash-mismatch');

  if (process.env.MANAGER_INTEROP_EVIDENCE_DIR) {
    const evidenceDir = path.resolve(process.env.MANAGER_INTEROP_EVIDENCE_DIR);
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, '01-before-pr160.ini'), beforeApply);
    fs.writeFileSync(path.join(evidenceDir, '02-after-pr160.ini'), afterApply);
    fs.copyFileSync(reshadeIni, path.join(evidenceDir, '03-after-manager-dx11-repair.ini'));
    fs.copyFileSync(receiptFile, path.join(evidenceDir, path.basename(receiptFile)));
    fs.copyFileSync(path.join(f.exeDir, applied.backup), path.join(evidenceDir, applied.backup));
    fs.copyFileSync(`${reshadeIni}.bak`, path.join(evidenceDir, 'ReShade.ini.manager.bak'));
    fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), `${JSON.stringify({
      managerBase: '8acf31f9cd6245a32256f28accbb2c0a49bc5386',
      pr160Tool: tool,
      addonPath: '.',
      carrier: INSTALLED_NAMES.carrier,
      beforePr160Sha256: sha256(path.join(evidenceDir, '01-before-pr160.ini')),
      afterPr160Sha256: sha256(path.join(evidenceDir, '02-after-pr160.ini')),
      afterManagerSha256: sha256(path.join(evidenceDir, '03-after-manager-dx11-repair.ini')),
      restoreError: refused.error
    }, null, 2)}\n`);
  }
});

test('repairing a DX11 install on a resolved DX12 route retires carrier but retains nrchain', async t => {
  const f = fixture(t, 'dx11');
  await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  const bridge = path.join(f.exeDir, INSTALLED_NAMES.bridge);
  f.scan.chosen.apiLabel = 'DirectX 12';
  f.scan.chosen.apiResolution = { api: 'dx12', source: 'manual', evidence: [] };

  const beforeRepair = await f.installer.diagnose({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  assert.equal(beforeRepair.routeMismatch, true);
  assert.equal(beforeRepair.deploymentApi, 'dx11');
  assert.equal(beforeRepair.selectedApi, 'dx12');
  assert.equal(beforeRepair.complete, false);
  assert.equal(beforeRepair.components.find(row => row.key === 'conflicts').ok, true,
    'a Manager-owned carrier is reported by the route component, not as an external conflict');
  assert.equal(beforeRepair.components.find(row => row.key === 'carrier').ok, true, 'installed carrier integrity is independent of the requested API');
  assert.match(beforeRepair.components.find(row => row.key === 'route').detail, /已装 dx11.*当前选择 dx12/);
  const repaired = await f.installer.repair({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  assert.equal(repaired.complete, true);
  assert.equal(repaired.routeMismatch, false);
  assert.equal(fs.existsSync(path.join(f.exeDir, INSTALLED_NAMES.carrier)), false);
  assert.equal(fs.readFileSync(bridge, 'utf8'), 'payload-bridge');
});

test('repair and OTA upgrade refuse to retarget an existing receipt to another EXE', async t => {
  const f = fixture(t, 'dx12');
  await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  const otherDir = path.join(f.gameDir, 'other'), otherExe = path.join(otherDir, 'other.exe');
  fs.mkdirSync(otherDir); fs.writeFileSync(otherExe, 'other');
  const otherScan = structuredClone(f.scan); otherScan.chosen.path = otherExe; otherScan.chosen.rel = path.relative(f.gameDir, otherExe);
  await assert.rejects(f.installer.repair({ gameDir: f.gameDir, payload: f.payload, scan: otherScan }), error => {
    assert.equal(error.code, 'ERR_INSTALL_EXE_CHANGED');
    assert.equal(path.normalize(error.details.file), path.normalize('bin/game.exe'));
    assert.match(normalizeError(error).message, /bin[\\/]game\.exe/);
    return true;
  });
  await assert.rejects(f.installer.upgradeAddon({ gameDir: f.gameDir, version: 'imported-test', scan: otherScan,
    addon: { file: f.payload.addon.file, addonSha256: f.payload.addon.actual } }), { code: 'ERR_INSTALL_EXE_CHANGED' });
  assert.equal(fs.existsSync(path.join(otherDir, INSTALLED_NAMES.addon)), false);
  const diagnosis = await f.installer.diagnose({ gameDir: f.gameDir, payload: f.payload, scan: otherScan });
  assert.equal(diagnosis.executableMismatch, true); assert.equal(diagnosis.complete, false);
  assert.match(diagnosis.components.find(row => row.key === 'executable').detail, /另一个游戏程序/);
});

test('health uses installed identities while repair restores exact missing bytes without upgrading the Core', async t => {
  const f = fixture(t, 'dx11');
  await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  const saved = readManifest(f.gameDir), baseline = structuredClone(saved.files.map(row => row.original));
  const newer = { ...f.payload, addon: { ...f.payload.addon, actual: 'a'.repeat(64) } };
  const health = await f.installer.diagnose({ gameDir: f.gameDir, scan: f.scan, payload: newer, payloadVersion: 'newer-core' });
  assert.equal(health.complete, true);
  assert.deepEqual(health.availableUpdate, { from: saved.payloadVersion, to: 'newer-core', label: 'newer-core' });
  const bridge = path.join(f.exeDir, INSTALLED_NAMES.bridge); fs.unlinkSync(bridge);
  const inspect = () => require('../src/product/installed-repair').inspectInstalledRepair({ gameDir: f.gameDir,
    exePath: f.exePath, sourceRoots: [path.join(f.root, 'payload')] });
  const before = fs.readFileSync(manifestPath(f.gameDir)), plan = await inspect();
  assert.deepEqual(plan.blockers, []); assert.equal(plan.entries.length, 1);
  assert.deepEqual(fs.readFileSync(manifestPath(f.gameDir)), before, 'preview does not mutate the receipt');
  assert.equal(fs.existsSync(bridge), false);
  const result = await f.installer.repairInstalled({ gameDir: f.gameDir, scan: f.scan, entries: plan.entries, manifestHash: plan.manifestHash });
  assert.equal(result.complete, true); assert.equal(result.preservedVersion, saved.payloadVersion);
  assert.equal(sha256(bridge), f.payload.bridge.actual);
  assert.deepEqual(readManifest(f.gameDir).files.map(row => row.original), baseline);
  fs.writeFileSync(bridge, 'manual OTA bytes');
  const changed = await inspect(); assert.equal(changed.entries.length, 0); assert.match(changed.blockers.join(''), /外部修改/);
  assert.equal(fs.readFileSync(bridge, 'utf8'), 'manual OTA bytes');
});

test('repair never substitutes another available version when the original source is missing', async t => {
  const f = fixture(t); await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  fs.unlinkSync(path.join(f.exeDir, INSTALLED_NAMES.addon)); fs.writeFileSync(f.payload.addon.file, 'newer Core');
  const plan = await require('../src/product/installed-repair').inspectInstalledRepair({ gameDir: f.gameDir,
    exePath: f.exePath, sourceRoots: [path.join(f.root, 'payload')] });
  assert.match(plan.blockers.join(''), /原摘要对应/); assert.equal(plan.entries.length, 0);
  assert.equal(fs.existsSync(path.join(f.exeDir, INSTALLED_NAMES.addon)), false);
});

test('D3D12 uninstall restores the receipt-bound directory when the selected and original EXEs are unavailable', async t => {
  const checked = [];
  const guards = { antiCheatPresent: () => false, assertGameClosed: async (_dir, exe) => { checked.push(exe); } };
  const f = fixture(t, 'dx12', { guards });
  await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  await f.installer.toggleD3D12({ gameDir: f.gameDir, enabled: true, scan: f.scan });
  const routeFile = path.join(f.exeDir, 'd3d12.dll'); assert.equal(fs.existsSync(routeFile), true);
  fs.unlinkSync(f.exePath);
  const otherDir = path.join(f.gameDir, 'other'), otherExe = path.join(otherDir, 'missing.exe'); fs.mkdirSync(otherDir);
  const otherScan = structuredClone(f.scan); otherScan.chosen.path = otherExe; otherScan.chosen.rel = path.relative(f.gameDir, otherExe);
  const result = await f.installer.uninstall({ gameDir: f.gameDir, scan: otherScan });
  assert.equal(result.removed, true); assert.equal(fs.existsSync(routeFile), false); assert.equal(fs.existsSync(manifestPath(f.gameDir)), false);
  assert.equal(checked.at(-1), f.exePath, 'process guard follows the receipt-bound EXE even when its file is missing');
});

test('uninstall restores a pre-existing ReShade proxy to dxgi with identical bytes', async t => {
  const f = fixture(t, 'dx12'), proxy = path.join(f.exeDir, 'dxgi.dll');
  const original = Buffer.from('original ReShade Searching for add-ons\0binary'); fs.writeFileSync(proxy, original);
  await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  assert.equal(readManifest(f.gameDir).files.some(row => row.kind === 'reshade'), false,
    'an adopted proxy receives a receipt only when the route is changed');
  await f.installer.toggleD3D12({ gameDir: f.gameDir, enabled: true, scan: f.scan });
  const receipt = readManifest(f.gameDir).files.find(row => row.kind === 'reshade');
  assert.equal(receipt.original.existed, true);
  assert.equal(receipt.installedSha256, sha256(path.join(f.exeDir, 'd3d12.dll')));
  assert.equal(fs.existsSync(proxy), false); assert.equal(fs.existsSync(path.join(f.exeDir, 'd3d12.dll')), true);
  const result = await f.installer.uninstall({ gameDir: f.gameDir, scan: f.scan });
  assert.equal(result.removed, true); assert.deepEqual(fs.readFileSync(proxy), original);
  assert.equal(fs.existsSync(path.join(f.exeDir, 'd3d12.dll')), false);
});

test('old route-only receipt refuses to move an externally replaced d3d12 proxy', async t => {
  const f = fixture(t, 'dx12'), dxgi = path.join(f.exeDir, 'dxgi.dll'), d3d12 = path.join(f.exeDir, 'd3d12.dll');
  fs.writeFileSync(dxgi, 'adopted ReShade Searching for add-ons');
  await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  assert.equal(readManifest(f.gameDir).files.some(row => row.kind === 'reshade'), false);
  fs.renameSync(dxgi, d3d12);
  fs.writeFileSync(d3d12, 'external replacement after the legacy route change');
  const manifest = readManifest(f.gameDir); manifest.reshadeRoute = 'd3d12';
  fs.writeFileSync(manifestPath(f.gameDir), JSON.stringify(manifest, null, 2));

  const result = await f.installer.uninstall({ gameDir: f.gameDir, scan: f.scan });
  assert.equal(result.removed, false);
  assert.equal(result.warnings.some(row => row.code === 'ERR_BACKUP_INVALID' && row.reason === 'unverified-legacy-reshade-route'), true);
  assert.equal(fs.readFileSync(d3d12, 'utf8'), 'external replacement after the legacy route change');
  assert.equal(fs.existsSync(dxgi), false); assert.equal(fs.existsSync(manifestPath(f.gameDir)), true);
});

test('uninstall refuses an ambiguous proxy present at both recorded route locations', async t => {
  const f = fixture(t, 'dx12');
  await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  await f.installer.toggleD3D12({ gameDir: f.gameDir, enabled: true, scan: f.scan });
  const dxgi = path.join(f.exeDir, 'dxgi.dll'), d3d12 = path.join(f.exeDir, 'd3d12.dll');
  fs.copyFileSync(d3d12, dxgi);

  const result = await f.installer.uninstall({ gameDir: f.gameDir, scan: f.scan });
  assert.equal(result.removed, false);
  const warning = result.warnings.find(row => row.code === 'ERR_FILE_CHANGED' && Array.isArray(row.paths));
  assert.deepEqual(warning.paths.map(item => path.normalize(item)).sort(),
    [path.join('bin', 'd3d12.dll'), path.join('bin', 'dxgi.dll')].sort());
  assert.equal(fs.existsSync(dxgi), true); assert.equal(fs.existsSync(d3d12), true);
  assert.equal(fs.existsSync(manifestPath(f.gameDir)), true);
});

test('historical receipt that directly records d3d12 is one target rather than an ambiguous route', async t => {
  const f = fixture(t, 'dx12');
  await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  const dxgi = path.join(f.exeDir, 'dxgi.dll'), d3d12 = path.join(f.exeDir, 'd3d12.dll');
  fs.renameSync(dxgi, d3d12);
  const manifest = readManifest(f.gameDir), row = manifest.files.find(item => item.kind === 'reshade');
  row.rel = path.join('bin', 'd3d12.dll'); manifest.reshadeRoute = 'd3d12';
  fs.writeFileSync(manifestPath(f.gameDir), JSON.stringify(manifest, null, 2));

  const result = await f.installer.uninstall({ gameDir: f.gameDir, scan: f.scan });
  assert.equal(result.removed, true); assert.equal(fs.existsSync(d3d12), false);
  assert.equal(fs.existsSync(manifestPath(f.gameDir)), false);
});

test('uninstall cleans each recorded directory from a historical dual-EXE manifest', async t => {
  const f = fixture(t, 'dx12'); await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  const secondDir = path.join(f.gameDir, 'other'), secondExe = path.join(secondDir, 'other.exe'); fs.mkdirSync(secondDir); fs.writeFileSync(secondExe, 'other');
  const manifest = readManifest(f.gameDir), originalRows = [...manifest.files];
  for (const row of originalRows) {
    const source = path.join(f.gameDir, row.rel), rel = path.join('other', path.basename(row.rel));
    fs.copyFileSync(source, path.join(f.gameDir, rel)); manifest.files.push({ ...structuredClone(row), rel });
  }
  fs.renameSync(path.join(secondDir, 'dxgi.dll'), path.join(secondDir, 'd3d12.dll'));
  manifest.reshadeRoute = 'd3d12'; fs.writeFileSync(manifestPath(f.gameDir), JSON.stringify(manifest, null, 2));
  const otherScan = structuredClone(f.scan); otherScan.chosen.path = secondExe; otherScan.chosen.rel = path.relative(f.gameDir, secondExe);
  const result = await f.installer.uninstall({ gameDir: f.gameDir, scan: otherScan }); assert.equal(result.removed, true);
  for (const dir of [f.exeDir, secondDir]) for (const name of [INSTALLED_NAMES.reshade, 'd3d12.dll', INSTALLED_NAMES.addon,
    INSTALLED_NAMES.bridge, INSTALLED_NAMES.runtime]) assert.equal(fs.existsSync(path.join(dir, name)), false, `${dir}/${name}`);
  assert.equal(fs.existsSync(manifestPath(f.gameDir)), false);
});

test('install cleans only the exact NR addon entry in [ADDON] and keeps a first ReShade backup', async t => {
  const f = fixture(t, 'dx12');
  const reshadeIni = path.join(f.exeDir, 'ReShade.ini');
  const original = `\uFEFF[OTHER]\r\nDisabledAddons=@${INSTALLED_NAMES.addon},@keep.addon64\r\n` +
    `[ADDON] trailing text\r\nDisabledAddons=@${INSTALLED_NAMES.addon},@${INSTALLED_NAMES.addon.toUpperCase()},@${INSTALLED_NAMES.addon.replace('.addon64', '-copy.addon64')},@user,,name.addon64\r\n`;
  fs.writeFileSync(path.join(f.exeDir, 'dxgi.dll'), 'existing ReShade Searching for add-ons');
  fs.writeFileSync(reshadeIni, original);

  const installed = await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  assert.equal(installed.complete, true);
  assert.equal(fs.readFileSync(`${reshadeIni}.bak`, 'utf8'), original);
  const edited = fs.readFileSync(reshadeIni, 'utf8');
  assert.match(edited, new RegExp(`DisabledAddons=@${INSTALLED_NAMES.addon.toUpperCase()},@${INSTALLED_NAMES.addon.replace('.addon64', '-copy.addon64')},@user,,name\\.addon64`));
  assert.match(edited, new RegExp(`\\[OTHER\\]\\r\\nDisabledAddons=@${INSTALLED_NAMES.addon},@keep\\.addon64`));
});

test('addon upgrades apply carrier only to a complete DX11 set and preserve DX12 nrchain', async t => {
  const f = fixture(t, 'dx12');
  await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  const bridge = path.join(f.exeDir, INSTALLED_NAMES.bridge);
  const originalBridge = fs.readFileSync(bridge, 'utf8');
  const addonFile = path.join(f.root, 'upgrade.addon64');
  const carrierFile = path.join(f.root, 'upgrade-carrier.addon64');
  const bridgeFile = path.join(f.root, 'upgrade-bridge.dll');
  fs.writeFileSync(addonFile, 'upgrade-addon');
  fs.writeFileSync(carrierFile, 'upgrade-carrier');
  fs.writeFileSync(bridgeFile, 'upgrade-bridge');

  await f.installer.upgradeAddon({
    gameDir: f.gameDir,
    addon: {
      file: addonFile, carrierFile, compatibility: 'dx11',
      addonSha256: sha256(addonFile), carrierSha256: sha256(carrierFile)
    },
    version: 'dx12-upgrade', scan: f.scan
  });
  assert.equal(fs.readFileSync(bridge, 'utf8'), originalBridge);
  assert.equal(fs.existsSync(path.join(f.exeDir, INSTALLED_NAMES.carrier)), false);

  f.scan.chosen.apiLabel = 'DirectX 11';
  f.scan.chosen.apiResolution = { api: 'dx11', source: 'manual', evidence: [] };
  await assert.rejects(f.installer.upgradeAddon({
    gameDir: f.gameDir,
    addon: { file: addonFile, compatibility: 'dx11' },
    version: 'incomplete-dx11', scan: f.scan
  }), { code: 'ERR_PAYLOAD_MISSING' });
  await assert.rejects(f.installer.upgradeAddon({
    gameDir: f.gameDir,
    addon: {
      file: addonFile, bridgeFile, carrierFile, compatibility: 'dx11',
      addonSha256: '0'.repeat(64), bridgeSha256: sha256(bridgeFile), carrierSha256: sha256(carrierFile)
    },
    version: 'bad-hash', scan: f.scan
  }), { code: 'ERR_ADDON_INVALID' });
  await f.installer.upgradeAddon({
    gameDir: f.gameDir,
    addon: {
      file: addonFile, bridgeFile, carrierFile, compatibility: 'dx11',
      addonSha256: sha256(addonFile), bridgeSha256: sha256(bridgeFile), carrierSha256: sha256(carrierFile)
    },
    version: 'complete-dx11', scan: f.scan
  });
  assert.equal(fs.readFileSync(bridge, 'utf8'), 'upgrade-bridge');
  assert.equal(fs.readFileSync(path.join(f.exeDir, INSTALLED_NAMES.carrier), 'utf8'), 'upgrade-carrier');
});

test('changed managed carrier is not overwritten by repair or uninstall', async t => {
  const f = fixture(t, 'dx11');
  await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  const carrier = path.join(f.exeDir, INSTALLED_NAMES.carrier);
  fs.writeFileSync(carrier, 'user changed carrier');

  await assert.rejects(f.installer.repair({ gameDir: f.gameDir, payload: f.payload, scan: f.scan }), { code: 'ERR_FILE_CHANGED' });
  assert.equal(fs.readFileSync(carrier, 'utf8'), 'user changed carrier');
  assert.equal(fs.existsSync(path.join(f.exeDir, `${PAYLOAD_FILES.addon}.bak`)), false, 'failed repair rolls back sidecar backups');

  const removed = await f.installer.uninstall({ gameDir: f.gameDir, scan: f.scan });
  assert.equal(removed.removed, false);
  assert.equal(removed.warnings.some(row => row.rel.endsWith(INSTALLED_NAMES.carrier)), true);
  assert.equal(fs.readFileSync(carrier, 'utf8'), 'user changed carrier');
  assert.equal(fs.existsSync(path.join(f.exeDir, INSTALLED_NAMES.bridge)), true, 'uninstall preflight prevents partial removal');
});

test('real journal restores earlier conflict moves and managed writes after a later install failure', async t => {
  const f = fixture(t, 'dx12');
  const conflict = path.join(f.exeDir, 'old-nr-before-sr.addon64');
  fs.writeFileSync(conflict, 'old conflict');
  f.payload.addon.file = path.join(f.root, 'missing.addon64');

  await assert.rejects(f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan }), { code: 'ERR_PAYLOAD_HASH' });
  assert.equal(fs.readFileSync(conflict, 'utf8'), 'old conflict');
  assert.equal(fs.existsSync(path.join(f.exeDir, INSTALLED_NAMES.reshade)), false);
  assert.equal(fs.existsSync(manifestPath(f.gameDir)), false);
  assert.equal(fs.existsSync(journal.pendingPath(f.gameDir)), false);
});

test('late uninstall commit failure restores install state and retains persistent original backups', async t => {
  const f = fixture(t, 'dx12');
  const runtime = path.join(f.exeDir, INSTALLED_NAMES.runtime);
  fs.writeFileSync(runtime, 'original runtime');
  await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  const manifest = JSON.parse(fs.readFileSync(manifestPath(f.gameDir), 'utf8'));
  const runtimeEntry = manifest.files.find(row => row.kind === 'runtime');
  const originalBackup = path.join(f.gameDir, runtimeEntry.original.backupRel);
  assert.equal(fs.readFileSync(originalBackup, 'utf8'), 'original runtime');

  const realUnlink = fs.promises.unlink;
  let injected = false;
  fs.promises.unlink = async file => {
    if (!injected && path.resolve(file) === path.resolve(journal.pendingPath(f.gameDir))) {
      injected = true;
      throw new Error('injected late commit failure');
    }
    return realUnlink.call(fs.promises, file);
  };
  try {
    await assert.rejects(f.installer.uninstall({ gameDir: f.gameDir, scan: f.scan }), /injected late commit failure/);
  } finally {
    fs.promises.unlink = realUnlink;
  }
  assert.equal(fs.existsSync(manifestPath(f.gameDir)), true);
  assert.equal(fs.readFileSync(runtime, 'utf8'), 'payload-runtime');
  assert.equal(fs.readFileSync(originalBackup, 'utf8'), 'original runtime');
  assert.equal(fs.existsSync(journal.pendingPath(f.gameDir)), false);
});

test('corrupt original or conflict backups stop uninstall before altering the installation', async t => {
  const f = fixture(t, 'dx12');
  const runtime = path.join(f.exeDir, INSTALLED_NAMES.runtime);
  const oldCarrier = path.join(f.exeDir, 'r3-nr-native-neutral.addon64');
  fs.writeFileSync(runtime, 'original runtime'); fs.writeFileSync(oldCarrier, 'original carrier');
  await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  const manifest = JSON.parse(fs.readFileSync(manifestPath(f.gameDir), 'utf8'));
  const backup = path.join(f.gameDir, manifest.files.find(row => row.kind === 'runtime').original.backupRel);
  fs.writeFileSync(backup, 'corrupt');
  await assert.rejects(f.installer.uninstall({ gameDir: f.gameDir, scan: f.scan }), { code: 'ERR_BACKUP_INVALID' });
  assert.equal(fs.readFileSync(runtime, 'utf8'), 'payload-runtime');
  fs.writeFileSync(backup, 'original runtime');
  fs.writeFileSync(path.join(f.gameDir, manifest.conflicts[0].backupRel), 'corrupt conflict');
  await assert.rejects(f.installer.uninstall({ gameDir: f.gameDir, scan: f.scan }), { code: 'ERR_BACKUP_INVALID' });
  assert.equal(fs.existsSync(oldCarrier), false);
  assert.equal(fs.readFileSync(runtime, 'utf8'), 'payload-runtime');
});

test('direct DX11 repair reinstates the carrier regardless of a historical manual-off flag', async t => {
  const f = fixture(t, 'dx11');
  await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  await f.installer.disableCarrier({ gameDir: f.gameDir, scan: f.scan });
  assert.equal(fs.existsSync(path.join(f.exeDir, INSTALLED_NAMES.carrier)), false);
  const disabled = await f.installer.diagnose({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  assert.equal(disabled.components.find(row => row.key === 'carrier').detail, '文件缺失');
  await f.installer.repair({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  assert.equal(fs.existsSync(path.join(f.exeDir, INSTALLED_NAMES.carrier)), true);
});

test('repair rejects a payload changed after requirePayload validation without touching installed state', async t => {
  const f = fixture(t, 'dx12'); await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  const target = path.join(f.exeDir, INSTALLED_NAMES.addon), manifestFile = manifestPath(f.gameDir);
  const before = { target: fs.readFileSync(target), manifest: fs.readFileSync(manifestFile), entries: fs.readdirSync(f.exeDir).sort() };
  fs.writeFileSync(f.payload.addon.file, 'changed-after-payload-validation');
  await assert.rejects(f.installer.repair({ gameDir: f.gameDir, payload: f.payload, scan: f.scan }), error =>
    error.code === 'ERR_PAYLOAD_HASH' && error.details?.reason === 'source-changed');
  assert.deepEqual(fs.readFileSync(target), before.target); assert.deepEqual(fs.readFileSync(manifestFile), before.manifest);
  assert.deepEqual(fs.readdirSync(f.exeDir).sort(), before.entries); assert.equal(fs.existsSync(journal.pendingPath(f.gameDir)), false);
});

test('OTA source drift between pre-copy hash and copy rolls back target, backup and receipt', async t => {
  let driftSource = null;
  const f = fixture(t, 'dx12', { copyFile: async (source, target) => {
    if (source === driftSource) fs.writeFileSync(source, 'changed-during-copy');
    await fs.promises.copyFile(source, target);
  } });
  await f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  const target = path.join(f.exeDir, INSTALLED_NAMES.addon), manifestFile = manifestPath(f.gameDir), replacement = path.join(f.root, 'ota.addon64');
  fs.writeFileSync(replacement, 'verified-ota-addon'); const expected = sha256(replacement); driftSource = replacement;
  const before = { target: fs.readFileSync(target), manifest: fs.readFileSync(manifestFile), entries: fs.readdirSync(f.exeDir).sort() };
  await assert.rejects(f.installer.upgradeAddon({ gameDir: f.gameDir,
    addon: { id: 'drift-ota', file: replacement, addonSha256: expected }, version: 'drift-ota', scan: f.scan }), error =>
    error.code === 'ERR_PAYLOAD_HASH' && error.details?.reason === 'copy-changed');
  assert.deepEqual(fs.readFileSync(target), before.target); assert.deepEqual(fs.readFileSync(manifestFile), before.manifest);
  assert.deepEqual(fs.readdirSync(f.exeDir).sort(), before.entries); assert.equal(fs.existsSync(journal.pendingPath(f.gameDir)), false);
});

test('first-install config drift rolls back every earlier managed payload write', async t => {
  let driftSource = null;
  const f = fixture(t, 'dx12', { copyFile: async (source, target) => {
    if (source === driftSource) fs.writeFileSync(source, 'changed-config-during-copy');
    await fs.promises.copyFile(source, target);
  } });
  driftSource = f.payload.config.file;
  await assert.rejects(f.installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan }), error =>
    error.code === 'ERR_PAYLOAD_HASH' && error.details?.reason === 'copy-changed');
  for (const kind of ['reshade', 'addon', 'bridge', 'runtime', 'config']) assert.equal(fs.existsSync(path.join(f.exeDir, INSTALLED_NAMES[kind])), false, `${kind} rolled back`);
  assert.equal(fs.existsSync(manifestPath(f.gameDir)), false); assert.equal(fs.existsSync(journal.pendingPath(f.gameDir)), false);
});
