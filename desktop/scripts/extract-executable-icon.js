'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { extractExecutableIcon } = require('../src/product/executable-icon');

if (process.argv.length !== 4) throw new Error('Usage: node scripts/extract-executable-icon.js <EXE or DLL> <output.ico>');
const input = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const data = extractExecutableIcon(input);
if (!data) throw new Error('No bounded PE icon resource was found.');
const match = data.match(/^data:image\/x-icon;base64,(.+)$/);
if (!match) throw new Error('Icon extractor returned an unsupported data URL.');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, Buffer.from(match[1], 'base64'));
console.log(JSON.stringify({ input, output, bytes: fs.statSync(output).size }));
