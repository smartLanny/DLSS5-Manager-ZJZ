'use strict';
// Keep the v1/UAL implementation for old receipt recovery. New selection never
// falls back to installing it when MFG Unlock resources are unavailable.
const legacy = require('./fg-legacy-components');
const { createMfgUnlockComponents } = require('./fg-mfgunlock-components');
module.exports = {
  createFgComponents: createMfgUnlockComponents,
  mergeUalConfig: legacy.mergeUalConfig,
  validControl: legacy.validControl,
  DEFAULT_CONTROL: legacy.DEFAULT_CONTROL
};
