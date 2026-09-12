#!/usr/bin/env node

// Write a path-stable inventory for local Manager deliveries. The index is
// generated beside the ignored artifacts and contains hashes only; it never
// records workstation-specific source paths.
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deliveriesRoot = join(repoRoot, 'deliveries');
const desktopPackage = JSON.parse(await readFile(join(repoRoot, 'desktop', 'package.json'), 'utf8'));
const version = desktopPackage.version;
const defaultOutput = join(deliveriesRoot, `DLSS5-Manager-${version}-delivery-index.json`);

const artifactSpecs = [
  ['manager-base-installer', 'installer', 'base', `DLSS5-Manager-${version}-base/DLSS5-Manager-${version}-base-Setup.exe`],
  ['manager-base-portable', 'portable', 'base', `DLSS5-Manager-${version}-base/DLSS5-Manager-${version}-base-portable.exe`],
  ['manager-offline-installer', 'installer', 'offline', `DLSS5-Manager-${version}-offline/DLSS5-Manager-${version}-offline-Setup.exe`],
  ['manager-offline-portable', 'portable', 'offline', `DLSS5-Manager-${version}-offline/DLSS5-Manager-${version}-offline-portable.exe`],
  ['nr-runtime-offline-combined', 'runtime-dlc', 'offline', `DLSS5-Manager-${version}-offline/DLSS5-Manager-${version}-nr-runtime-offline.zip`],
  ['nr-runtime-rtx20-40', 'runtime-dlc', 'manual-import', `DLSS5-Manager-${version}-offline/DLSS5-Manager-${version}-nr-runtime-RTX20-40.zip`],
  ['nr-runtime-rtx50', 'runtime-dlc', 'manual-import', `DLSS5-Manager-${version}-offline/DLSS5-Manager-${version}-nr-runtime-RTX50.zip`],
  ['bridge-1.4.13-pre7-component', 'component', 'manual-import', `DLSS5-Manager-${version}-offline/DLSS5-Manager-${version}-bridge-1.4.13-pre7-component.zip`]
];

async function digest(relativePath) {
  const file = join(deliveriesRoot, relativePath);
  const bytes = (await stat(file)).size;
  const hash = createHash('sha256');
  hash.update(await readFile(file));
  return { path: relativePath.replaceAll('\\', '/'), bytes, sha256: hash.digest('hex') };
}

function compactStage(report) {
  const stage = report.stage || report;
  return {
    coreVersion: stage.coreVersion || null,
    sourcePackage: stage.sourcePackage
      ? { bytes: stage.sourcePackage.bytes, sha256: stage.sourcePackage.sha256 }
      : null,
    mfg: stage.mfg
      ? { bytes: stage.mfg.bytes, sha256: stage.mfg.sha256 }
      : null,
    bridge: stage.bridge
      ? {
          status: stage.bridge.status,
          id: stage.bridge.id,
          version: stage.bridge.version,
          compatible: stage.bridge.compatible === true,
          candidateSha256: stage.bridge.candidateSha256 || null
        }
      : null,
    componentCount: stage.components?.count ?? null,
    resourceCount: stage.resources?.count ?? null
  };
}

const artifacts = [];
for (const [id, kind, flavor, relativePath] of artifactSpecs) {
  artifacts.push({ id, kind, flavor, ...(await digest(relativePath)) });
}

const reports = {};
for (const flavor of ['base', 'offline']) {
  const reportFiles = [
    join(repoRoot, 'desktop', '.packaging-stage', flavor, 'staging-report.json'),
    join(deliveriesRoot, `DLSS5-Manager-${version}-${flavor}`, 'packaging-report.json')
  ];
  try {
    let report;
    for (const reportFile of reportFiles) {
      try { report = JSON.parse(await readFile(reportFile, 'utf8')); break; } catch { /* try the next known location */ }
    }
    reports[flavor] = compactStage(report || {});
  } catch {
    reports[flavor] = null;
  }
}

const status = process.env.DLSS5_DELIVERY_STATUS || 'prepared-pre-freeze';
const output = process.argv[2] ? resolve(process.argv[2]) : defaultOutput;
const index = {
  schemaVersion: 1,
  packageVersion: version,
  status,
  note: status === 'final'
    ? 'Hashes cover the listed Manager installers, portable executables and runtime DLC archives.'
    : 'Existing artifacts are indexed for handoff; regenerate with DLSS5_DELIVERY_STATUS=final after the frozen Core/Bridge/Vulkan package is rebuilt.',
  artifacts,
  stage: reports
};
await writeFile(output, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output: relative(repoRoot, output).replaceAll('\\', '/'), status, artifacts: artifacts.length }, null, 2));
