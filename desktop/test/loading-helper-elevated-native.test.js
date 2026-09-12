'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

// An already elevated caller must opt in. This test never requests UAC or
// changes a token, ACL, privilege, real game, or global setting.
const root = path.resolve(__dirname, '..'), binaries = path.join(root, 'build/load-helper');
const enabled = process.platform === 'win32' && process.env.DLSS5_VERIFY_ELEVATED_HELPER === '1';
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inputs = ['src/native/load-helper.cpp', 'test/loading-helper-elevated-native.test.js',
  'build/load-helper/dlss5-load-helper.exe', 'resources/loading-helper/dlss5-load-helper.exe',
  'build/load-helper/fixture-target.exe', 'build/load-helper/fixture-module.dll'];

test('explicit administrator native helper loads only its same-user HIGH fixture; ordinary mode still refuses the administrator caller',
  { skip: !enabled, timeout: 20000 }, async t => {
    const identities = Object.fromEntries(inputs.map(file => [file, hash(path.join(root, file))]));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'resources/loading-helper/component.json'), 'utf8'));
    assert.equal(manifest.sha256, identities['build/load-helper/dlss5-load-helper.exe']);
    assert.equal(manifest.sha256, identities['resources/loading-helper/dlss5-load-helper.exe']);
    assert.equal(manifest.sourceSha256, identities['src/native/load-helper.cpp']);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'load-helper-admin-fixture-'));
    const target = path.join(directory, 'fixture-target.exe'), loader = path.join(directory, 'fixture-module.dll'), config = path.join(directory, 'ReShade.ini');
    fs.copyFileSync(path.join(binaries, 'fixture-target.exe'), target); fs.copyFileSync(path.join(binaries, 'fixture-module.dll'), loader);
    const original = '[ADDON]\r\nAddonPath=.\r\n'; fs.writeFileSync(config, original);
    const children = [];
    t.after(async () => {
      for (const child of children) if (child.exitCode === null) await new Promise(resolve => child.once('close', resolve));
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true });
    });
    const run = elevatedTarget => {
      const sessionId = crypto.randomUUID(), events = [], waits = [], args = ['--session', sessionId, '--target', target, '--target-sha', hash(target),
        '--loader', loader, '--loader-sha', hash(loader), '--config', config, '--config-sha', hash(config), '--timeout', '3000'];
      if (elevatedTarget) args.push('--elevated-target', '1');
      const child = spawn(path.join(binaries, 'dlss5-load-helper.exe'), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
      let pending = ''; const decoder = new StringDecoder('utf8');
      child.stdout.on('data', bytes => {
        pending += decoder.write(bytes); const lines = pending.split(/\r?\n/); pending = lines.pop();
        for (const line of lines) { const event = JSON.parse(line), waiter = waits.shift(); if (waiter) waiter(event); else events.push(event); }
      });
      const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      const next = async () => {
        const event = events.length ? events.shift() : await Promise.race([
          new Promise(resolve => waits.push(resolve)), closed.then(code => { throw new Error('Helper exited before expected event: ' + code); })]);
        assert.equal(event.sessionId, sessionId); assert.equal(event.targetExe, target); assert.equal(event.configHash, hash(config));
        assert.equal(event.helperPid, child.pid); assert.equal(event.elevatedTarget, elevatedTarget); return event;
      };
      return { child, next, closed };
    };
    const ordinary = run(false), refused = await ordinary.next();
    assert.equal(refused.event, 'failed'); assert.equal(refused.error, 87); assert.equal(await ordinary.closed, 2);
    const elevated = run(true), ready = await elevated.next();
    assert.equal(ready.event, 'ready'); assert.equal(ready.gamePid, 0);
    const game = spawn(target, ['4500'], { windowsHide: true, stdio: 'ignore' }); children.push(game);
    const gameClosed = new Promise((resolve, reject) => { game.once('error', reject); game.once('close', resolve); });
    const attached = await elevated.next(); assert.equal(attached.event, 'attached'); assert.equal(attached.gamePid, game.pid);
    assert.equal(await elevated.closed, 0); assert.equal(game.exitCode, null);
    assert.equal(await gameClosed, 0); assert.equal(fs.readFileSync(config, 'utf8'), original);
    for (const [file, expected] of Object.entries(identities)) assert.equal(hash(path.join(root, file)), expected, file);
    const report = { version: 1, checkedAt: new Date().toISOString(), scope: 'explicit-same-user-high-integrity-fixtures-only',
      passed: true, realGame: false, ordinaryModeRejected: true, elevatedTargetAttached: true, identities };
    fs.writeFileSync(path.join(binaries, 'elevated-native-fixture-verification.json'), JSON.stringify(report, null, 2) + '\n');
  });
