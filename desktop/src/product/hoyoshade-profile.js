'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { noLinks, digestFile } = require('./launch-safety');
const { HOYO_RECIPE, HOYO_CLIENTS, supportedProfileOptions, selectedExe, clientFor, launcherRequest, validHoYoProfile, fingerprint } = require('./hoyoshade-profiles');

const fail = (code, message, details) => { throw Object.assign(new Error(message), { code: 'HOYO_' + code, details }); };
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function createHoYoProfileService(options) {
  const external = options.externalRuntime;
  if (!external || !path.isAbsolute(options.userData || '')) fail('CONFIG', '米哈游配置需要受管外置运行服务。');
  const pe = options.pe || require('../core/pe'), plans = new Map();
  const resources = options.resourcesPath || path.join(options.appDir || path.resolve(__dirname, '../..'), 'resources');
  async function recipe() {
    const file = path.join(resources, 'hoyoshade', 'component.json'); await noLinks(file);
    const stat = await fsp.stat(file); if (!stat.isFile() || stat.size > 64 * 1024) fail('RESOURCE', '米哈游配套说明无效。');
    const data = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (data.version !== 1 || data.id !== HOYO_RECIPE.id || data.sourceCommit !== HOYO_RECIPE.sourceCommit ||
        data.referenceArchive?.sha256 !== HOYO_RECIPE.archiveSha256 || data.loader?.sha256 !== HOYO_RECIPE.loaderSha256 ||
        data.policy?.firstInstall !== 'direct_hoyo' || data.policy?.protectionBypass !== false || data.policy?.terminateGame !== false)
      fail('RESOURCE', '米哈游配套版本或加载策略与固定记录不一致。');
    return data;
  }
  async function bind(game, input, inputRoute) {
    const client = clientFor(game, input), exePath = selectedExe(game);
    if (!client || !path.isAbsolute(exePath || '') || !['native', 'feeder'].includes(inputRoute)) fail('CLIENT', '请选择与实际 EXE 匹配的正式米哈游客户端。');
    const launcher = input.launcher;
    if (!['hoyoplay', 'starward'].includes(launcher.kind) || !path.isAbsolute(launcher.path || '') || /^\\\\/.test(launcher.path) || !/\.exe$/i.test(launcher.path))
      fail('LAUNCHER', '请选择已安装启动器的实际 EXE。');
    const wanted = launcher.kind === 'starward' ? ['starward.exe'] : ['hyp.exe', 'launcher.exe'];
    if (!wanted.includes(path.basename(launcher.path).toLowerCase()) || same(exePath, launcher.path)) fail('LAUNCHER', '启动器文件与所选种类不匹配。');
    await noLinks(exePath); await noLinks(launcher.path);
    if (pe.getBitness(exePath) !== 64 || ![32, 64].includes(pe.getBitness(launcher.path))) fail('ARCHITECTURE', '米哈游专用加载需要正式 x64 游戏和有效启动器。');
    const exeSha256 = await digestFile(exePath), launcherHash = await digestFile(launcher.path);
    if (!exeSha256 || !launcherHash) fail('FILE', '游戏或启动器文件不可读取。');
    const value = { version: 1, recipeId: HOYO_RECIPE.id, sourceCommit: HOYO_RECIPE.sourceCommit,
      family: client.family, channel: client.channel, releaseCategory: 'public', inputRoute,
      exePath: path.resolve(exePath), exeSha256, architecture: 64,
      launcher: { ...launcherRequest(client, launcher), sha256: launcherHash } };
    return { ...value, bindingId: fingerprint(value) };
  }
  function profile(game) {
    const layout = external.getLayout(game);
    if (layout.mode !== 'external' || layout.loadingMode !== 'helper' || !validHoYoProfile(layout.hoyoProfile, selectedExe(game)))
      return { installed: false, available: supportedProfileOptions(game).length > 0, source: 'hoyoshade-profile', verified: false,
        profileOptions: supportedProfileOptions(game), layout: null, runtimeVerified: false };
    const binding = layout.hoyoProfile;
    return { ...layout, installed: true, source: 'hoyoshade-profile', loadingBackend: 'hoyoshade',
      gameDir: layout.gameRoot, exePath: layout.exe, generation: layout.profileGeneration,
      family: binding.family, channel: binding.channel, inputRoute: binding.inputRoute,
      hoyo: { family: binding.family, channel: binding.channel, launcher: { kind: binding.launcher.kind, path: binding.launcher.path } },
      launcher: binding.launcher, targetExeSha256: binding.exeSha256, bindingId: binding.bindingId,
      helper: { adapter: 'hoyoshade', loadingBackend: 'hoyoshade', bindingId: binding.bindingId },
      runtimeVerified: false };
  }
  async function inspect(game) {
    const deployment = await external.inspect(game), result = profile(game);
    if (!result.installed) return { ...result, ready: false, supportedProfiles: supportedProfileOptions(game) };
    const blockers = [...(deployment.blockers || [])];
    try {
      await recipe(); await noLinks(result.exePath); await noLinks(result.launcher.path);
      if (await digestFile(result.exePath) !== result.targetExeSha256 || await digestFile(result.launcher.path) !== result.launcher.sha256)
        blockers.push('游戏或启动器已更新，请重新确认客户端绑定。');
    } catch (error) { blockers.push(error.message); }
    return { ...deployment, ...result, verified: deployment.verified === true && blockers.length === 0,
      ready: deployment.ready === true && blockers.length === 0, blockers, runtimeVerified: false };
  }
  async function preview(game, request = {}) {
    await recipe();
    const current = profile(game), selection = request.hoyo || request.profile || (current.installed ? current.hoyo : null);
    const inputRoute = request.inputRoute || current.inputRoute || 'native', binding = await bind(game, selection, inputRoute);
    if (request.payload?.reshade?.actual !== HOYO_RECIPE.loaderSha256) fail('LOADER', '米哈游路线只使用固定的 ReShade 6.8 完整 Add-on 配套。');
    const knownComponents = options.getKnownComponents ? await options.getKnownComponents(game) : [];
    const raw = await external.preview(game, { ...request, mode: 'external', loadingMode: 'helper', deploymentBackend: 'hoyoshade',
      inputRoute, hoyoProfile: binding, addonKeep: request.addonKeep || request.keepAddons || [], knownComponents });
    const projected = { ...raw.layout, source: 'hoyoshade-profile', loadingBackend: 'hoyoshade', gameDir: game.dir,
      exePath: binding.exePath, nrConfigDir: raw.layout.addonDirectory, generation: raw.layout.profileGeneration,
      launcher: binding.launcher, family: binding.family, channel: binding.channel, inputRoute,
      helper: { adapter: 'hoyoshade', loadingBackend: 'hoyoshade', bindingId: binding.bindingId }, verified: true };
    plans.set(raw.planId, { game, binding, projected });
    return { ...raw, loadingBackend: 'hoyoshade', origin: 'direct_hoyo', hoyo: selection, inputRoute,
      layout: projected, launcher: binding.launcher, profileOptions: supportedProfileOptions(game),
      evidence: { prepared: false, helperReady: false, reshadeLoaded: false, coreLoaded: false, nrVerified: false } };
  }
  async function apply(planId, consent = {}) {
    const plan = plans.get(planId); if (!plan) fail('PLAN', '米哈游预览已过期，请重新检查。');
    plans.delete(planId); await noLinks(plan.binding.exePath); await noLinks(plan.binding.launcher.path);
    if (await digestFile(plan.binding.exePath) !== plan.binding.exeSha256 || await digestFile(plan.binding.launcher.path) !== plan.binding.launcher.sha256)
      fail('PLAN_CHANGED', '预览后游戏或启动器发生变化，请重新绑定。');
    const result = await external.apply(planId, consent);
    return { ...result, layout: profile(plan.game), loadingBackend: 'hoyoshade', inputRoute: plan.binding.inputRoute };
  }
  async function restore(game, consent) { return external.restore(game, consent); }
  async function recover(game) { return external.recover(game); }
  return { preview, apply, inspect, profile, restore, recover, supportedProfileOptions,
    previewRestore: (game, mode = 'restore', internal = {}) => external.previewRemove(game, mode, internal) };
}

module.exports = { createHoYoProfileService, HOYO_RECIPE, HOYO_CLIENTS, supportedProfileOptions };
