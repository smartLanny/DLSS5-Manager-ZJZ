'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Only caller-supplied build data is accepted. Never load a candidate's JS
// configuration or discover a supposedly trusted configuration inside its files.
function verificationConfig(sourceRoot, pkg, { buildConfig, buildConfigFile, directory } = {}) {
  if (buildConfig && buildConfigFile) throw new Error('Provide one trusted build configuration.');
  if (buildConfigFile) {
    const file = path.resolve(buildConfigFile), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid trusted build configuration file.');
    if (directory) {
      const relative = path.relative(path.resolve(directory), file);
      if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
        throw new Error('Trusted build configuration must be outside the candidate directory.');
    }
    buildConfig = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  }
  const explicit = Boolean(buildConfig);
  if (!explicit && pkg.scripts?.['build:base'] && !(pkg.build?.extraResources?.length))
    throw new Error('Dynamic Manager resources require --build-config <trusted build-config.json>.');
  const config = buildConfig || pkg.build;
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid trusted build configuration.');
  for (const key of ['files', 'extraResources', 'extraFiles'])
    if (config[key] !== undefined && !Array.isArray(config[key])) throw new Error(`Invalid build ${key}.`);
  if (pkg.scripts?.['build:base'] && !config.extraResources?.length)
    throw new Error('Dynamic Manager build configuration must include resolved resources.');
  if (config.productName && pkg.build?.productName && config.productName !== pkg.build.productName)
    throw new Error('Build configuration product identity does not match source.');
  return { config, explicit, file: buildConfigFile ? path.resolve(buildConfigFile) : null };
}
module.exports = { verificationConfig };
