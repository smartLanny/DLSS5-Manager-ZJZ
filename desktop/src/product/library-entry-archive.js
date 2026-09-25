'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const { atomicJson } = require('./launch-safety');

// This record describes retained ownership. It is never an uninstall receipt,
// and restoring/re-adding a library row must not replay a cancelled request.
async function archiveLibraryEntry({ userData, game, executable, state, aliases, waitingArchive }) {
  const backupDirectory = path.join(game.dir, '_DLSS5_Backup'), recoveryFiles = [];
  try {
    for (const name of await fs.readdir(backupDirectory)) {
      if (!/\.json$/i.test(name)) continue;
      const file = path.join(backupDirectory, name);
      try {
        const stat = await fs.lstat(file);
        const bytes = stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2 * 1024 * 1024 ? await fs.readFile(file) : null;
        recoveryFiles.push({ file, bytes: stat.size, sha256: bytes ? crypto.createHash('sha256').update(bytes).digest('hex') : null });
      } catch (error) { recoveryFiles.push({ file, unreadable: error.code || 'UNKNOWN' }); }
    }
  } catch (error) { if (error.code !== 'ENOENT') recoveryFiles.push({ directory: backupDirectory, unreadable: error.code || 'UNKNOWN' }); }
  const archiveFile = path.join(userData, 'library-archives', crypto.randomUUID() + '.json');
  await atomicJson(archiveFile, {
    schema: 1, action: 'remove-library-entry-keep-files', createdAt: new Date().toISOString(), restored: false,
    game: { id: game.id, dir: game.dir, name: game.name, executable,
      rootAliases: game.rootAliases || [], launcher: game.launcher || null, appid: game.appid || null },
    gameOverrides: Object.fromEntries(Object.entries(state.gameOverrides).filter(([dir, row]) => aliases.ownsMetadata(dir, row))),
    manualExecutables: state.manualExecutables.filter(row => aliases.ownsRoot(row.root)),
    manualGames: state.manualGames.filter(dir => aliases.ownsRoot(dir)),
    recovery: { status: 'retained-not-restored', backupDirectory, recoveryFiles,
      externalRuntimeDirectory: path.join(userData, 'external-runtime'), waitingArchive: waitingArchive || null }
  });
  return archiveFile;
}
module.exports = { archiveLibraryEntry };
