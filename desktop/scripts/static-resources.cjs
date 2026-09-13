'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STATIC_RESOURCE_FILES = Object.freeze([
  Object.freeze(['src/product/nvapi-drs.ps1', 'nvapi-drs.ps1']),
  Object.freeze(['src/product/nvapi-profile.ps1', 'nvapi-profile.ps1']),
  Object.freeze(['src/product/windows-registry-values.ps1', 'windows-registry-values.ps1']),
  Object.freeze(['src/product/launcher-locations.ps1', 'launcher-locations.ps1']),
  Object.freeze(['src/product/game-launch-broker.ps1', 'game-launch-broker.ps1'])
]);

// Legacy v1 recovery only needs the receipt schema, expected file names and
// notices. Keep this an exact file allow-list so old FG/UAL binaries can never
// be pulled into a Manager package through the recovery metadata path.
const LEGACY_FG_RESOURCE_FILES = Object.freeze([
  Object.freeze(['resources/fg-components/manifest.json', 'fg-components/manifest.json']),
  Object.freeze(['resources/fg-components/LICENSE', 'fg-components/LICENSE']),
  Object.freeze(['resources/fg-components/MINHOOK-LICENSE.txt', 'fg-components/MINHOOK-LICENSE.txt']),
  Object.freeze(['resources/fg-components/UAL-LICENSE', 'fg-components/UAL-LICENSE']),
  Object.freeze(['resources/fg-components/global.ini', 'fg-components/global.ini'])
]);

const ALL_STATIC_RESOURCE_FILES = Object.freeze([
  ...STATIC_RESOURCE_FILES,
  ...LEGACY_FG_RESOURCE_FILES
]);

function rootPath(root) {
  if (typeof root !== 'string' || !root.trim()) throw new TypeError('A resource source root is required.');
  return path.resolve(root);
}

function sourceFile(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) {
    throw new Error(`Static resource source must be a relative path: ${relative}`);
  }
  const absolute = path.resolve(root, relative);
  const inside = path.relative(root, absolute);
  if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    throw new Error(`Static resource source escapes its root: ${relative}`);
  }
  let stat;
  try { stat = fs.lstatSync(absolute); } catch { throw new Error(`Static resource source is missing: ${relative}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Static resource source must be a regular file: ${relative}`);
  return absolute;
}

function resourceCopies({ root = null, rows = ALL_STATIC_RESOURCE_FILES } = {}) {
  const absoluteRoot = root === null ? null : rootPath(root);
  if (!Array.isArray(rows)) throw new TypeError('Static resource rows must be an array.');
  return rows.map(row => {
    if (!Array.isArray(row) || row.length !== 2) throw new TypeError('Static resource rows must be [from, to] pairs.');
    const [from, to] = row;
    if (typeof to !== 'string' || !to || path.isAbsolute(to) || to.split(/[\\/]/).some(part => part === '..')) {
      throw new Error(`Static resource target is unsafe: ${to}`);
    }
    return { from: absoluteRoot ? sourceFile(absoluteRoot, from) : from, to };
  });
}

function assertStaticResourceSources(root, rows = ALL_STATIC_RESOURCE_FILES) {
  resourceCopies({ root, rows });
  return true;
}

module.exports = {
  STATIC_RESOURCE_FILES,
  LEGACY_FG_RESOURCE_FILES,
  ALL_STATIC_RESOURCE_FILES,
  resourceCopies,
  assertStaticResourceSources
};
