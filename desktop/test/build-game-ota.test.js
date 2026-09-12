'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { expectedRoutes, routeId, routeBases, targetFor, relative, validatePlan, validateOutput, writePackage, parseArgs } = require('../scripts/build-game-ota');

const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'game-ota-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'build'));
  // These are inert text fixtures; no DLL or host is loaded or executed.
  const sources = { core: 'fake core', chain: 'fake chain', carrier: 'fake carrier', loader: 'fake loader',
    provider: 'fake provider', host: 'fake host', 'core-config': '[NR]\nEnabled=1\n', preset: 'Techniques=',
    'api-wrapper': 'fake wrapper', RTX40: 'runtime 40', RTX50: 'runtime 50' };
  for (const [name, text] of Object.entries(sources)) fs.writeFileSync(path.join(root, name), text);
  const plan = { schema: 'game-plugin-manual-update-v1', coreVersion: '0.4.7beta', feederVersion: '0.15.1', routes: [], files: [], acceptance: { realRtx40Verified: false } };
  const staged = new Map();
  for (const wanted of expectedRoutes()) {
    const route = { ...wanted, id: routeId(wanted), files: [], bases: routeBases(wanted), hostRequired: wanted.route === 'feeder' && (wanted.architecture === 'x86' || ['dx9', 'dx10'].includes(wanted.api)) };
    const roles = ['core', 'chain', 'nr-runtime', 'core-config', ...(route.route === 'native' ? [
      ...(route.api === 'dx11' ? ['carrier'] : []), ...(route.loadingBackend === 'hoyoshade' ? ['loader'] : [])
    ] : ['provider', 'preset', ...(route.loadingBackend === 'local' ? ['game-loader'] : []),
      ...(route.api === 'dx9' ? ['api-wrapper'] : []), ...(route.hostRequired ? ['host', 'host-loader'] : [])])];
    for (const role of roles) {
      const source = role === 'nr-runtime' ? route.hardwareFamily : ['game-loader', 'host-loader'].includes(role) ? 'loader' : role;
      const content = sources[source], referenceOnly = ['core-config', 'preset'].includes(role);
      const packagePath = role === 'nr-runtime' ? `共享NR运行库/${route.hardwareFamily}/nvngx_dlssnr.dll` : `${route.id}/${role}${referenceOnly ? '.example' : '.bin'}`;
      if (!staged.has(packagePath)) {
        const file = { packagePath, source, sha256: hash(content), bytes: Buffer.byteLength(content) };
        staged.set(packagePath, file); plan.files.push(file);
      }
      const file = staged.get(packagePath);
      const target = role === 'core-config' ? 'nr_before_sr.ini' : role === 'nr-runtime' ? 'nvngx_dlssnr.dll' : `${role}.bin`;
      const prefix = route.hostRequired && ['core', 'chain', 'nr-runtime'].includes(role) ? 'host64/addons/' : '';
      route.files.push({ packagePath, target: targetFor(route, 'addon', prefix + target), role, referenceOnly, sha256: file.sha256, bytes: file.bytes });
    }
    plan.routes.push(route);
  }
  return { root, plan };
}

test('manual OTA matrix is exactly 26 routes and only formal HoYo x64 APIs', () => {
  const routes = expectedRoutes();
  assert.equal(routes.length, 26); assert.equal(new Set(routes.map(routeId)).size, 26);
  assert.equal(routes.filter(row => row.route === 'native').length, 8);
  assert.equal(routes.filter(row => row.route === 'feeder' && row.loadingBackend === 'local').length, 14);
  assert.ok(routes.filter(row => row.loadingBackend === 'hoyoshade').every(row => row.architecture === 'x64' && ['dx11', 'dx12'].includes(row.api)));
  assert.throws(() => targetFor({ id: 'hoyo', loadingBackend: 'hoyoshade' }, 'game', 'dxgi.dll'), /HoYo/);
});

test('paths, existing destinations and source scope are bounded', async t => {
  const { root } = fixture(t);
  for (const file of ['../outside', 'a/../b', '/absolute', 'C:/Windows/file', 'a\\b', 'a//b', 'a/file.', 'a/file:stream']) assert.throws(() => relative(file));
  assert.equal(relative('中文/合法文件.ini.example'), '中文/合法文件.ini.example');
  await assert.rejects(validateOutput(root, 'build'), /全新/);
  await assert.rejects(validateOutput(root, '../outside'), /全新/);
  fs.mkdirSync(path.join(root, 'build/existing'));
  await assert.rejects(validateOutput(root, 'build/existing'), /拒绝覆盖/);
  assert.equal(await validateOutput(root, 'build/new'), path.join(root, 'build/new'));
  assert.equal(parseArgs(['--output', 'build/new', '--mfg', 'build/MFG.zip']).mfg, 'build/MFG.zip');
  assert.throws(() => parseArgs(['--output']), /不完整/);
});

test('missing routes/components, active configurations and misplaced host Core abort validation', t => {
  const { plan } = fixture(t); assert.equal(validatePlan(plan), plan);
  const missing = structuredClone(plan); missing.routes.pop(); assert.throws(() => validatePlan(missing), /26/);
  const component = structuredClone(plan); component.routes[0].files = component.routes[0].files.filter(row => row.role !== 'chain');
  assert.throws(() => validatePlan(component), /组件缺失/);
  const config = structuredClone(plan); config.routes[0].files.find(row => row.role === 'core-config').referenceOnly = false;
  assert.throws(() => validatePlan(config), /个人配置/);
  const misplaced = structuredClone(plan); misplaced.routes.find(row => row.hostRequired).files.find(row => row.role === 'core').target.path = 'host64/core.bin';
  assert.throws(() => validatePlan(misplaced), /消费者组件/);
  const duplicate = structuredClone(plan); duplicate.files.push({ ...duplicate.files[0], packagePath: duplicate.files[0].packagePath.toUpperCase() });
  assert.throws(() => validatePlan(duplicate), /大小写冲突/);
});

test('changed component or catalogue aborts before creating output', async t => {
  const { root, plan } = fixture(t);
  fs.writeFileSync(path.join(root, 'core'), 'late source change');
  await assert.rejects(writePackage({ root, output: 'build/changed', plan }), /来源在预览后改变/);
  assert.equal(fs.existsSync(path.join(root, 'build/changed')), false);
  const fresh = fixture(t);
  fresh.plan.sourceSnapshots = [{ source: 'chain', sha256: hash('different manifest') }];
  await assert.rejects(writePackage({ root: fresh.root, output: 'build/changed', plan: fresh.plan }), /来源目录清单/);
  assert.equal(fs.existsSync(path.join(fresh.root, 'build/changed')), false);
});

test('inert 26-route package verifies ZIP bytes and includes exactly two shared runtimes', { timeout: 30000 }, async t => {
  const { root, plan } = fixture(t);
  const localTool = path.join(root, '7za.exe'); fs.copyFileSync(require('7zip-bin').path7za, localTool);
  const report = await writePackage({ root, output: 'build/verified', plan, zipExecutable: localTool });
  assert.equal(report.ok, true); assert.equal(report.routeCount, 26); assert.equal(report.sharedNrRuntimeCount, 2);
  assert.equal(report.managerOtaImportSupported, false); assert.equal(report.extracted, false); assert.equal(report.executed, false);
  assert.equal(report.files.filter(row => row.file.startsWith('共享NR运行库/')).length, 2);
  assert.ok(report.files.some(row => row.file === '文件校验.json'));
  assert.equal(report.verifiedFiles, plan.files.length + 1);
  await assert.rejects(writePackage({ root, output: 'build/verified', plan, zipExecutable: localTool }), /拒绝覆盖/);
});
