'use strict';

const packageJson = require('../package.json');

// Keep the ordinary package configuration authoritative. This variant only
// omits both native and Vulkan NR payloads and writes to a separate output directory.
const config = structuredClone(packageJson.build);
config.directories = { ...(config.directories || {}), output: 'dist-external' };
config.extraResources = (config.extraResources || []).filter(row => row && !['payload', 'resources/vulkan-runtime', 'resources/feeder-runtime'].includes(row.from));
config.portable = { ...(config.portable || {}), requestExecutionLevel: 'user', artifactName: 'DLSS5-Manager-${version}-external-portable.exe' };
config.nsis = { ...(config.nsis || {}), artifactName: 'DLSS5-Manager-Setup-${version}-external.exe' };
config.win = { ...(config.win || {}), requestedExecutionLevel: 'asInvoker' };

module.exports = config;
