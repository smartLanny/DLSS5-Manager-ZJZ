'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createGameProcesses } = require('../src/product/game-processes');
for (const bits of [32, 64]) test(`observes ${bits}-bit game modules with the matching system PowerShell and exact process generation`, async () => {
  const exe = path.resolve('Game.exe'), module = path.resolve('ReShade.dll'), seen = [];
  const current = { pid: 42, parentPid: 9, exe, startedAt: '2026-09-10T12:00:00.1234567Z', modules: [module] };
  const processes = createGameProcesses({ getBitness: () => bits, execute: async (file, args) => {
    seen.push({ file, args }); return { stdout: JSON.stringify([current, { ...current, exe: path.resolve('other/Game.exe'), pid: 43 }]) };
  } });
  const found = await processes.find(exe); assert.equal(found.length, 1); assert.equal(found[0].parentPid, 9);
  assert.ok(seen[0].file.includes('System32'));
  const result = await processes.observe(found[0]); assert.deepEqual(result.modules, [module]);
  assert.ok(seen[1].file.includes(bits === 32 ? 'SysWOW64' : 'System32'));
  assert.equal(await processes.observe({ ...found[0], startedAt: '2026-09-10T12:01:00.1234567Z' }), null);
});
