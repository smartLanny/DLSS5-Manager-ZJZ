'use strict';
const { IDS } = require('../../src/product/launch-settings-policy');
// Explicit synthetic evidence for transaction tests. Production has no bypass.
function enhancementEvidence(overrides = {}) {
  return { support: { status: 'supported', source: 'catalog', evidence: ['synthetic-test-catalog'], capabilities: { dynamic: true, multipliers: [2, 3, 4, 5, 6],
    mfgUnlock: { available: true, api: 'dx12', multipliers: [2, 3, 4], runtimeVersion: '310.8.0.0' } } },
    gameSetting: { state: 'on', source: 'synthetic-game-config' },
    driver: { available: true, version: 60000, settingIds: [...IDS.sr, ...IDS.fg], perGameSupport: false }, ...overrides };
}
module.exports = { enhancementEvidence };
