'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PAYLOAD_FILES, DX11_COMPAT_CARRIER } = require('./constants');
const { FAMILIES } = require('./gpu');
const { appError } = require('./errors');

const OPTIONAL_PAYLOAD_FILES = Object.freeze({
  carrier: DX11_COMPAT_CARRIER
});
const HASH = /^[a-f0-9]{64}$/i;
const VERSION_ID = /^[a-z0-9][a-z0-9._+-]{0,127}$/i;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function payloadDirectory(dir) {
  const resolved = path.resolve(dir);
  let stat;
  try { stat = fs.lstatSync(resolved); } catch { throw appError('ERR_PAYLOAD_MISSING', { file: resolved }); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw appError('ERR_PAYLOAD_HASH', { file: resolved, reason: 'unsafe-directory' });
  return fs.realpathSync(resolved);
}

function safePayloadPath(root, file) {
  const base = path.resolve(root), target = path.resolve(file), rel = path.relative(base, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw appError('ERR_PAYLOAD_HASH', { file: String(file), reason: 'path-escape' });
  let current = base;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw appError('ERR_PAYLOAD_HASH', { file: path.relative(base, current), reason: 'link' });
      const real = fs.realpathSync(current);
      if (pathKey(real) !== pathKey(base) && !pathKey(real).startsWith(`${pathKey(base)}${path.sep}`)) throw appError('ERR_PAYLOAD_HASH', { file: path.relative(base, current), reason: 'path-escape' });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}

function hashMap(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.entries(value).length <= 32 && Object.entries(value).every(([name, digest]) =>
      path.basename(name) === name && name !== '.' && name !== '..' && typeof digest === 'string' && HASH.test(digest));
}

function validateBundlePaths(bundle) {
  if (bundle.version === 1 && !hashMap(bundle.files)) throw appError('ERR_PAYLOAD_HASH', { file: 'bundle.json' });
  if (bundle.version === 2) {
    if (Object.keys(bundle.variants).length > 8 || FAMILIES.some(family => !hashMap(bundle.variants[family]?.files))) throw appError('ERR_PAYLOAD_HASH', { file: 'bundle.json' });
  }
  if (bundle.version === 3 || bundle.version === 4) {
    const ids = Object.keys(bundle.versions);
    if (!ids.length || ids.length > 64 || ids.some(id => !VERSION_ID.test(id)) || !VERSION_ID.test(bundle.defaultVersion || '') || !Object.hasOwn(bundle.versions, bundle.defaultVersion)) throw appError('ERR_PAYLOAD_HASH', { file: 'bundle.json' });
    for (const entry of Object.values(bundle.versions)) {
      if (!entry || typeof entry !== 'object' || (bundle.version === 3
        ? FAMILIES.some(family => !hashMap(entry.variants?.[family]?.files))
        : !hashMap(entry.files))) throw appError('ERR_PAYLOAD_HASH', { file: 'bundle.json' });
    }
    if (bundle.version === 4 && FAMILIES.some(family => !hashMap(bundle.fixed?.[family]?.files))) throw appError('ERR_PAYLOAD_HASH', { file: 'bundle.json' });
  }
  return bundle;
}

function sha256(file) {
  return require('./streaming-digest-sync').sha256(file);
}

function inspectionHasher() {
  const values = new Map();
  return file => {
    const resolved = path.resolve(file);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (!values.has(key)) values.set(key, sha256(resolved));
    return values.get(key);
  };
}

function payloadRoot(baseDir) {
  return path.join(baseDir, 'payload', 'nr-before-sr');
}

function readBundle(dir) {
  dir = payloadDirectory(dir);
  const file = safePayloadPath(dir, path.join(dir, 'bundle.json'));
  if (!fs.existsSync(file)) throw appError('ERR_PAYLOAD_MISSING', { file: 'bundle.json' });
  let bundle;
  try { if (fs.statSync(file).size > MAX_BUNDLE_BYTES) throw new Error('large'); bundle = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw appError('ERR_PAYLOAD_HASH', { file: 'bundle.json' }); }
  const legacy = bundle && bundle.version === 1 && bundle.files && typeof bundle.files === 'object';
  const variants = bundle && bundle.version === 2 && bundle.variants && typeof bundle.variants === 'object';
  const versions = bundle && (bundle.version === 3 || bundle.version === 4) && bundle.versions && typeof bundle.versions === 'object';
  if (!legacy && !variants && !versions) {
    throw appError('ERR_PAYLOAD_HASH', { file: 'bundle.json' });
  }
  return validateBundlePaths(bundle);
}

function inspectFiles(dir, expectedFiles, digest = sha256, safetyRoot = dir) {
  return inspectFilesAt(dir, expectedFiles, {}, digest, safetyRoot);
}

function inspectFilesAt(dir, expectedFiles, customPaths = {}, digest = sha256, safetyRoot = dir) {
  return Object.entries(PAYLOAD_FILES).map(([kind, name]) => {
    const file = safePayloadPath(safetyRoot, customPaths[kind] || path.join(dir, name));
    const exists = fs.existsSync(file) && fs.statSync(file).isFile();
    const actual = exists ? digest(file) : null;
    const expected = expectedFiles && expectedFiles[name] ? String(expectedFiles[name]).toLowerCase() : null;
    return { kind, name, file, exists, actual, expected, valid: exists && (!expected || actual === expected) };
  });
}

function inspectOptionalFile(file, expected, kind, name, digest = sha256, safetyRoot = path.dirname(file)) {
  file = safePayloadPath(safetyRoot, file);
  const exists = fs.existsSync(file) && fs.statSync(file).isFile();
  const actual = exists ? digest(file) : null;
  const normalizedExpected = expected ? String(expected).toLowerCase() : null;
  return {
    kind, name, file, exists, actual, expected: normalizedExpected,
    valid: exists && Boolean(normalizedExpected) && actual === normalizedExpected
  };
}

function inspectOne(dir, expectedFiles, digest = sha256, safetyRoot = dir) {
  const files = inspectFiles(dir, expectedFiles, digest, safetyRoot);
  return {
    dir, files,
    ready: files.every(row => row.valid && row.expected),
    missing: files.filter(row => !row.exists).map(row => row.name),
    invalid: files.filter(row => row.exists && (!row.expected || row.actual !== row.expected)).map(row => row.name)
  };
}

function inspectVersion(dir, entry, digest = sha256, safetyRoot = dir) {
  const variants = {};
  for (const family of FAMILIES) {
    const variant = entry && entry.variants && entry.variants[family];
    variants[family] = inspectOne(path.join(dir, family), variant && variant.files, digest, safetyRoot);
  }
  return {
    id: entry && entry.id,
    label: entry && entry.label,
    notes: entry && entry.notes,
    source: entry && entry.source,
    compatibility: entry && entry.compatibility,
    coreUpdateOnly: entry?.coreUpdateOnly === true,
    comparisonOnly: entry?.comparisonOnly === true,
    trustedUpgradeFrom: Array.isArray(entry?.trustedUpgradeFrom) ? entry.trustedUpgradeFrom.filter(value => /^[a-f0-9]{64}$/i.test(value)).slice(0, 16) : [],
    ota: Boolean(entry && entry.ota),
    variants,
    ready: FAMILIES.every(family => variants[family].ready)
  };
}

function inspectCompactVersion(root, id, entry, fixed, digest = sha256, families = FAMILIES) {
  const variants = {};
  for (const family of families) {
    const fixedEntry = fixed && fixed[family];
    const versionDir = path.join(root, 'versions', id);
    const fixedDir = path.join(root, 'fixed', family);
    const fixedExpected = fixedEntry && fixedEntry.files ? fixedEntry.files : {};
    const versionExpected = entry && entry.files ? entry.files : {};
    const expected = { ...fixedExpected, ...versionExpected };
    const files = inspectFilesAt('', expected, {
      reshade: path.join(fixedDir, PAYLOAD_FILES.reshade),
      bridge: entry && entry.files && entry.files[PAYLOAD_FILES.bridge]
        ? path.join(versionDir, PAYLOAD_FILES.bridge)
        : path.join(fixedDir, PAYLOAD_FILES.bridge),
      runtime: fixedEntry?.paths?.runtime ? path.join(root, fixedEntry.paths.runtime) : path.join(fixedDir, PAYLOAD_FILES.runtime),
      addon: path.join(versionDir, PAYLOAD_FILES.addon),
      config: path.join(versionDir, PAYLOAD_FILES.config)
    }, digest, root);
    variants[family] = {
      dir: versionDir,
      files,
      ready: files.every(row => row.valid && row.expected),
      missing: files.filter(row => !row.exists).map(row => row.name),
      invalid: files.filter(row => row.exists && (!row.expected || row.actual !== row.expected)).map(row => row.name)
    };
    if (entry && entry.files && entry.files[OPTIONAL_PAYLOAD_FILES.carrier]) {
      const optional = inspectOptionalFile(
        path.join(versionDir, OPTIONAL_PAYLOAD_FILES.carrier),
        entry.files[OPTIONAL_PAYLOAD_FILES.carrier],
        'carrier', OPTIONAL_PAYLOAD_FILES.carrier, digest, root
      );
      variants[family].files.push(optional);
      variants[family].ready = variants[family].files.every(row => row.valid && row.expected);
      variants[family].missing = variants[family].files.filter(row => !row.exists).map(row => row.name);
      variants[family].invalid = variants[family].files.filter(row => row.exists && !row.valid).map(row => row.name);
    }
  }
  return {
    id,
    supportsPresent: entry?.supportsPresent === true,
    capabilities: Array.isArray(entry?.capabilities) ? entry.capabilities.filter(value => typeof value === 'string') : [],
    inputInterfaces: Array.isArray(entry?.inputInterfaces) ? entry.inputInterfaces.filter(value => typeof value === 'string') : [],
    label: entry && entry.label,
    notes: entry && entry.notes,
    source: entry && entry.source,
    compatibility: entry && entry.compatibility,
    coreUpdateOnly: entry?.coreUpdateOnly === true,
    comparisonOnly: entry?.comparisonOnly === true,
    trustedUpgradeFrom: Array.isArray(entry?.trustedUpgradeFrom) ? entry.trustedUpgradeFrom.filter(value => /^[a-f0-9]{64}$/i.test(value)).slice(0, 16) : [],
    ota: Boolean(entry && entry.ota),
    variants,
    ready: families.every(family => variants[family].ready)
  };
}

function inspectPayload(dir, options = {}) {
  // A compact bundle deliberately shares fixed files between versions. Hash
  // each physical path once per inspection while keeping every invocation
  // fresh for requirePayload and mutation-time validation.
  dir = payloadDirectory(dir);
  const digest = inspectionHasher();
  let bundle = null;
  try { bundle = readBundle(dir); }
  catch (error) {
    if (!options.allowMissingBundle) throw error;
  }

  if (bundle && bundle.version === 2) {
    const variants = {};
    for (const family of FAMILIES) {
      const entry = bundle.variants[family];
      variants[family] = inspectOne(path.join(dir, family), entry && entry.files, digest, dir);
    }
    const selectedFamily = options.hardwareFamily;
    const selected = FAMILIES.includes(selectedFamily) ? variants[selectedFamily] : null;
    return {
      dir, bundle, variants, hardwareFamily: selectedFamily || null,
      files: selected ? selected.files : [],
      ready: selected ? selected.ready : FAMILIES.every(family => variants[family].ready),
      missing: [...new Set(FAMILIES.flatMap(family => variants[family].missing.map(name => `${family}/${name}`)))],
      invalid: [...new Set(FAMILIES.flatMap(family => variants[family].invalid.map(name => `${family}/${name}`)))]
    };
  }

  if (bundle && bundle.version === 3) {
    const versions = {};
    for (const [id, entry] of Object.entries(bundle.versions || {})) {
      versions[id] = inspectVersion(path.join(dir, 'versions', id), { ...entry, id }, digest, dir);
    }
    const ids = Object.keys(versions);
    const selectedVersion = ids.includes(options.version)
      ? options.version
      : (ids.includes(bundle.defaultVersion) ? bundle.defaultVersion : ids[0]);
    const selected = selectedVersion ? versions[selectedVersion] : null;
    const family = options.hardwareFamily;
    const selectedVariant = selected && FAMILIES.includes(family) ? selected.variants[family] : null;
    const files = selectedVariant ? selectedVariant.files : [];
    return {
      dir, bundle, versions, selectedVersion: selectedVersion || null,
      hardwareFamily: family || null, files,
      ready: Boolean(selectedVariant ? selectedVariant.ready : selected && selected.ready),
      missing: files.filter(row => !row.exists || !row.expected).map(row => row.name),
      invalid: files.filter(row => row.exists && !row.valid).map(row => row.name)
    };
  }

  if (bundle && bundle.version === 4) {
    const versions = {};
    const wanted = options.version || bundle.defaultVersion;
    if (options.selectedOnly && !bundle.versions[wanted]) throw appError('ERR_PAYLOAD_MISSING', { file: `versions/${wanted}` });
    for (const [id, entry] of Object.entries(bundle.versions || {})) {
      if (options.selectedOnly && id !== wanted) continue;
      const families = options.selectedOnly && FAMILIES.includes(options.hardwareFamily) ? [options.hardwareFamily] : FAMILIES;
      versions[id] = inspectCompactVersion(dir, id, { ...entry, id }, bundle.fixed || {}, digest, families);
    }
    const ids = Object.keys(versions);
    const selectedVersion = ids.includes(options.version)
      ? options.version
      : (ids.includes(bundle.defaultVersion) ? bundle.defaultVersion : ids[0]);
    const selected = selectedVersion ? versions[selectedVersion] : null;
    const family = options.hardwareFamily;
    const selectedVariant = selected && FAMILIES.includes(family) ? selected.variants[family] : null;
    const files = selectedVariant ? selectedVariant.files : [];
    return {
      dir, bundle, versions, selectedVersion: selectedVersion || null,
      hardwareFamily: family || null, files,
      ready: Boolean(selectedVariant ? selectedVariant.ready : selected && selected.ready),
      missing: files.filter(row => !row.exists || !row.expected).map(row => row.name),
      invalid: files.filter(row => row.exists && !row.valid).map(row => row.name)
    };
  }

  const legacy = inspectOne(dir, bundle && bundle.files, digest, dir);
  return { dir, bundle, files: legacy.files, ready: Boolean(bundle) && legacy.ready, missing: legacy.missing, invalid: legacy.invalid };
}

function requirePayload(dir, hardwareFamily, version) {
  const result = inspectPayload(dir, { hardwareFamily, version, selectedOnly: true });
  if ((result.variants || result.versions) && !FAMILIES.includes(hardwareFamily)) throw appError('ERR_GPU_UNSUPPORTED');
  if (result.versions && !result.selectedVersion) throw appError('ERR_PAYLOAD_MISSING', { file: 'bundle.versions' });
  if (result.missing.length) throw appError('ERR_PAYLOAD_MISSING', { files: result.missing });
  if (!result.ready) throw appError('ERR_PAYLOAD_HASH', { files: result.invalid });
  const payload = Object.fromEntries(result.files.map(row => [row.kind, row]));
  payload.hardwareFamily = hardwareFamily || null;
  payload.version = result.selectedVersion || null;
  payload.versionInfo = result.versions && result.versions[result.selectedVersion]
      ? { id: result.selectedVersion, label: result.versions[result.selectedVersion].label, notes: result.versions[result.selectedVersion].notes,
        supportsPresent: result.versions[result.selectedVersion].supportsPresent === true,
        inputInterfaces: result.versions[result.selectedVersion].inputInterfaces || [],
        compatibility: result.versions[result.selectedVersion].compatibility || null,
        coreUpdateOnly: result.versions[result.selectedVersion].coreUpdateOnly === true,
        trustedUpgradeFrom: result.versions[result.selectedVersion].trustedUpgradeFrom || [],
        ota: Boolean(result.versions[result.selectedVersion].ota) }
    : null;
  return payload;
}

function createBundle(dir) {
  const files = {};
  for (const name of Object.values(PAYLOAD_FILES)) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) throw appError('ERR_PAYLOAD_MISSING', { file: name });
    files[name] = sha256(file);
  }
  return { version: 1, generatedAt: new Date().toISOString(), files };
}

function createVariantsBundle(dir) {
  const variants = Object.fromEntries(FAMILIES.map(family => [family, { files: createBundle(path.join(dir, family)).files }]));
  return { version: 2, generatedAt: new Date().toISOString(), variants };
}

function createVersionedBundle(dir, entries, defaultVersion) {
  const versions = {};
  for (const entry of entries) {
    const id = String(entry.id);
    const base = path.join(dir, 'versions', id);
    versions[id] = {
      label: entry.label || id,
      notes: entry.notes || '',
      source: entry.source || '',
      variants: Object.fromEntries(FAMILIES.map(family => [family, {
        files: createBundle(path.join(base, family)).files
      }]))
    };
  }
  return { version: 3, generatedAt: new Date().toISOString(), defaultVersion, versions };
}

function createCompactBundle(dir, entries, defaultVersion) {
  const fixed = Object.fromEntries(FAMILIES.map(family => [family, {
    files: Object.fromEntries(['reshade', 'bridge', 'runtime'].map(kind => {
      const name = PAYLOAD_FILES[kind];
      const file = path.join(dir, 'fixed', family, name);
      if (!fs.existsSync(file)) throw appError('ERR_PAYLOAD_MISSING', { file: `fixed/${family}/${name}` });
      return [name, sha256(file)];
    }))
  }]));
  const versions = Object.fromEntries(entries.map(entry => {
    const id = String(entry.id);
    const base = path.join(dir, 'versions', id);
    const files = {};
    for (const kind of ['addon', 'config']) {
      const name = PAYLOAD_FILES[kind];
      const file = path.join(base, name);
      if (!fs.existsSync(file)) throw appError('ERR_PAYLOAD_MISSING', { file: `versions/${id}/${name}` });
      files[name] = sha256(file);
    }
    const bridge = path.join(base, PAYLOAD_FILES.bridge);
    if (fs.existsSync(bridge)) files[PAYLOAD_FILES.bridge] = sha256(bridge);
    const carrier = path.join(base, OPTIONAL_PAYLOAD_FILES.carrier);
    if (fs.existsSync(carrier)) files[OPTIONAL_PAYLOAD_FILES.carrier] = sha256(carrier);
    return [id, { label: entry.label || id, notes: entry.notes || '', source: entry.source || '', compatibility: entry.compatibility || null, ota: Boolean(entry.ota),
      ...(entry.coreUpdateOnly === true ? { coreUpdateOnly: true } : {}),
      ...(entry.comparisonOnly === true ? { comparisonOnly: true } : {}), files }];
  }));
  return { version: 4, generatedAt: new Date().toISOString(), defaultVersion, fixed, versions };
}

module.exports = {
  sha256, payloadRoot, readBundle, safePayloadPath, inspectPayload, requirePayload,
  createBundle, createVariantsBundle, createVersionedBundle, createCompactBundle, OPTIONAL_PAYLOAD_FILES
};
