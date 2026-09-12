'use strict';
const path = require('node:path');
const crypto = require('node:crypto');

const HOYO_RECIPE = Object.freeze({ id: 'hoyoshade-beta9-profile-v1', tag: 'V3.0.0-Beta.9',
  sourceCommit: '23761f935444a78388c028fbfda921965177c453',
  archiveSha256: 'ca982d326145b9b5e2f2c864fd484fa4ea098d731de6535c023678d5c8f99d77',
  loaderSha256: '0cee63f9c9f13f3ac909c5b4903f4dbb4b719a7ab3b4f13b0deaf83c814b94f7' });
const names = { genshin: '原神', honkai3: '崩坏3', starrail: '崩坏：星穹铁道', zzz: '绝区零' };
const channels = { cn: '国服', bilibili: 'B站渠道服', global: '国际服' };
const HOYO_CLIENTS = Object.freeze([
  ['genshin', 'cn', 'YuanShen.exe', 'hk4e_cn'], ['genshin', 'bilibili', 'YuanShen.exe', 'hk4e_bilibili'],
  ['genshin', 'global', 'GenshinImpact.exe', 'hk4e_global'],
  ['honkai3', 'cn', 'BH3.exe', 'bh3_cn'], ['honkai3', 'global', 'BH3.exe', 'bh3_global'],
  ['starrail', 'cn', 'StarRail.exe', 'hkrpg_cn'], ['starrail', 'bilibili', 'StarRail.exe', 'hkrpg_bilibili'], ['starrail', 'global', 'StarRail.exe', 'hkrpg_global'],
  ['zzz', 'cn', 'ZenlessZoneZero.exe', 'nap_cn'], ['zzz', 'bilibili', 'ZenlessZoneZero.exe', 'nap_bilibili'], ['zzz', 'global', 'ZenlessZoneZero.exe', 'nap_global']
].map(([family, channel, exeName, gameBiz]) => Object.freeze({ family, channel, exeName, gameBiz,
  familyLabel: names[family], channelLabel: channels[channel], releaseCategory: 'public', launcherKinds: ['hoyoplay', 'starward'] })));
const HASH = /^[a-f0-9]{64}$/;
const key = file => path.resolve(file).toLowerCase();
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const selectedExe = game => game?.scan?.chosen?.path || game?.chosen?.path || game?.exe || game?.exePath;

function supportedProfileOptions(game) {
  const exe = selectedExe(game);
  return typeof exe === 'string' ? HOYO_CLIENTS.filter(row => row.exeName.toLowerCase() === path.basename(exe).toLowerCase()).map(row => ({ ...row })) : [];
}
function clientFor(game, binding) {
  if (!binding || Object.keys(binding).some(name => !['family', 'channel', 'launcher'].includes(name)) ||
      !binding.launcher || Object.keys(binding.launcher).some(name => !['kind', 'path'].includes(name))) return null;
  return supportedProfileOptions(game).find(row => row.family === binding.family && row.channel === binding.channel) || null;
}
function launcherRequest(client, binding) {
  return binding.kind === 'starward' ? { kind: 'starward', path: path.resolve(binding.path), gameBiz: client.gameBiz,
    uri: 'starward://startgame/' + client.gameBiz, mode: 'verified-uri' } :
    { kind: 'hoyoplay', path: path.resolve(binding.path), mode: 'open-and-wait' };
}
function validHoYoProfile(value, exe) {
  try {
    if (!value || value.version !== 1 || value.recipeId !== HOYO_RECIPE.id || value.sourceCommit !== HOYO_RECIPE.sourceCommit ||
        value.releaseCategory !== 'public' || !path.isAbsolute(value.exePath || '') || key(value.exePath) !== key(exe) ||
        !HASH.test(value.exeSha256 || '') || value.architecture !== 64 || !HASH.test(value.bindingId || '') ||
        !['native', 'feeder'].includes(value.inputRoute) || !path.isAbsolute(value.launcher?.path || '') ||
        !HASH.test(value.launcher?.sha256 || '') || !['hoyoplay', 'starward'].includes(value.launcher.kind)) return false;
    const client = supportedProfileOptions({ exe }).find(row => row.family === value.family && row.channel === value.channel);
    if (!client) return false;
    const expected = launcherRequest(client, value.launcher), { sha256, ...actual } = value.launcher;
    if (JSON.stringify(expected) !== JSON.stringify(actual)) return false;
    const { bindingId, ...body } = value;
    return fingerprint(body) === bindingId;
  } catch { return false; }
}

module.exports = { HOYO_RECIPE, HOYO_CLIENTS, supportedProfileOptions, selectedExe, clientFor, launcherRequest, validHoYoProfile, fingerprint };
