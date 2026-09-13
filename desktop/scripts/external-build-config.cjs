'use strict';

const path = require('node:path');
const packageJson = require('../package.json');
const { resourceCopies } = require('./static-resources.cjs');
const APP_ROOT = path.resolve(__dirname, '..');

// Keep the ordinary package configuration authoritative. This variant only
// omits both native and Vulkan NR payloads and writes to a separate output directory.
const config = structuredClone(packageJson.build);
config.directories = { ...(config.directories || {}), output: 'dist-external' };
config.extraResources = resourceCopies({ root: APP_ROOT });
config.portable = { ...(config.portable || {}), requestExecutionLevel: 'user', artifactName: 'DLSS5-Manager-${version}-external-portable.exe' };
config.nsis = { ...(config.nsis || {}), artifactName: 'DLSS5-Manager-Setup-${version}-external.exe' };
config.win = { ...(config.win || {}), requestedExecutionLevel: 'asInvoker' };

module.exports = config;
