'use strict';

// Product adapter: launcher discovery never delegates Windows registry lookup
// to the pinned vendor process. The vendor's public folder/Steam primitives
// remain the source of game parsing and dedupe behavior.
const fs = require('node:fs');
const path = require('node:path');
const vendor = require('../vendor/DLSS5-Swapper/src/library.js');
const { createLauncherLocations } = require('./product/launcher-locations');

function inside(file, root) {
  const candidate = path.resolve(file).toLowerCase();
  const parent = path.resolve(root).toLowerCase();
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function createLibraryAdapter(options = {}) {
  const locations = options.launcherLocations || createLauncherLocations(options.launcherOptions);
  const epicReader = options.epicReader || (() => locations.epic());

  function steamRoots(snapshot, extraFolders = []) {
    const saved = extraFolders.filter(folder => {
      try { return fs.existsSync(path.join(folder, 'steamapps')); } catch { return false; }
    });
    return [...new Set([
      snapshot.steamPath,
      ...(snapshot.steamRoots || []),
      ...locations.defaultSteamRoots(),
      ...saved
    ].filter(Boolean).map(root => path.resolve(root)))];
  }

  function discover(extraFolders = [], scanDrives = false, excludedRoots = []) {
    const snapshot = locations.snapshot();
    const warnings = [...(snapshot.warnings || [])];
    const roots = steamRoots(snapshot, extraFolders).filter(root => !excludedRoots.some(excluded => inside(root, excluded)));
    const games = [];
    try { games.push(...vendor.steam({ roots, platform: 'win32' })); }
    catch (error) { warnings.push({ code: 'LAUNCHER_STEAM_SCAN_FAILED', message: 'Steam 清单扫描失败，已保留其它来源。', source: 'launcher-locations', details: { cause: error.code || 'scan' } }); }

    for (const row of snapshot.gog || []) {
      if (!row.path || !path.isAbsolute(row.path) || !fs.existsSync(row.path) || excludedRoots.some(excluded => inside(row.path, excluded))) continue;
      games.push({ launcher: 'GOG', id: row.id || null, name: row.name || path.basename(row.path), dir: row.path, poster: null });
    }

    try {
      const epic = epicReader();
      games.push(...(epic.games || []));
      warnings.push(...(epic.warnings || []));
    } catch (error) {
      warnings.push({ code: 'LAUNCHER_EPIC_SCAN_FAILED', message: 'Epic 清单扫描失败，已保留其它来源。', source: 'launcher-locations', details: { cause: error.code || 'scan' } });
    }

    const autoRoots = scanDrives && typeof vendor.autoRoots === 'function' ? vendor.autoRoots() : [];
    const rootsToScan = [...new Set([...autoRoots, ...extraFolders].filter(root => typeof root === 'string' && path.isAbsolute(root)))]
      .filter(root => !excludedRoots.some(excluded => inside(root, excluded)));
    for (const root of rootsToScan) {
      try { games.push(...vendor.folder(root, 'My folders', true)); }
      catch (error) { warnings.push({ code: 'LAUNCHER_FOLDER_SCAN_FAILED', message: '本地游戏目录扫描失败，已保留其它来源。', source: 'launcher-locations', details: { root, cause: error.code || 'scan' } }); }
    }

    return { games: vendor.dedupe(vendor.filterExcluded ? vendor.filterExcluded(games, excludedRoots) : games), roots: autoRoots, warnings };
  }

  function steam(options = {}) {
    const snapshot = locations.snapshot();
    return vendor.steam({ ...options, roots: options.roots || steamRoots(snapshot), platform: options.platform || 'win32' });
  }

  return Object.freeze({
    discover,
    steam,
    folder: vendor.folder,
    dedupe: vendor.dedupe,
    autoRoots: vendor.autoRoots,
    drives: vendor.drives,
    isInside: vendor.isInside,
    filterExcluded: vendor.filterExcluded,
    linuxSteamRoots: vendor.linuxSteamRoots
  });
}

const adapter = createLibraryAdapter();
module.exports = Object.freeze({ ...adapter, createLibraryAdapter, createLauncherLocations });
