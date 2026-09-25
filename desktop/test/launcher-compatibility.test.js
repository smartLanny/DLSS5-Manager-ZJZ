'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveLaunchProfile, createLauncherCompatibility } = require('../src/product/launcher-compatibility');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-compat-'));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const gameRoot = path.join(root, 'game'), exe = path.join(gameRoot, 'Client', 'Game.exe'), launcher = path.join(gameRoot, 'Launcher.exe');
  fs.mkdirSync(path.dirname(exe), { recursive:true }); fs.writeFileSync(exe, 'exe'); fs.writeFileSync(launcher, 'launcher');
  return { root, gameRoot, exe, launcher };
}

test('verified Steam identity uses official applaunch without touching localconfig', t => {
  const f = fixture(t), steam = path.join(f.root, 'Steam'); fs.mkdirSync(steam); fs.writeFileSync(path.join(steam, 'steam.exe'), 'steam');
  const profile = resolveLaunchProfile('g', 'dx12', { game:{ id:'g', launcher:'Steam', verifiedSteamAppId:'1091500', steamRoot:steam,
    scan:{chosen:{path:f.exe,apiResolution:{api:'dx12'}}} } });
  assert.equal(profile.launchMode, 'steam');
  assert.deepEqual(profile.launchRequest.args, ['-applaunch', '1091500']);
  assert.match(profile.reason, /不改写 localconfig\.vdf/);
});

test('official client is the default and anti-cheat evidence never promotes direct launch', t => {
  const f = fixture(t);
  const game = { id:'nte', launcher:'Perfect World', antiCheatFiles:[path.join(f.gameRoot, 'ACE-Base.sys')], scan:{chosen:{path:f.exe,
    launchProfile:{client:'Neverness',launcherPath:f.launcher,settingsFile:path.join(f.gameRoot,'Game.ini')}}} };
  const profile = resolveLaunchProfile('nte', 'dx12', { game });
  assert.equal(profile.launchMode, 'official');
  assert.equal(profile.launchRequest.exe, f.launcher);
  assert.equal(profile.realExecutable, f.exe);
  assert.deepEqual(profile.protection.map(row => row.id), ['ace']);
  assert.match(profile.warning, /坚持官方入口/);
});

test('direct EXE requires an explicit advanced preference', t => {
  const f = fixture(t), game = { id:'g', scan:{chosen:{path:f.exe,launchProfile:{launcherPath:f.launcher}}} };
  assert.equal(resolveLaunchProfile('g','dx12',{game}).launchMode, 'official');
  const direct = resolveLaunchProfile('g','dx12',{game,preference:'exe'});
  assert.equal(direct.launchMode, 'exe'); assert.equal(direct.directOptIn, true); assert.equal(direct.launchRequest.exe, f.exe);
});

test('anti-cheat protection rejects direct EXE even when advanced preference requests it', t => {
  const f = fixture(t), game = { id:'g', antiCheatFiles:[path.join(f.gameRoot,'EasyAntiCheat_EOS.sys')],
    scan:{chosen:{path:f.exe,launchProfile:{launcherPath:f.launcher}}} };
  assert.throws(() => resolveLaunchProfile('g','dx12',{game,preference:'exe'}), error => error.code === 'LAUNCH_PROTECTION_OFFICIAL_REQUIRED');
});

test('known clients and Steam never silently fall back to the game EXE without verified official evidence', t => {
  const f = fixture(t);
  assert.throws(() => resolveLaunchProfile('wegame','dx12',{game:{id:'wegame',launcher:'WeGame',scan:{chosen:{path:f.exe}}}}),
    error => error.code === 'LAUNCH_OFFICIAL_ENTRY_REQUIRED');
  assert.throws(() => resolveLaunchProfile('steam','dx12',{game:{id:'steam',launcher:'Steam',scan:{chosen:{path:f.exe}}}}),
    error => error.code === 'LAUNCH_OFFICIAL_ENTRY_REQUIRED');
});

test('Neverness API preview applies one transactional INI change and launch performs no config write', async t => {
  const f = fixture(t), ini = path.join(f.gameRoot, 'Game.ini'); fs.writeFileSync(ini, '[Game]\r\nDx11=true\r\nAccountToken=secret\r\n');
  const launches = [], module = createLauncherCompatibility({ userData:path.join(f.root,'data'), assertGameClosed:async () => {},
    broker:{ launch:async request => { launches.push(request); return {pid:1}; } } });
  const profile = module.resolveLaunchProfile({ id:'nte', launcher:'Perfect World', scan:{chosen:{path:f.exe,
    launchProfile:{client:'Neverness',launcherPath:f.launcher,settingsFile:ini}}} }, 'dx12');
  const preview = await module.previewApiChange(profile, 'dx12');
  assert.equal(preview.changed, true); assert.equal(preview.changes.length, 1);
  await module.applyApiChange(preview.planId);
  const applied = fs.readFileSync(ini, 'utf8');
  assert.match(applied, /Dx11=false/); assert.match(applied, /AccountToken=secret/);
  const beforeLaunch = Buffer.from(fs.readFileSync(ini)); await module.launch(profile);
  assert.deepEqual(fs.readFileSync(ini), beforeLaunch); assert.equal(launches[0].exe, f.launcher);
});

test('YYSLS adapter updates setting and both API tags in one confirmed plan', async t => {
  const f = fixture(t), config = path.join(f.gameRoot,'setting.ini'), tags = path.join(f.gameRoot,'LocalData');
  const dx12Tag = path.join(tags,'launcher_dx12_control.tag'), graphicsTag = path.join(tags,'last_graphics_api.tag');
  fs.mkdirSync(tags); fs.writeFileSync(config,'[Graphics]\r\nDX12=false\r\n'); fs.writeFileSync(dx12Tag,'0'); fs.writeFileSync(graphicsTag,'dx11');
  const module = createLauncherCompatibility({ userData:path.join(f.root,'data'), assertGameClosed:async () => {}, broker:{launch:async()=>({pid:1})} });
  const profile = module.resolveLaunchProfile({ id:'yysls', launcher:'NetEase', scan:{chosen:{path:f.exe,
    launchProfile:{client:'yysls',launcherPath:f.launcher,settingsFile:config,dx12Tag,graphicsTag}}} }, 'dx12');
  const preview = await module.previewApiChange(profile, 'dx12'); assert.equal(preview.changes.length, 3);
  await module.applyApiChange(preview.planId);
  assert.match(fs.readFileSync(config,'utf8'), /DX12=true/);
  assert.equal(fs.readFileSync(dx12Tag,'utf8'),'1'); assert.equal(fs.readFileSync(graphicsTag,'utf8'),'dx12');
});

test('a launch failure is not persisted and the same profile can be retried', async t => {
  const f = fixture(t); let attempts = 0;
  const module = createLauncherCompatibility({ userData:path.join(f.root,'data'), assertGameClosed:async()=>{}, broker:{launch:async()=>{
    attempts += 1; if (attempts === 1) throw Object.assign(new Error('closed'),{code:'LAUNCH_FAILED'}); return {pid:2}; }} });
  const profile = module.resolveLaunchProfile({id:'g',scan:{chosen:{path:f.exe}}},'dx12');
  await assert.rejects(module.launch(profile), {code:'LAUNCH_FAILED'});
  assert.deepEqual(await module.launch(profile), {pid:2});
});
