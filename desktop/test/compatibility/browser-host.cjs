'use strict';
// Real new reporting service with existing-service doubles. Does not launch a game or load NR.
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { createCompatibilityFeedback } = require('../../src/product/compatibility-feedback');
const now = new Date();
const native = { sessionId: '88888888-1111-4111-8111-111111111111', gameId: 'sample',
  targetExe: '/test/game.exe', requestedAt: now.toISOString(), process: { exe: '/test/game.exe', pid: 42 } };
const data = { gameId: 'sample', game: { name: '示例游戏 · 隔离测试', installed: true },
  api: { effectiveApi: 'dx12' }, layout: { exe: native.targetExe, version: '0.4.7beta', inputRoute: 'native', generation: 1 },
  nr: { Intensity: 1.2, Style: 1, WorkMode: 0 }, enhancements: {},
  verification: { core: { status: 'passed', evidence: [{ pid: 42 }] }, nr: { status: 'passed', evidence: [{ success: 1 }, { success: 2 }] } } };
const service = createCompatibilityFeedback({ assessment: { assess: async () => structuredClone(data) },
  sessions: { inspect: async () => structuredClone(native) },
  modules: async () => [{ role: 'core', sha256: 'a'.repeat(64), version: '0.4.7beta' }],
  collectReport: async () => ({ text: '历史日志 C:\\Users\\example\\old.log\n不能据此判定本次运行成功。' }),
  drivers: async () => ({ gpus: [{ id: 'fixture', name: '测试显卡（模拟）', driverRaw: '32.0.15.6107' }], renderAdapter: null, os: { platform: 'fixture' } }),
  managerVersion: '0.4.8-beta.5+test', managerBuild: 'browser-fixture',
  writePackage: async pkg => {
    const root = process.env.COMPAT_TEST_OUTPUT;
    if (!root) throw new Error('Only an explicit test output directory can be used.');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, pkg.filename), pkg.bytes, { flag: 'wx' });
    return { saved: true };
  } });
const routes = { open: id => service.open(id), preview: x => service.preview(x.token, x.request),
  save: x => service.save(x.token, x.request), discard: x => service.discard(x.token, x.id), close: token => service.close(token) };
let chain = Promise.resolve();
readline.createInterface({ input: process.stdin }).on('line', line => { chain = chain.then(async () => {
  try { const req = JSON.parse(line); if (!routes[req.method]) throw Error('Unknown test method');
    process.stdout.write(JSON.stringify({ ok: true, value: await routes[req.method](req.data) }) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: { message: error.message, code: error.code } }) + '\n'); }
}); });
