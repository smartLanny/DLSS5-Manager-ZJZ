'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Read only launcher-owned local configuration. Keep no account identifiers
// or unrelated launch strings in the public game/feedback record.
function parseVdf(text) {
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}]/g) || [];
  const root = Object.create(null);
  const stack = [root];
  let key = null;
  for (const token of tokens) {
    if (token === '{') {
      if (key === null || stack.length > 32) return null;
      const next = Object.create(null);
      stack[stack.length - 1][key] = next;
      stack.push(next); key = null;
    } else if (token === '}') {
      if (stack.length < 2 || key !== null) return null;
      stack.pop();
    } else {
      const value = token.slice(1, -1).replace(/\\(["\\])/g, '$1');
      if (key === null) key = value.toLowerCase();
      else { stack[stack.length - 1][key] = value; key = null; }
    }
  }
  return stack.length === 1 && key === null ? root : null;
}

function samePath(left, right) {
  return Boolean(left && right) && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

// A manual EXE can retain its discovered Steam identity, but a user-entered app
// number or a same-named executable outside that installation cannot claim it.
function steamLaunchIdentity(exe, games) {
  if (typeof exe !== 'string' || !path.isAbsolute(exe) || !/\.exe$/i.test(exe)) return {};
  const found = new Map();
  for (const game of games || []) {
    if (game.launcher !== 'Steam' || !/^\d{1,10}$/.test(String(game.id)) || !game.dir || !path.isAbsolute(game.dir)) continue;
    const relative = path.relative(path.resolve(game.dir), path.resolve(exe));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    const identity = { steamAppId: String(game.id), steamRoot: game.steamRoot && path.isAbsolute(game.steamRoot) ? path.resolve(game.steamRoot) : null,
      steamEntryRoot: path.resolve(game.dir), steamIdentityVerified: true };
    found.set(`${identity.steamAppId}:${identity.steamEntryRoot.toLowerCase()}`, identity);
  }
  return found.size === 1 ? [...found.values()][0] : {};
}

function readActiveSteamAccount(steamRoot) {
  if (process.platform !== 'win32') return null;
  try {
    const options = { windowsHide: true, encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] };
    const installation = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], options);
    const installedPath = /SteamPath\s+REG_SZ\s+(.+)/i.exec(installation)?.[1]?.trim();
    if (!samePath(installedPath, steamRoot)) return null;
    const active = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam\\ActiveProcess'], options);
    const user = /\bActiveUser\s+REG_DWORD\s+(0x[\da-f]+|\d+)/i.exec(active)?.[1];
    const pid = /\bpid\s+REG_DWORD\s+(0x[\da-f]+|\d+)/i.exec(active)?.[1];
    if (!user || !pid || !Number(user) || !Number(pid)) return null;
    process.kill(Number(pid), 0);
    return String(Number(user));
  } catch { return null; }
}

function gameArguments(value) {
  if (typeof value !== 'string') return { arguments: '', valid: false };
  let args = value.trim();
  // A shell/wrapper launch expression is not evidence of arguments passed to
  // the selected game. Retain it only as an unbound clue.
  if (/[\r\n|<>;&`]/.test(args)) return { arguments: args, valid: false };
  if (/%command%/i.test(args)) {
    if (!/^%command%(?:\s|$)/i.test(args)) return { arguments: args, valid: false };
    args = args.replace(/^%command%\s*/i, '');
  }
  return { arguments: args, valid: !args || /^[-+]/.test(args) };
}

function createLaunchContext(options = {}) {
  const cache = new Map();
  return game => {
    const launchMode = game?.launchMode === 'steam' ? 'steam' : 'exe';
    if (!game || game.launcher !== 'Steam' || !game.steamRoot || !/^\d+$/.test(String(game.id))) return { launchMode };
    const root = path.resolve(game.steamRoot);
    if (!cache.has(root)) {
      const activeAccount = (options.readActiveAccount || readActiveSteamAccount)(root);
      const active = /^\d+$/.test(String(activeAccount || '')) && Number(activeAccount) > 0 ? String(activeAccount) : null;
      const profiles = [];
      const userdata = path.join(root, 'userdata');
      let users = active ? [{ name: active }] : [];
      if (!active) try { users = fs.readdirSync(userdata, { withFileTypes: true }).filter(row => row.isDirectory() && /^\d+$/.test(row.name)).slice(0, 8); } catch {}
      for (const user of users) {
        const file = path.join(userdata, user.name, 'config', 'localconfig.vdf');
        try {
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) continue;
          const data = parseVdf(fs.readFileSync(file, 'utf8'));
          const values = data?.userlocalconfigstore?.software?.valve?.steam?.apps;
          if (values && typeof values === 'object') profiles.push({ apps: values, current: user.name === active });
        } catch {}
      }
      cache.set(root, { profiles, active });
    }
    const { profiles, active } = cache.get(root);
    const values = profiles.map(profile => profile.apps[String(game.id)]?.launchoptions).filter(value => typeof value === 'string' && value.length <= 4096);
    const parsed = values.map(gameArguments);
    const current = Boolean(active && profiles.length === 1 && profiles[0].current);
    return { launchMode, launchArguments: [...new Set(parsed.map(row => row.arguments))],
      launchArgumentsSource: current ? 'steam-active-account' : 'steam-unbound-profiles',
      launchArgumentsApplied: launchMode === 'steam' && current && parsed.length === 1 && parsed[0].valid,
      steamAccountVerified: current };
  };
}

module.exports = { createLaunchContext, steamLaunchIdentity };
