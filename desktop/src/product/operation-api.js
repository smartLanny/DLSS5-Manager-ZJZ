'use strict';

const { classifyApi } = require('./game-support');

const shared = require('../shared/api-resolution');

// The saved preference and the detected API are separate values. In particular,
// choosing auto must never reuse an effective API produced by a manual override.
function resolveOperationApi(game, request = {}) {
  return shared.resolveOperationApi(game, request, chosen => classifyApi({ ...chosen, apiResolution: null }));
}

function requiresOperationApi(request) {
  if (request.uninstall) return false;
  return ['api', 'version', 'route', 'deployment', 'loadingMode', 'loadingBackend', 'proxyEntry', 'components', 'hoyo'].some(key => request[key] !== undefined) ||
    Boolean(request.nr && Object.keys(request.nr).length) ||
    Boolean(request.sr && request.sr.quality !== 'game') || Boolean(request.fg && request.fg.mode !== 'restore');
}

module.exports = { resolveOperationApi, requiresOperationApi };
