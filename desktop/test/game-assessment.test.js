'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGameAssessment } = require('../src/product/game-assessment');

function fixture() {
  const calls = [], read = (name, value) => () => { calls.push(name); return typeof value === 'function' ? value() : structuredClone(value); };
  const scan = { chosen: { path: 'C:/fixture/game.exe', bitness: 64, detectedApi: 'dx12',
    apiResolution: { api: 'dx12', source: 'exe-imports' },
    apiAssessment: { effectiveApi: 'dx12', capabilities: ['dx12'], conflicts: [], evidence: [], confidence: 'high' } }, dlssFiles: [], streamlineFiles: [] };
  const game = { id: 'game', name: 'Fixture', installed: false, addonVersion: null, apiOverride: 'auto',
    dir: 'C:/fixture', chosen: structuredClone(scan.chosen), nativeDlssAvailable: true, nativeFgAvailable: true };
  const layout = { mode: 'local', source: 'game-directory', loadingMode: 'proxy', runtimeDir: 'C:/fixture',
    activeConfigPath: 'C:/fixture/ReShade.ini', needsRecovery: false, verified: true };
  const defaults = { api: 'auto', version: '0.4.7beta', deployment: 'external', loadingMode: 'proxy', route: 'native' };
  const catalog = [{ id: '0.4.7beta', ready: true, comparisonOnly: false, verification: 'metadata-only' },
    { id: '0.4.7beta-bg3-bridge1411', ready: true, comparisonOnly: true, verification: 'metadata-only',
      compatibilityEvidence: { steamAppId: '1086940', api: 'dx11', actualNrVerified: false } }];
  const currentSession = { sessionId: 'current-session', gameId: 'game', targetExe: 'C:/fixture/game.exe', historical: false };
  const service = {
    assessmentSeed: read('seed', () => structuredClone({ ...game, scan })), listGames: read('library', () => [structuredClone(game)]),
    gameScan: read('scan', () => structuredClone(scan)), getLayout: read('layout', () => structuredClone(layout)), gameDirectory: () => game.dir,
    coreVersionCatalog: read('catalog', catalog), listAddonVersions: read('verified-versions', catalog),
    installationDefaults: read('defaults', () => structuredClone(defaults)),
    readNrSettings: read('nr', { Enabled: 1, Intensity: 1 }), readGameHotkeys: read('hotkeys', { reshade: { key: 36 } }),
    inspectDeployment: read('deployment-hashes', { installed: true, mode: 'external', version: '0.4.7beta', verified: true, files: [{ valid: true }] })
  };
  const options = { service, coordinator: { inspect: read('enhancements', { featureStates: { sr: { eligible: false, canConfirm: true } }, applied: {}, requests: {} }) },
    environment: { inspect: read('environment', { remainingFiles: [] }) }, operations: { inspect: read('operation', { pending: false }) },
    launches: { inspect: read('session', currentSession) }, launchMode: read('launch', { selected: 'auto', effective: 'steam', steamAvailable: true }),
    verification: { assess: read('runtime', { helper: { status: 'passed' }, core: { status: 'passed' }, nr: { status: 'passed' }, visual: { status: 'unverified' } }) },
    records: { inspect: read('visual', { status: 'passed', source: 'user-comparison' }) },
    components: { inspect: read('components', { files: [], conflicts: [], warnings: [] }) },
    helper: { inspect: read('helper-modules', { ready: true, modules: [] }) },
    hardware: read('hardware', { series: ['RTX40'], family: 'RTX40' }), antiCheatPresent: read('anti-cheat', false) };
  return { calls, game, scan, layout, defaults, catalog, service, options, assessment: createGameAssessment(options) };
}

test('installation uses the cached seed and metadata catalog without reading diagnostics or SR/FG', async () => {
  const f = fixture(), result = await f.assessment.assess('game', { sections: ['installation'] });
  assert.deepEqual(result.sections, ['installation']);
  for (const field of ['game', 'api', 'hardware', 'nativeIntegration', 'layout', 'deployment', 'coreVersions', 'defaults', 'nr', 'hotkeys', 'operation', 'antiCheat', 'launch'])
    assert.ok(Object.hasOwn(result, field), field);
  for (const field of ['maintenance', 'verification', 'components', 'conflicts', 'helperModules', 'enhancements']) assert.equal(Object.hasOwn(result, field), false, field);
  for (const method of ['library', 'verified-versions', 'deployment-hashes', 'runtime', 'environment', 'components', 'helper-modules', 'visual', 'enhancements'])
    assert.equal(f.calls.includes(method), false, method);
  assert.equal(result.defaults.version, '0.4.7beta'); assert.equal(result.defaults.deployment, 'external'); assert.equal(result.defaults.loadingMode, 'proxy');
  assert.equal(result.deployment.inspection, 'summary'); assert.equal(result.deployment.verified, false); assert.equal(result.deployment.filesVerified, false);
  const comparison = result.coreVersions.find(row => row.id === f.catalog[1].id);
  assert.equal(comparison.comparisonOnly, true); assert.deepEqual(comparison.compatibilityEvidence, f.catalog[1].compatibilityEvidence);
  assert.equal(result.coreVersions.find(row => row.id === f.catalog[0].id).verification, 'metadata-only');
});

test('installation exposes lightweight launch readiness without requiring the full enhancement inspection', async () => {
  const f = fixture();
  f.options.coordinator.inspectLaunchReadiness = async () => ({ state: 'blocked', known: true, source: 'metadata', blockers: [
    { domain: 'sr', code: 'SETTINGS_LEGACY_APPLY_REQUIRED', message: '旧 SR 需要处理。', action: { kind: 'open-settings' } }
  ], pending: [], requests: {}, legacy: { configured: true } });
  const result = await f.assessment.assess('game', { sections: ['installation'] });
  assert.equal(result.launch.readiness.state, 'blocked');
  assert.equal(result.launch.readiness.blockers[0].action.kind, 'open-settings');
  assert.equal(f.calls.includes('enhancements'), false);
});

test('enhancement inspection can refine an unknown launch readiness with readback evidence', async () => {
  const f = fixture();
  f.options.coordinator.inspectLaunchReadiness = async (_id, observed) => {
    assert.deepEqual(observed.requests, {});
    return { state: 'ready', known: true, source: 'settings-inspection', blockers: [], pending: [], requests: {} };
  };
  const result = await f.assessment.assess('game', { sections: ['enhancements'] });
  assert.equal(result.enhancements.launchReadiness.state, 'ready');
});

test('a historical failed launch record does not become the current launch blocker', async () => {
  const f = fixture();
  f.options.launches.inspect = async () => ({ sessionId: 'old', gameId: 'game', historical: true, status: 'failed', error: { code: 'OLD_FAILURE' } });
  f.options.coordinator.inspectLaunchReadiness = async () => ({ state: 'ready', known: true, source: 'metadata', blockers: [], pending: [], requests: {} });
  const result = await f.assessment.assess('game', { sections: ['installation'] });
  assert.equal(result.launch.session.historical, true); assert.equal(result.launch.readiness.state, 'ready');
});

test('an unreadable deployment cannot promote stale inventory into installed or ready', async () => {
  const f = fixture(); f.game.installed = true; f.game.addonVersion = '0.4.7beta';
  f.service.getLayout = () => { throw Object.assign(new Error('original transaction mismatch'), { code: 'DEPLOYMENT_RECORD' }); };
  const result = await f.assessment.assess('game', { sections: ['installation'] });
  assert.equal(result.game.installed, false); assert.equal(result.deployment.installed, false);
  assert.equal(result.deployment.needsRecovery, false); assert.equal(result.deployment.inspectionFailed, true); assert.equal(result.deployment.layoutVerified, false);
  assert.ok(result.failures.some(row => row.code === 'DEPLOYMENT_RECORD'));
});

test('unreadable operation state is a retryable inspection failure, not a fabricated recovery transaction', async () => {
  const f = fixture();
  f.options.operations.inspect = async () => { throw Object.assign(new Error('record permission denied'), { code: 'EACCES' }); };
  const result = await f.assessment.assess('game', { sections: ['installation'] });
  assert.equal(result.operation.pending, false);
  assert.equal(result.operation.inspectionFailed, true);
  assert.ok(result.failures.some(row => row.section === 'operation' && row.code === 'EACCES'));
  f.options.operations.inspect = async () => ({ pending: false });
  const retry = await f.assessment.assess('game', { sections: ['installation'] });
  assert.equal(retry.operation.inspectionFailed, undefined);
});

test('slow diagnostic verification does not delay a separate installation request', { timeout: 2000 }, async () => {
  const f = fixture(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.service.inspectDeployment = () => { f.calls.push('deployment-hashes'); return gate; };
  const diagnostics = f.assessment.assess('game', { sections: ['diagnostics'] });
  try {
    await new Promise(setImmediate);
    assert.ok(f.calls.includes('deployment-hashes'));
    const result = await f.assessment.assess('game', { sections: ['installation'] });
    assert.equal(result.game.id, 'game'); assert.equal(result.defaults.version, '0.4.7beta');
    assert.equal(f.calls.filter(name => name === 'deployment-hashes').length, 1);
  } finally { release({ installed: true, verified: true }); }
  assert.equal((await diagnostics).deployment.verified, true);
});

test('enhancements read only the requested SR/FG state', async () => {
  const f = fixture(), result = await f.assessment.assess('game', { sections: ['enhancements'] });
  assert.deepEqual(f.calls, ['seed', 'enhancements']);
  assert.equal(result.enhancements.featureStates.sr.canConfirm, true);
  assert.equal(Object.hasOwn(result, 'game'), false); assert.equal(Object.hasOwn(result, 'nr'), false);
  assert.equal(Object.hasOwn(result, 'deployment'), false);
});

test('diagnostics leave installation fields untouched and keep user observations separate', async () => {
  const f = fixture(), result = await f.assessment.assess('game', { sections: ['diagnostics'] });
  for (const method of ['nr', 'hotkeys', 'catalog', 'verified-versions', 'defaults', 'anti-cheat', 'enhancements']) assert.equal(f.calls.includes(method), false, method);
  assert.equal(result.verification.visual.source, 'user-comparison'); assert.equal(result.verification.nr.status, 'passed');
  assert.equal(result.deployment.verified, true); assert.equal(Object.hasOwn(result, 'defaults'), false);
  assert.equal(Object.hasOwn(result, 'api'), false);
});

test('the existing no-options call retains all original top-level assessment fields', async () => {
  const f = fixture(), result = await f.assessment.assess('game');
  assert.deepEqual(result.sections, ['installation', 'enhancements', 'diagnostics']);
  for (const field of ['game', 'api', 'deployment', 'layout', 'hardware', 'nativeIntegration', 'enhancements', 'nr', 'hotkeys', 'components', 'conflicts',
    'maintenance', 'operation', 'launch', 'verification', 'coreVersions', 'failures', 'helperModules', 'antiCheat']) assert.ok(Object.hasOwn(result, field), field);
  assert.ok(f.calls.includes('library')); assert.ok(f.calls.includes('verified-versions'));
  assert.equal(result.deployment.verified, true); assert.equal(result.launch.session.sessionId, 'current-session');
  assert.equal(f.calls.filter(method => method === 'session').length, 1); assert.equal(f.calls.filter(method => method === 'layout').length, 1);
});

test('a mixed API is explicitly marked for manual selection while resolved Core defaults remain visible', async () => {
  const f = fixture(); f.scan.chosen.detectedApi = 'mixed'; f.scan.chosen.apiResolution.api = 'mixed'; f.scan.chosen.apiAssessment.effectiveApi = 'mixed';
  const result = await f.assessment.assess('game', { sections: ['installation'] });
  assert.equal(result.api.effectiveApi, 'mixed'); assert.equal(result.api.requiresManualSelection, true);
  assert.equal(result.defaults.api, 'auto'); assert.equal(result.defaults.requiresApiSelection, true); assert.equal(result.defaults.version, '0.4.7beta');
});

test('a manual override does not hide the independent automatic detection result', async () => {
  const f = fixture(); f.game.apiOverride = 'dx12'; f.defaults.api = 'dx12';
  f.scan.chosen.detectedApi = 'mixed'; f.scan.chosen.detectedApiResolution = { api: 'mixed', source: 'exe-imports' };
  f.scan.chosen.apiResolution = { api: 'dx12', source: 'override' }; f.scan.chosen.apiAssessment.source = 'override';
  const result = await f.assessment.assess('game', { sections: ['installation'] });
  assert.equal(result.api.effectiveApi, 'dx12'); assert.equal(result.api.detectedApi, 'mixed');
  assert.equal(result.api.requiresManualSelection, false);
});

test('summary ownership and the current version are retained for existing external installations', async () => {
  const f = fixture(); Object.assign(f.layout, { mode: 'external', source: 'xiaofeng-external-runtime', loadingMode: 'helper', version: 'core-in-use' });
  Object.assign(f.defaults, { deployment: 'external', loadingMode: 'helper', version: 'core-in-use' });
  const result = await f.assessment.assess('game', { sections: ['installation'] });
  assert.equal(result.game.installed, true); assert.equal(result.game.addonVersion, 'core-in-use');
  assert.equal(result.defaults.version, 'core-in-use'); assert.equal(result.defaults.loadingMode, 'helper');
});

for (const route of ['vulkan', 'feeder']) test(`installation retains ${route} fixed-package metadata without treating availability as installation`, async () => {
  const f = fixture(), selectedApi = route === 'vulkan' ? 'vulkan' : 'dx12';
  f.game[route] = { packageId: 'fixed-' + route, coreVersion: 'core-' + route, installed: false, available: true, selectionAvailable: true };
  f.scan.chosen.detectedApi = selectedApi; f.scan.chosen.apiResolution.api = selectedApi; f.scan.chosen.apiAssessment.effectiveApi = selectedApi;
  Object.assign(f.defaults, { api: 'auto', version: 'fixed-' + route, route, deployment: route === 'vulkan' ? 'external' : 'local' });
  const result = await f.assessment.assess('game', { sections: ['installation'] });
  assert.deepEqual(result.game[route], f.game[route]); assert.equal(result.game.installed, false);
  assert.equal(result.defaults.version, 'fixed-' + route); assert.equal(result.defaults.route, route);
});

test('section validation rejects malformed renderer input before any service read', async () => {
  const f = fixture();
  for (const options of [null, [], {}, { sections: [] }, { sections: 'installation' }, { sections: ['all'] },
    { sections: ['installation', 'installation'] }, { sections: ['installation'], paths: ['C:/arbitrary'] }])
    await assert.rejects(f.assessment.assess('game', options), { code: 'ASSESSMENT_BAD_REQUEST' });
  assert.deepEqual(f.calls, []);
});

test('section failures are visible without introducing absent-section placeholders', async () => {
  const f = fixture(); f.options.coordinator.inspect = async () => { throw Object.assign(new Error('driver unavailable'), { code: 'DRIVER_UNAVAILABLE' }); };
  const result = await f.assessment.assess('game', { sections: ['enhancements'] });
  assert.equal(result.enhancements.unavailable, true);
  assert.deepEqual(result.failures, [{ section: 'enhancements', code: 'DRIVER_UNAVAILABLE', message: 'driver unavailable' }]);
  assert.equal(Object.hasOwn(result, 'verification'), false);
});

test('failure to resolve an installation default never silently picks the first catalog entry', async () => {
  const f = fixture(); f.service.installationDefaults = () => { throw Object.assign(new Error('default unavailable'), { code: 'ERR_ADDON_NOT_FOUND' }); };
  const result = await f.assessment.assess('game', { sections: ['installation'] });
  assert.equal(result.defaults.version, null);
  assert.ok(result.failures.some(row => row.section === 'defaults' && row.code === 'ERR_ADDON_NOT_FOUND'));
  assert.deepEqual(result.coreVersions.filter(row => row.source !== 'menu-placeholder').map(row => row.id), f.catalog.map(row => row.id));
  assert.ok(result.coreVersions.filter(row => row.source === 'menu-placeholder').every(row => row.ready === false));
});
