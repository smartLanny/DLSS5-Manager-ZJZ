'use strict';
const path = require('node:path');
const { createFeederRuntime } = require('../src/product/feeder-runtime');
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
const runtime = createFeederRuntime({ appDir: root, resourcesPath: path.join(root, 'resources') });
runtime.verify().then(({ recipe, fingerprint }) => console.log(JSON.stringify({ id: recipe.id, fingerprint,
  files: recipe.files.length, api: recipe.api, architecture: recipe.architecture, provenance: recipe.provenance,
  acceptance: recipe.acceptance, runtimeVerified: false }, null, 2))).catch(error => { console.error(`${error.code || 'error'}: ${error.message}`); process.exitCode = 1; });
