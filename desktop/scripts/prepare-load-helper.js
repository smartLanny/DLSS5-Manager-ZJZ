'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getBitness } = require('../src/core/pe');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'build/load-helper/dlss5-load-helper.exe');
if (!['x64', 64].includes(getBitness(source))) throw new Error('Loading helper must be x64.');
const directory = path.join(root, 'resources/loading-helper'); fs.mkdirSync(directory, { recursive: true });
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sha256 = digest(source), target = path.join(directory, 'dlss5-load-helper.exe');
fs.copyFileSync(source, target); if (digest(target) !== sha256) throw new Error('Helper copy verification failed.');
fs.writeFileSync(path.join(directory, 'component.json'), JSON.stringify({ version: 1, id: 'dlss5-loading-helper', file: path.basename(target),
  sha256, architecture: 'x64', sourceSha256: digest(path.join(root, 'src/native/load-helper.cpp')), protocol: 1,
  policy: { privilege: 'ordinary-default/explicit-same-user-admin', elevatedRoute: 'hoyoshade-only', cleanupGameFiles: false, terminateGame: false, protectionBypass: false },
  verification: { compiled: true, nativeFixture: false, elevatedNativeFixture: false, realGame: false } }, null, 2) + '\n');
console.log(`Prepared loading helper ${sha256}`);
