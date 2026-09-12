'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { safeArchivePath, parseArchiveListing, compareInventory, validateOutputPath } = require('../scripts/verify-embedded-payloads');
const entry = (file, size = 3) => `Path = ${file}\r\nSize = ${size}\r\nAttributes = A\r\nEncrypted = -\r\n`;
const listing = body => `7-Zip\r\nPath = fixture.exe\r\nType = 7z\r\nOffset = 64\r\nPhysical Size = 128\r\nTail Size = 64\r\n\r\n----------\r\n${body}\r\n\r\nWarnings: 1\r\n`;

test('embedded listing preserves Chinese paths and the expected outer-executable tail', () => {
  const parsed = parseArchiveListing(listing(entry('resources\\中文组件.dll')), 256);
  assert.equal(parsed.offset, 64); assert.equal(parsed.bytes, 128); assert.equal(parsed.tailBytes, 64);
  assert.deepEqual(parsed.entries, [{ file: 'resources/中文组件.dll', bytes: 3, directory: false }]);
  assert.doesNotThrow(() => compareInventory(parsed.entries, [{ file: 'resources/中文组件.dll', bytes: 3 }]));
});
test('unsafe Windows paths, duplicate names and invalid embedded ranges fail before extraction', () => {
  for (const file of ['../outside', 'resources/../../outside', 'C:/outside', '\\\\server\\file', 'file:stream', 'a//b', 'aux.txt', 'component.']) assert.throws(() => safeArchivePath(file), /Unsafe/);
  assert.throws(() => parseArchiveListing(listing(entry('A.dll') + '\r\n' + entry('a.dll')), 256), /Duplicate/);
  assert.throws(() => parseArchiveListing(listing(entry('a.dll')), 255), /boundaries/);
  assert.throws(() => parseArchiveListing(listing(entry('a.dll')).replace('Encrypted = -', 'Encrypted = +'), 256), /Unsupported/);
});
test('all required payload files and sizes must match, including extra resources', () => {
  const reference = [{ file: 'resources/app.asar', bytes: 4 }, { file: 'resources/runtime.dll', bytes: 5 }];
  assert.throws(() => compareInventory([{ file: 'resources/app.asar', bytes: 4, directory: false }], reference), /inventory/);
  assert.throws(() => compareInventory(reference.map(row => ({ ...row, bytes: row.bytes + 1 })), reference), /inventory/);
  assert.throws(() => compareInventory([...reference, { file: 'unexpected.dll', bytes: 1 }], reference), /inventory/);
});
test('report creation cannot overwrite a release input or modify win-unpacked', () => {
  assert.throws(() => validateOutputPath('candidate/win-unpacked', 'candidate/win-unpacked/report.json'), /outside/);
  assert.throws(() => validateOutputPath('candidate/win-unpacked', 'candidate/Setup.exe', ['candidate/Setup.exe']), /overwriting/);
  assert.doesNotThrow(() => validateOutputPath('candidate/win-unpacked', 'candidate/verification/report.json', ['candidate/Setup.exe']));
});
