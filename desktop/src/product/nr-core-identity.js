'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { UNIFORM_SOURCE, resolveContract } = require('./nr-config-contract');
const { noLinks } = require('./launch-safety');

// Public artifact identities from the reviewed bilingual delivery manifest.
const UNIFORM_CORE_HASHES = Object.freeze([
  'dbf27301fd43a8753ac70590cd5aa9bdb27b73806391656326515ab363938edc',
  '01b4155dcca346f6b3485f210191baaaf4af6faa9dfb9b29302c8f7e36ae3c93'
]);
function createNrCoreIdentity({ digest = streamDigest, checkPath = noLinks } = {}) {
  const cache = new Map();
  async function fingerprint(file, fresh) {
    await checkPath(file);
    const before = await fs.promises.stat(file);
    if (!before.isFile()) throw new Error('Core path is not a file');
    const signature = statSignature(before), key = path.resolve(file).toLowerCase(), prior = cache.get(key);
    if (!fresh && prior?.signature === signature) return prior.hash;
    const hash = await digest(file), after = await fs.promises.stat(file);
    if (signature !== statSignature(after)) throw new Error('Core changed while reading its identity');
    cache.set(key, { signature, hash });
    if (cache.size > 64) cache.delete(cache.keys().next().value);
    return hash;
  }
  return async function identify({ version = '', files = [], fresh = false } = {}) {
    const unknown = (status, extra = {}) => ({ version, configContract: 'unknown', identityStatus: status, ...extra });
    const rows = [...new Map(files.filter(row => row?.path && path.isAbsolute(row.path)).map(row => [path.resolve(row.path).toLowerCase(), row])).values()];
    if (rows.length !== 1) return unknown(rows.length ? 'ambiguous' : 'missing');
    const row = rows[0];
    try {
      const hash = await fingerprint(row.path, fresh), matchedReceipt = hash === row.sha256;
      const identity = { corePath: row.path, coreSha256: hash, matchedReceipt };
      if (UNIFORM_CORE_HASHES.includes(hash)) return { version, configContract: 'nr-uniform-v1', sourceCommit: UNIFORM_SOURCE,
        identityStatus: matchedReceipt ? 'verified' : 'known-core-receipt-drift', ...identity };
      const legacy = resolveContract(version);
      if (matchedReceipt && legacy.known && !legacy.uniform) return { version, configContract: legacy.id, identityStatus: 'verified', ...identity };
      return unknown(matchedReceipt ? 'unrecognized' : 'changed', identity);
    } catch (error) { return unknown('unreadable', { error: { code: error.code || 'ERR_NR_CORE_IDENTITY', message: error.message } }); }
  };
}
function statSignature(stat) { return [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino, stat.dev].join(':'); }
async function streamDigest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
module.exports = { createNrCoreIdentity, UNIFORM_CORE_HASHES };
