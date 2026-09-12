'use strict';
// Load the complete production owner with explicit substitutes only for the
// unrelated package/config modules. File IO, digest code and path guards are real.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
function loadOwner(file, substitutes = {}) {
  const full = path.resolve(file), nativeRequire = createRequire(full), module = { exports: {} };
  const context = { module, exports: module.exports, Buffer, TextDecoder, process, console, structuredClone, setTimeout, clearTimeout,
    __filename: full, __dirname: path.dirname(full),
    require: name => Object.hasOwn(substitutes, name) ? substitutes[name] : nativeRequire(name) };
  vm.runInNewContext(fs.readFileSync(full, 'utf8'), context, { filename: full });
  return module.exports;
}
module.exports = { loadOwner };
