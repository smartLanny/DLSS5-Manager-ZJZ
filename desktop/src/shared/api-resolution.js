(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ManagerOperationApi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const supported = new Set(['dx9', 'dx10', 'dx11', 'dx12', 'vulkan']);
  function resolveOperationApi(game, request = {}, fallback) {
    const chosen = game?.scan?.chosen || game?.chosen || {};
    const preference = request.api ?? game?.apiOverride ??
      (chosen.apiResolution?.source === 'override' ? chosen.apiResolution.api : 'auto');
    const manual = Boolean(game?.apiOverride && game.apiOverride !== 'auto') ||
      chosen.apiResolution?.source === 'override' || chosen.apiAssessment?.source === 'override';
    const detected = chosen.detectedApiResolution?.api || chosen.detectedApi ||
      (!manual ? chosen.apiResolution?.api : null) ||
      (!manual ? chosen.apiAssessment?.effectiveApi : null) || game?.operationApi?.detectedApi ||
      (typeof fallback === 'function' ? fallback(chosen) : 'unknown');
    const effectiveApi = preference === 'auto' ? detected || 'unknown' : preference;
    return { api: preference, effectiveApi, detectedApi: detected || 'unknown',
      supported: supported.has(effectiveApi), requiresManualSelection: ['unknown', 'mixed'].includes(effectiveApi) };
  }
  return { resolveOperationApi };
});
