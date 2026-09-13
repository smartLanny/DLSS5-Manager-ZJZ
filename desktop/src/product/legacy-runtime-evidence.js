'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { noLinks } = require('./launch-safety');
const { fileDigest, fingerprint, resolveFile, HASH } = require('./feeder-runtime');
const { createLegacyRuntime } = require('./legacy-runtime');
const MAX_LOG = 256 * 1024;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const started = value => typeof value === 'number' ? value : Date.parse(value || '');
const processValid = value => Number.isSafeInteger(value?.pid) && value.pid > 0 && Number.isFinite(started(value.startedAt));
const luid = value => typeof value === 'string' && /^[a-f0-9]{8}:[a-f0-9]{8}$/i.test(value) ? value.toUpperCase() : null;
const error = reason => Object.assign(new Error(reason), { code: 'LEGACY_EVIDENCE_UNAVAILABLE' });

// Read a fixed, regular file generation with a bounded tail. The anchor at the
// old cursor proves that an append did not silently replace earlier bytes.
async function snapshot(file, previous = null) {
  let handle;
  try {
    await noLinks(file); const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw error('log-not-regular');
    if (previous?.exists && (before.ino !== previous.ino || before.birthtimeMs !== previous.birthtimeMs || before.size < previous.offset)) throw error('log-replaced-or-truncated');
    handle = await fs.open(file, 'r'); const initial = await handle.stat();
    if (initial.ino !== before.ino || initial.size !== before.size || initial.mtimeMs !== before.mtimeMs) throw error('log-changing');
    async function bytesAt(offset, length) {
      const bytes = Buffer.alloc(length); let got = 0;
      while (got < length) { const chunk = await handle.read(bytes, got, length - got, offset + got); if (!chunk.bytesRead) throw error('log-changing'); got += chunk.bytesRead; }
      return bytes;
    }
    if (previous?.exists && digest(await bytesAt(previous.anchorStart, previous.offset - previous.anchorStart)) !== previous.anchor) throw error('log-rewritten');
    if (previous?.exists && digest(await bytesAt(0, previous.headSize)) !== previous.headAnchor) throw error('log-rewritten');
    const previousOffset = previous?.exists ? previous.offset : 0;
    const from = Math.max(previousOffset, initial.size - MAX_LOG);
    const head = await bytesAt(0, Math.min(initial.size, 4096));
    const tailStart = Math.max(0, initial.size - MAX_LOG), tail = await bytesAt(tailStart, initial.size - tailStart);
    const added = await bytesAt(from, initial.size - from);
    const anchorStart = Math.max(0, initial.size - 256), anchor = digest(await bytesAt(anchorStart, initial.size - anchorStart));
    const after = await handle.stat(); const current = await fs.lstat(file);
    if (after.size !== initial.size || after.mtimeMs !== initial.mtimeMs || current.ino !== initial.ino || current.size !== initial.size || current.mtimeMs !== initial.mtimeMs) throw error('log-changing');
    const text = tail.toString('utf8');
    return { exists: true, ino: initial.ino, birthtimeMs: initial.birthtimeMs, offset: initial.size, mtimeMs: initial.mtimeMs,
      anchorStart, anchor, headSize: head.length, headAnchor: digest(head), text: tailStart ? head.toString('utf8').split('\n').slice(0, -1).join('\n') + '\n' + text.slice(text.indexOf('\n') + 1) : text,
      added: (from > previousOffset ? added.toString('utf8').slice(added.indexOf(10) + 1) : added.toString('utf8')).split('\n').slice(0, -1).join('\n') };
  } catch (cause) {
    if (cause.code === 'ENOENT' && !previous?.exists) return { exists: false, offset: 0, text: '', added: '' };
    throw cause;
  } finally { await handle?.close(); }
}

function createLegacyEvidenceReader(options = {}) {
  const cursors = new WeakMap();
  const validateRecipe = options.validateRecipe || (recipe => createLegacyRuntime({ appDir: path.resolve(__dirname, '../..') }).validateStored(recipe));
  async function prepareLegacyEvidence({ game, layout, recipe, componentHashes, liveGame }) {
    if (!path.isAbsolute(game?.exePath || '') || !HASH.test(game?.exeSha256 || '') || !processValid(liveGame) ||
        liveGame.exePath && !same(liveGame.exePath, game.exePath) || !same(layout?.exePath, game.exePath) ||
        layout?.verified !== true || !path.isAbsolute(layout?.runtimeDir || '') || !path.isAbsolute(layout?.addonDirectory || '')) throw error('game-session-binding-invalid');
    validateRecipe(recipe);
    await noLinks(game.exePath);
    if (await fileDigest(game.exePath) !== game.exeSha256) throw error('game-executable-changed');
    const roots = { game: path.dirname(game.exePath), runtime: layout.runtimeDir, addon: layout.addonDirectory };
    const components = [];
    for (const row of recipe.files.filter(row => row.architecture)) {
      const file = resolveFile(roots[row.base], row.target); await noLinks(file);
      if (await fileDigest(file) !== row.sha256) throw error('component-changed');
      if (componentHashes && !componentHashes.some(item => same(item.path, file) && item.sha256 === row.sha256)) throw error('component-evidence-missing');
      components.push({ role: row.role, path: file, sha256: row.sha256, base: row.base, target: row.target });
    }
    const files = { game: path.join(layout.addonDirectory, 'dlss5-feed.log'), host: path.join(layout.addonDirectory, 'host64/dlss5-feed-host.log') };
    const logs = { game: await snapshot(files.game), host: recipe.hostRequired ? await snapshot(files.host) : null };
    const cursor = Object.freeze({ schema: 1, gamePid: liveGame.pid, startedAt: new Date(started(liveGame.startedAt)).toISOString(),
      recipeFingerprint: fingerprint(recipe), hostRequired: recipe.hostRequired, preparedAt: new Date().toISOString() });
    cursors.set(cursor, { game: { ...game }, process: { pid: liveGame.pid, startedAt: started(liveGame.startedAt) }, components, logs, files, recipe });
    return cursor;
  }
  async function assessLegacyEvidence({ cursor, liveProcesses, expectedHardwareLuid }) {
    const result = { targetLoader: false, host: cursor?.hostRequired ? false : null, processed: false, newFrames: 0, epoch: null, runtimeVerified: false, reason: 'session-cursor-unavailable' };
    const state = cursors.get(cursor); if (!state || !Array.isArray(liveProcesses)) return result;
    const fail = reason => ({ ...result, reason });
    const hardware = luid(expectedHardwareLuid); if (!hardware) return fail('hardware-luid-unavailable');
    const game = liveProcesses.find(row => row.pid === state.process.pid);
    if (!processValid(game) || started(game.startedAt) !== state.process.startedAt || !same(game.exePath, state.game.exePath) || game.exeSha256 !== state.game.exeSha256) return fail('game-process-no-longer-matches');
    const loaded = (process, rows) => rows.every(row => process.modules?.some(module => same(module.path, row.path) && module.sha256 === row.sha256));
    const gameComponents = state.components.filter(row => !row.target.startsWith('host64/'));
    if (!loaded(game, gameComponents)) return fail('target-loader-or-provider-not-loaded');
    result.targetLoader = true;
    let gameLog, hostLog;
    try {
      gameLog = await snapshot(state.files.game, state.logs.game);
      hostLog = cursor.hostRequired ? await snapshot(state.files.host, state.logs.host) : null;
    } catch (cause) { return fail(cause.code === 'LEGACY_EVIDENCE_UNAVAILABLE' ? cause.message : 'log-read-unavailable'); }
    if (!gameLog.exists || gameLog.mtimeMs < state.process.startedAt) return fail('current-game-log-unavailable');
    const sessions = [...gameLog.text.matchAll(/\[nr-feeder-session\] pid=(\d+) source=0151-external-v1/g)];
    if (Number(sessions.at(-1)?.[1]) !== game.pid) return fail('game-log-session-mismatch');
    const currentSession = gameLog.text.slice(gameLog.text.lastIndexOf('[nr-feeder-session]'));
    if (cursor.hostRequired) {
      if (!hostLog?.exists || hostLog.mtimeMs < state.process.startedAt) return fail('current-host-log-unavailable');
      const records = [...hostLog.added.matchAll(/\[nr-feeder-host-ack\] pid=(\d+) game_pid=(\d+) frame=(\d+) epoch=(\d+) output_ready=(\d+) nr_completed=(\d+) luid=([A-Fa-f0-9]{8}:[A-Fa-f0-9]{8})/g)];
      const ack = records.at(-1); if (!ack) return fail('new-host-ack-unavailable');
      const host = liveProcesses.find(row => row.pid === Number(ack[1])); const expected = state.components.find(row => row.role === 'host');
      if (Number(ack[2]) !== game.pid || !processValid(host) || started(host.startedAt) < state.process.startedAt ||
          !same(host.exePath, expected?.path) || host.exeSha256 !== expected?.sha256 || host.parentPid !== game.pid ||
          luid(ack[7]) !== hardware || host.hardwareLuid && luid(host.hardwareLuid) !== hardware) return fail('host-process-or-adapter-mismatch');
      const hostModules = state.components.filter(row => row.target.startsWith('host64/') && row.role !== 'host');
      if (!loaded(host, hostModules)) return fail('host-components-not-loaded');
      result.host = true;
      const clients = [...gameLog.added.matchAll(/\[nr-feeder-client-completion\] frame=(\d+) output_ready=1 nr_completed=1/g)].map(row => Number(row[1]));
      const matches = records.filter(row => Number(row[1]) === host.pid && Number(row[2]) === game.pid && row[5] === '1' && row[6] === '1' && luid(row[7]) === hardware && clients.includes(Number(row[3])));
      const latest = matches.at(-1); if (!latest || ack[5] !== '1' || ack[6] !== '1') return fail('new-same-frame-nr-completion-unavailable');
      const lastComplete = currentSession.lastIndexOf('[nr-feeder-client-completion]'), lastRetained = currentSession.lastIndexOf('[nr-feeder-client-retained]');
      if (lastRetained > lastComplete) return fail('latest-game-frame-retained');
      result.newFrames = new Set(matches.map(row => row[3])).size; result.epoch = Number(latest[4]); result.frame = Number(latest[3]); result.hostPid = host.pid;
    } else {
      const devices = [...currentSession.matchAll(/\[nr-feeder-device\] pid=(\d+) epoch=(\d+) luid=([A-Fa-f0-9]{8}:[A-Fa-f0-9]{8})/g)];
      const device = devices.at(-1); if (Number(device?.[1]) !== game.pid || luid(device?.[3]) !== hardware) return fail('game-adapter-mismatch');
      const records = [...gameLog.added.matchAll(/\[nr-feeder-completion\] frame=(\d+) epoch=(\d+) nr_completed=1 output_recorded=1 provenance=Synthetic/g)].filter(row => row[2] === device[2]);
      if (!records.length || currentSession.lastIndexOf('[nr-feeder-retained]') > currentSession.lastIndexOf('[nr-feeder-completion]')) return fail('new-native-nr-completion-unavailable');
      result.newFrames = new Set(records.map(row => row[1])).size; result.epoch = Number(records.at(-1)[2]); result.frame = Number(records.at(-1)[1]);
    }
    // Evidence is a fresh interval, never a reusable success flag.
    state.logs = { game: gameLog, host: hostLog };
    return { ...result, processed: true, runtimeVerified: true, reason: 'new-session-bound-nr-completion' };
  }
  return { prepareLegacyEvidence, assessLegacyEvidence };
}
const reader = createLegacyEvidenceReader();
module.exports = { ...reader, createLegacyEvidenceReader };
