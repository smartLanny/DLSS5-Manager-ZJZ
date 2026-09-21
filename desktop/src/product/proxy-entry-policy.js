'use strict';
const path = require('node:path');

// This is an installation preference, not a rendering or API-detection rule.
// Bind it to the selected game executable, never its editable library title.
function proxyEntryDefault({ game, api, request = {}, layout = {}, manifest = null }) {
  if (request.proxyEntry && request.proxyEntry !== 'auto') return request.proxyEntry;
  const backend = request.loadingBackend || layout.loadingBackend;
  if (backend === 'hoyoshade' || api === 'vulkan') return 'auto';
  if (layout.mode === 'external' || layout.source === 'feeder') {
    if (['dxgi', 'd3d11', 'd3d12'].includes(layout.recipe?.proxyEntry))
      return layout.recipe.proxyEntry === 'd3d12' && api === 'dx11' ? 'dxgi' : layout.recipe.proxyEntry;
    const entry = (layout.proxyPaths || []).map(file => path.basename(file).toLowerCase()).find(name => /^(dxgi|d3d11|d3d12)\.dll$/.test(name));
    if (entry) return entry === 'd3d12.dll' && api === 'dx11' ? 'dxgi' : entry.slice(0, -4);
    // An existing helper/profile must keep its owner's current selection.
    return 'auto';
  }
  if (manifest) return manifest.reshadeRoute === 'd3d12' && api === 'dx11' ? 'dxgi' : manifest.reshadeRoute || 'dxgi';
  return api === 'dx12' && path.basename(game?.scan?.chosen?.path || '').toLowerCase() === 'htgame.exe' ? 'd3d12' : 'auto';
}

module.exports = { proxyEntryDefault };
