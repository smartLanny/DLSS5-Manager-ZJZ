'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSrModelService } = require('../src/product/sr-model-service');

function baseline() {
  return {
    ok: true,
    profileFound: true,
    enable: { explicit: true, value: 1 },
    preset: { explicit: true, value: 11 }
  };
}

test('concurrent game policy writes keep both records across service instances', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-concurrent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { userData: root, appDir: root, gameDirectory: id => path.join(root, id),
    gameExecutable: id => path.join(root, id, 'game.exe'), detectHardware: () => ({ series: ['RTX40'] }), nvapi: {} };
  const first = createSrModelService(options), second = createSrModelService(options);
  await Promise.all([first.write('a', 'k'), second.write('b', 'm')]);
  assert.equal((await first.read('a')).selection, 'k');
  assert.equal((await second.read('b')).selection, 'm');
  await assert.rejects(first.write('a', 'invalid'));
  await second.write('a', 'l');
  assert.equal((await first.read('a')).selection, 'l');
  assert.equal((await first.read('b')).selection, 'm');
});

test('opening SR controls without an explicit selection never creates an automatic driver override', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'xiaofeng-sr-unconfigured-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const game=path.join(root,'game');fs.mkdirSync(game);const exe=path.join(game,'game.exe');fs.writeFileSync(exe,'');
  const fail=async()=>{throw Error('unconfigured launch must not access NVIDIA settings');};
  const service=createSrModelService({userData:path.join(root,'user'),resourcesPath:root,appDir:root,gameDirectory:()=>game,gameExecutable:()=>exe,
    detectHardware:()=>({family:'RTX50',series:['RTX50']}),nvapi:{readSrState:fail,applySrPreset:fail,restoreSrState:fail}});
  assert.equal((await service.read('g')).recommended,'m');
  assert.equal((await service.migrationInfo('g')).baselineCaptured,false);
  const result=await service.applyBeforeLaunch('g');assert.equal(result.apply.ok,true);assert.equal(result.apply.skipped,true);
  assert.equal(fs.existsSync(service.policyFile),false);
});

test('per-game SR model selection persists and auto resolves from GPU series', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-sr-model-'));
  const gameDir = path.join(root, 'GameA');
  const exe = path.join(gameDir, 'game.exe');
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(exe, '');
  const calls = [];
  const options = {
    userData: path.join(root, 'userdata'),
    resourcesPath: root,
    appDir: root,
    gameDirectory: () => gameDir,
    gameExecutable: () => exe,
    detectHardware: () => ({ family: 'RTX50', series: ['RTX50'], names: ['NVIDIA GeForce RTX 5090'] }),
    nvapi: {
      readSrState: async () => baseline(),
      applySrPreset: async request => { calls.push(request); return { ok: true, rawPreset: 13 }; },
      restoreSrState: async () => ({ ok: true, restored: true })
    }
  };
  const service = createSrModelService(options);
  assert.equal((await service.read('a')).selection, 'auto');
  assert.equal((await service.read('a')).effective, 'm');
  assert.equal((await service.write('a', 'k')).selection, 'k');

  const restarted = createSrModelService(options);
  assert.equal((await restarted.read('a')).selection, 'k');
  const applied = await restarted.applyBeforeLaunch('a');
  assert.equal(applied.effective, 'k');
  assert.equal(calls[0].preset, 'k');
  assert.equal((await restarted.read('a')).baselineCaptured, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('default is a no-op until manager owns an override, then restores the captured baseline', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-sr-model-'));
  const gameDir = path.join(root, 'GameB');
  const exe = path.join(gameDir, 'game.exe');
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(exe, '');
  const restored = [];
  const service = createSrModelService({
    userData: path.join(root, 'userdata'), resourcesPath: root, appDir: root,
    gameDirectory: () => gameDir, gameExecutable: () => exe,
    detectHardware: () => ({ family: 'RTX40', series: ['RTX40'], names: ['NVIDIA GeForce RTX 4090'] }),
    nvapi: {
      readSrState: async () => baseline(),
      applySrPreset: async () => ({ ok: true }),
      restoreSrState: async request => { restored.push(request); return { ok: true, restored: true }; }
    }
  });

  await service.write('b', 'default');
  const untouched = await service.applyBeforeLaunch('b');
  assert.equal(untouched.apply.ok, true);
  assert.equal(untouched.apply.skipped, true);
  assert.equal(restored.length, 0);

  await service.write('b', 'm');
  assert.equal((await service.applyBeforeLaunch('b')).apply.ok, true);
  await service.write('b', 'default');
  const result = await service.applyBeforeLaunch('b');
  assert.equal(result.apply.restored, true);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].baseline.preset.value, 11);
  assert.equal((await service.read('b')).baselineCaptured, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('unknown hardware auto policy does not touch DRS when manager has no captured baseline', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-sr-model-'));
  const gameDir = path.join(root, 'GameC');
  const exe = path.join(gameDir, 'game.exe');
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(exe, '');
  let touched = false;
  const service = createSrModelService({
    userData: path.join(root, 'userdata'), resourcesPath: root, appDir: root,
    gameDirectory: () => gameDir, gameExecutable: () => exe,
    detectHardware: () => ({ family: 'unknown', series: [], names: [] }),
    nvapi: {
      readSrState: async () => { touched = true; return baseline(); },
      applySrPreset: async () => { touched = true; return { ok: true }; },
      restoreSrState: async () => { touched = true; return { ok: true }; }
    }
  });
  const applied = await service.applyBeforeLaunch('c');
  assert.equal(applied.effective, 'default');
  assert.equal(applied.apply.skipped, true);
  assert.equal(touched, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('manager refuses to overwrite an unknown NVIDIA baseline when the safe read fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-sr-model-'));
  const gameDir = path.join(root, 'GameD');
  const exe = path.join(gameDir, 'game.exe');
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(exe, '');
  let applied = false;
  const service = createSrModelService({
    userData: path.join(root, 'userdata'), resourcesPath: root, appDir: root,
    gameDirectory: () => gameDir, gameExecutable: () => exe,
    detectHardware: () => ({ family: 'RTX50', series: ['RTX50'], names: ['NVIDIA GeForce RTX 5090'] }),
    nvapi: {
      readSrState: async () => ({ ok: false, error: 'read denied' }),
      applySrPreset: async () => { applied = true; return { ok: true }; },
      restoreSrState: async () => ({ ok: true })
    }
  });
  await service.write('d', 'auto');
  const result = await service.applyBeforeLaunch('d');
  assert.equal(result.apply.ok, false);
  assert.equal(applied, false);
  fs.rmSync(root, { recursive: true, force: true });
});
