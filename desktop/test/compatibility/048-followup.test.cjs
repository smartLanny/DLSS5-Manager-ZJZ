'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSession, createReport, exactGroup, validateReport } = require('../../src/compatibility/model.cjs');
const { aggregate } = require('../../src/compatibility/inbox.cjs');
const { createCompatibilityFeedback } = require('../../src/product/compatibility-feedback');
const f = require('./fixtures.cjs');
function partialGame(name) { return f.session({ game: { name, exeName: 'game.exe', api: 'dx12' } }); }
function inventorySession(version, reverse = false) {
  const gpus = [{ id: 'temporary-1', name: 'NVIDIA test', driverRaw: version }, { id: 'temporary-2', name: 'Intel test', driverRaw: '1' }];
  return f.session({ environment: { gpus: reverse ? gpus.reverse() : gpus } });
}
test('different games without EXE hashes/store IDs never share one bucket', () => {
  const rows = aggregate([f.report(partialGame('游戏甲')), f.report(partialGame('游戏乙'))]);
  assert.equal(rows.groups.length, 2);
  assert(rows.groups.every(g => !g.complete));
});
test('unknown render GPU retains driver inventories as separate conditions', () => {
  const rows = aggregate([f.report(inventorySession('32.0.1')), f.report(inventorySession('32.0.2'))]);
  assert.equal(rows.groups.length, 2);
  assert(rows.groups.every(g => !g.complete && g.conditions.gpuBinding === 'inventory-only'));
  assert(rows.groups.every(g => g.conditions.gpu === null));
});
test('inventory ordering and temporary adapter IDs are not identity', () => {
  const a = inventorySession('32.0.1'), b = inventorySession('32.0.1', true);
  assert.equal(exactGroup({ session: a }).key, exactGroup({ session: b }).key);
});
test('current manual snapshot cannot inherit completeness from launch snapshots', () => {
  const base = { scope: 'game', configuration: { generation: 1, settingsFingerprint: 'c'.repeat(64) } };
  const a = f.session({ ...base, contextSource: 'launch-snapshot' });
  const b = f.session({ ...base, contextSource: 'manual-snapshot' });
  const groups = aggregate([f.report(a), f.report(b)]).groups;
  assert.equal(groups.length, 2);
  assert.equal(groups.filter(g => g.complete).length, 1);
});
test('a launcher/client difference remains a separate compatibility condition', () => {
  const a = f.session({ game: { name: 'Game', exeName: 'game.exe', launcher: 'A', api: 'dx12' } });
  const b = f.session({ game: { name: 'Game', exeName: 'game.exe', launcher: 'B', api: 'dx12' } });
  assert.notEqual(exactGroup({ session: a }).key, exactGroup({ session: b }).key);
});
for (const [name, change] of [
  ['OS object smuggling', r => { r.session.environment.os.platform = { command: 'no' }; }],
  ['invalid API enum', r => { r.session.game.api = 'whatever'; }],
  ['malformed executable hash', r => { r.session.game.exeSha256 = 'not-a-hash'; }],
  ['object warning payload', r => { r.warnings.push({ text: 'wrong' }); }],
  ['invalid ignored count', r => { r.outcome.ignoredObservationCount = -1; }],
  ['object evidence reason', r => { r.outcome.stages.nr.reason = { text: 'wrong' }; }]
]) test('import refuses ' + name, () => { const r = structuredClone(f.report()); change(r); assert.throws(() => validateReport(r)); });

const SESSION = '33333333-1111-4111-8111-111111111111';
function fixture() {
  const flags = { modulesFail: false, sessionFail: false, sessionRecordUnavailable: false, diagnosticsFail: false, diagnosticsWrong: false };
  let written = 0;
  const session = { sessionId: SESSION, requestedAt: '2026-09-11T01:00:00Z', targetExe: '/test/game.exe',
    process: { exe: '/test/game.exe', pid: 12 }, historical: false };
  const data = { gameId: 'sample', game: { name: '测试游戏', version: '1', chosen: { path: '/test/game.exe' } },
    layout: { exe: '/test/game.exe', inputRoute: 'native', version: '0.4.7beta', activeConfigPath: '/private/a.ini', runtimeDir: '/private/a', generation: 1 },
    api: { effectiveApi: 'dx12' }, nr: { Intensity: 1.2 }, enhancements: {}, failures: [] };
  const service = createCompatibilityFeedback({
    assessment: { assess: async (_id, opts) => {
      if (opts.sections[0] === 'diagnostics') {
        if (flags.diagnosticsFail) throw new Error('unreadable process');
        return { gameId: flags.diagnosticsWrong ? 'another-game' : 'sample', verification: { nr: { status: 'passed', evidence: [{ success: 2 }] } } };
      }
      return structuredClone(data);
    } },
    sessions: { inspect: async () => {
      if (flags.sessionFail) throw new Error('unreadable receipt');
      if (flags.sessionRecordUnavailable) return { status: 'record-unavailable', gameId: 'sample' };
      return structuredClone(session);
    } },
    modules: async () => { if (flags.modulesFail) throw new Error('invalid manifest'); return [{ role: 'core', sha256: 'a'.repeat(64), version: '0.4.7beta' }]; },
    drivers: async () => ({ gpus: [], os: { platform: 'fixture' } }),
    writePackage: async () => { written++; return { saved: true }; },
    managerVersion: 'test', now: () => new Date('2026-09-11T01:01:00Z')
  });
  return { service, flags, data, session, writes: () => written };
}
const request = { ratings: { playability: 'cannot-start' }, includeLogs: false };
test('broken component manifest no longer prevents failure feedback', async () => {
  const f = fixture(); f.flags.modulesFail = true;
  await f.service.captureLaunch('sample', f.session);
  const c = await f.service.open('sample'); assert.equal(c.contextSource, 'manual-snapshot');
  const p = await f.service.preview(c.token, request);
  assert(p.report.warnings.includes('COMPONENT_INVENTORY_UNAVAILABLE'));
  assert.equal(p.report.outcome.stages.loaded.state, 'unknown');
  await f.service.save(c.token, { previewId: p.previewId, confirmed: true }); assert.equal(f.writes(), 1);
});
test('unreadable launch receipt still allows a clearly manual report', async () => {
  const f = fixture(); f.flags.sessionFail = true;
  const c = await f.service.open('sample'); const p = await f.service.preview(c.token, request);
  assert.equal(p.report.session.contextSource, 'manual-snapshot');
  assert(p.report.warnings.includes('SESSION_RECORD_UNAVAILABLE'));
  assert.equal(p.report.outcome.stages.nr.state, 'unknown');
});
test('record-unavailable launch receipt status is reported as missing metadata', async () => {
  const f = fixture(); f.flags.sessionRecordUnavailable = true;
  const c = await f.service.open('sample'); const p = await f.service.preview(c.token, request);
  assert.equal(p.report.session.contextSource, 'manual-snapshot');
  assert(p.report.warnings.includes('SESSION_RECORD_UNAVAILABLE'));
  assert.equal(p.report.outcome.stages.nr.state, 'unknown');
});
test('runtime inspection failure does not prevent collecting user experience', async () => {
  const f = fixture(); f.flags.diagnosticsFail = true;
  const c = await f.service.open('sample'); const p = await f.service.preview(c.token, request);
  assert(p.report.warnings.includes('RUNTIME_INSPECTION_UNAVAILABLE'));
  assert.equal(p.report.ratings.playability, 'cannot-start');
});
test('wrong-game diagnostic result is rejected, not translated into success', async () => {
  const f = fixture(); const c = await f.service.open('sample'); f.flags.diagnosticsWrong = true;
  await assert.rejects(f.service.preview(c.token, request), { code: 'COMPATIBILITY_TARGET' });
});
for (const [key, value] of [['activeConfigPath', '/other/config.ini'], ['runtimeDir', '/other/runtime'], ['mode', 'external']]) {
  test('changing ' + key + ' invalidates an already previewed package', async () => {
    const f = fixture(), c = await f.service.open('sample'), p = await f.service.preview(c.token, request);
    f.data.layout[key] = value;
    await assert.rejects(f.service.save(c.token, { previewId: p.previewId, confirmed: true }), { code: 'SESSION_CHANGED' });
    assert.equal(f.writes(), 0);
  });
}
test('updated game version invalidates an already previewed package', async () => {
  const f = fixture(), c = await f.service.open('sample'), p = await f.service.preview(c.token, request);
  f.data.game.version = '2';
  await assert.rejects(f.service.save(c.token, { previewId: p.previewId, confirmed: true }), { code: 'SESSION_CHANGED' });
});
test('partial launch assessment cannot create an exact launch claim', async () => {
  const f = fixture(); f.data.failures = [{ section: 'nr', code: 'READ_FAILED' }];
  await f.service.captureLaunch('sample', f.session);
  const c = await f.service.open('sample'); const p = await f.service.preview(c.token, request);
  assert.equal(c.contextSource, 'manual-snapshot');
  assert(p.report.warnings.includes('ASSESSMENT_PARTIAL'));
});
test('only approved missing-data reason codes enter report warnings', () => {
  const s = f.session();
  const r = createReport(s, {}, { limitations: ['RUNTIME_INSPECTION_UNAVAILABLE', 'arbitrary', { secret: 'bad' }] }, { now: () => new Date('2026-09-11T01:01:00Z') });
  assert(r.warnings.includes('RUNTIME_INSPECTION_UNAVAILABLE')); assert(!r.warnings.includes('arbitrary'));
});
