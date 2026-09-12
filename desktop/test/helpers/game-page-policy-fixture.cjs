'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { compileNativeAddonPolicy, assertNativeAddonPolicy } = require('../../src/product/native-addon-policy');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Data-only x64 PE with NAME export; no fixture Add-on is executable or loaded.
function addonBytes(name) {
  const b = Buffer.alloc(0x800), p = 0x80, o = p + 24, section = o + 0xf0;
  b.write('MZ'); b.writeUInt32LE(p, 0x3c); b.write('PE\0\0', p); b.writeUInt16LE(0x8664, p + 4);
  b.writeUInt16LE(1, p + 6); b.writeUInt16LE(0xf0, p + 20); b.writeUInt16LE(0x20b, o);
  b.writeBigUInt64LE(0x180000000n, o + 24); b.writeUInt32LE(0x200, o + 60);
  b.writeUInt32LE(0x1000, o + 112); b.writeUInt32LE(0x90, o + 116); b.write('.data', section);
  b.writeUInt32LE(0x600, section + 8); b.writeUInt32LE(0x1000, section + 12);
  b.writeUInt32LE(0x600, section + 16); b.writeUInt32LE(0x200, section + 20);
  b.writeUInt32LE(1, 0x214); b.writeUInt32LE(1, 0x218); b.writeUInt32LE(0x1040, 0x21c);
  b.writeUInt32LE(0x1044, 0x220); b.writeUInt32LE(0x1048, 0x224);
  b.writeUInt32LE(0x1100, 0x240); b.writeUInt32LE(0x1050, 0x244); b.write('NAME\0', 0x250);
  b.writeBigUInt64LE(0x180001140n, 0x300); b.write(name + '\0', 0x340); return b;
}
function createPolicyFixture(root) {
  const gameDir = path.join(root, 'game'), exeDir = path.join(gameDir, 'bin'), exe = path.join(exeDir, 'bg3_dx11.exe');
  const payloadDir = path.join(root, 'payload'), ini = path.join(exeDir, 'ReShade.ini');
  fs.mkdirSync(exeDir, { recursive: true }); fs.mkdirSync(payloadDir);
  fs.writeFileSync(exe, addonBytes('Synthetic UI executable'));
  fs.writeFileSync(path.join(exeDir, 'dxgi.dll'), addonBytes('ReShade'));
  fs.writeFileSync(path.join(payloadDir, 'bundle.json'), JSON.stringify({ version: 1, files: {} }));
  const unknown = path.join(exeDir, 'personal-addon.addon64'), core = path.join(exeDir, 'renamed-old-core.addon64'), carrier = path.join(exeDir, 'renamed-old-carrier.addon64');
  const knownComponents = [{ path: core, sha256: digest(addonBytes('Old Core')), role: 'core' },
    { path: carrier, sha256: digest(addonBytes('Old Bridge')), role: 'carrier' }];
  const game = { id: 'fixture', dir: gameDir, scan: { chosen: { path: exe, bitness: 64, apiResolution: { api: 'dx11' } } } };
  const observations = new Map(); let sequence = 0;
  function reset() {
    fs.writeFileSync(ini, '[ADDON]\r\nAddonPath=.\r\n[STYLE]\r\nFont=Original\r\n');
    fs.writeFileSync(unknown, addonBytes('Personal Plugin'));
    fs.writeFileSync(core, addonBytes('Old Core')); fs.writeFileSync(carrier, addonBytes('Old Bridge'));
    observations.clear();
  }
  reset();
  return { paths: { gameDir, exe, ini, unknown, core, carrier }, reset,
    async preview(id, addonKeep = []) {
      if (id !== game.id) throw Error('Policy fixture is bound to the first game.');
      const result = await compileNativeAddonPolicy({ game, payloadDir, payload: {}, manifest: null, addonKeep, knownComponents });
      const token = 'native-policy-' + ++sequence; observations.set(token, result);
      return { token, plan: result.plan, changes: result.changes };
    },
    async assert(token) {
      if (!observations.has(token)) throw Error('Unknown native policy observation.');
      await assertNativeAddonPolicy(game.dir, observations.get(token));
      return { verified: true };
    },
    mutate(kind) {
      if (kind === 'config') fs.appendFileSync(ini, '\r\n[Personal]\r\nChanged=1\r\n');
      else if (kind === 'plugin') fs.appendFileSync(unknown, 'changed after preview');
      else throw Error('Unknown fixture mutation.');
    }
  };
}
module.exports = { createPolicyFixture };
