(function (root, factory) {
  const catalog = typeof module === 'object' && module.exports ? require('./core-catalog') : root.ManagerCoreCatalog;
  const policy = factory(catalog);
  if (typeof module === 'object' && module.exports) module.exports = policy;
  else root.ManagerHoYoCorePolicy = policy;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (catalog) {
  'use strict';
  // Selection policy, not a grant of route compatibility or payload readiness.
  // Historical installed identities remain owned by their original receipts.
  // HoYo offers the stable 0.4.7 and the catalog's current provider Core only.
  const STANDARD = catalog.STABLE, CURRENT = catalog.RECOMMENDED, CURRENT_LABEL = catalog.byId(CURRENT).label;
  const standard = id => id === STANDARD || id === '0.4.7';
  function allowed(id, route = 'auto') {
    return id === CURRENT || standard(id) && route !== 'feeder';
  }
  function menu(rows, { route = 'auto' } = {}) {
    return (Array.isArray(rows) ? rows : []).filter(row => allowed(row.id) && row.comparisonOnly !== true).map(row => {
      if (!allowed(row.id, route)) return { ...row, ready: false, reason: `需要 Feeder，请选 ${CURRENT_LABEL}。` };
      return { ...row };
    });
  }
  function assertTarget(id, route = 'auto') {
    if (allowed(id, route)) return;
    const oldCore = !allowed(id);
    throw Object.assign(new Error(oldCore ? `米哈游请选择 0.4.7 或当前 ${CURRENT_LABEL}。原安装仍可修复和卸载。` :
      `当前 Feeder 配套需要 ${CURRENT_LABEL}，请更换 Core 后应用。`),
    { code: oldCore ? 'HOYO_CORE_UNAVAILABLE' : 'HOYO_CORE_ROUTE_UNAVAILABLE' });
  }
  return Object.freeze({ STANDARD, CURRENT, allowed, menu, assertTarget });
});
