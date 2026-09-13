'use strict';

function resolveVersion({ game, requestedVersion = null, globalVersion = null, dx11Version, dx11Only = false }) {
  if (requestedVersion) return requestedVersion;
  if (game && game.addonVersion) return game.addonVersion;
  if (globalVersion) return globalVersion;
  if (dx11Only) return dx11Version;
  return undefined;
}

module.exports = { resolveVersion };
