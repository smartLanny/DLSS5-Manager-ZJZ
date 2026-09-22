(function (root, factory) {
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  else root.ManagerHoYoCorePolicy = policy;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Selection policy, not a grant of route compatibility or payload readiness.
  // Historical installed identities remain owned by their original receipts.
  const STANDARD = '0.4.7beta', CURRENT = '0.5-dline21-unified5';
  const standard = id => id === STANDARD || id === '0.4.7';
  function allowed(id, route = 'auto') {
    return id === CURRENT || standard(id) && route !== 'feeder';
  }
  function menu(rows, { route = 'auto' } = {}) {
    return (Array.isArray(rows) ? rows : []).filter(row => allowed(row.id) && row.comparisonOnly !== true).map(row => {
      if (!allowed(row.id, route)) return { ...row, ready: false, reason: '需要 Feeder，请选 0.5 Unified5。' };
      return { ...row };
    });
  }
  function assertTarget(id, route = 'auto') {
    if (allowed(id, route)) return;
    const oldCore = !allowed(id);
    throw Object.assign(new Error(oldCore ? '米哈游请选择 0.4.7 或当前 0.5 Unified5。原安装仍可修复和卸载。' :
      '当前 Feeder 配套需要 0.5 Unified5，请更换 Core 后应用。'),
    { code: oldCore ? 'HOYO_CORE_UNAVAILABLE' : 'HOYO_CORE_ROUTE_UNAVAILABLE' });
  }
  return Object.freeze({ STANDARD, CURRENT, allowed, menu, assertTarget });
});
