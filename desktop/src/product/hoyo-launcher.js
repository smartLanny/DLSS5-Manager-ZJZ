'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { noLinks, digestFile, assertLaunchNotCancelled } = require('./launch-safety');
const { validHoYoProfile } = require('./hoyoshade-profiles');
const fail = (code, message) => { throw Object.assign(new Error(message), { code: 'HOYO_LAUNCH_' + code }); };
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function readStarwardProtocol() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);$k=Get-Item -LiteralPath 'Registry::HKEY_CURRENT_USER\\Software\\Classes\\Starward' -ErrorAction SilentlyContinue;if($null -eq $k){'null'}else{$c=Get-Item -LiteralPath 'Registry::HKEY_CURRENT_USER\\Software\\Classes\\Starward\\Shell\\Open\\Command' -ErrorAction SilentlyContinue;[ordered]@{enabled=($k.GetValueNames() -contains 'URL Protocol');command=if($c){[string]$c.GetValue('')}else{''}}|ConvertTo-Json -Compress}";
  return new Promise((resolve, reject) => execFile(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 16384 }, (error, stdout) => {
      if (error) { reject(error); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(Error('Starward protocol is unreadable.')); }
    }));
}
function validateStarwardProtocol(value, launcher) {
  // Starward's documented registration is exactly: "Starward.exe" "%1".
  // Do not evaluate registry command strings, append unknown switches or route
  // a saved URI to another executable registered after the profile was bound.
  const match = value?.enabled === true && typeof value.command === 'string' && value.command.match(/^\s*"([^"\r\n]+\.exe)"\s+"%1"\s*$/i);
  if (!match || !same(match[1], launcher.path)) fail('PROTOCOL', '请在已绑定的 Starward 中开启 URL 协议注册，再重新检查。');
  return crypto.createHash('sha256').update(value.command).digest('hex');
}
function createHoYoLauncher({ broker, readProtocol = readStarwardProtocol, isAdministrator, spawnLauncher = spawn,
  readExecutionLevel = require('./game-launch-broker').executionLevel }) {
  async function resolve(layout) {
    if (!layout?.installed || layout.source !== 'hoyoshade-profile' || !layout.verified ||
      !validHoYoProfile(layout.hoyoProfile, layout.exe)) fail('PROFILE', '米哈游外置配置尚未就绪，请先检查当前绑定。');
    const binding = layout.hoyoProfile, launcher = binding.launcher;
    await noLinks(layout.exe); await noLinks(launcher.path);
    if (await digestFile(layout.exe) !== binding.exeSha256 || await digestFile(launcher.path) !== launcher.sha256)
      fail('CHANGED', '游戏或启动器在绑定后更新，请重新确认客户端。');
    const protocolFingerprint = launcher.kind === 'starward' ? validateStarwardProtocol(await readProtocol(), launcher) : null;
    const uri = launcher.kind === 'starward' ? `${launcher.uri}?install_path=${encodeURIComponent(path.dirname(layout.exe))}` : null;
    const elevatedTarget = ['requireAdministrator', 'highestAvailable'].includes(readExecutionLevel(layout.exe));
    return { exe: layout.exe, launchMode: launcher.kind, launcher: { ...launcher, uri, protocolFingerprint },
      helper: { gameId: layout.gameId, adapter: 'hoyoshade', bindingId: layout.bindingId }, loadingBackend: 'hoyoshade', elevatedTarget,
      launchInstruction: launcher.kind === 'hoyoplay' ? '加载助手已就绪，请在 HoYoPlay 中点击此游戏的启动按钮。' : '正在通过已绑定的 Starward 启动当前游戏。' };
  }
  async function launch(layout, controls) {
    assertLaunchNotCancelled(controls);
    const target = await resolve(layout);
    assertLaunchNotCancelled(controls);
    const args = target.launchMode === 'starward' ? [target.launcher.uri] : [];
    if (target.elevatedTarget) {
      if (!isAdministrator || await isAdministrator() !== true) fail('PRIVILEGE', '此米哈游客户端需要本次管理员加载助手。');
      assertLaunchNotCancelled(controls);
      // This branch runs only inside the authenticated, one-shot HoYo worker.
      // It opens the bound launcher and never substitutes the game EXE.
      await new Promise((resolve, reject) => {
        const child = spawnLauncher(target.launcher.path, args, { cwd: path.dirname(target.launcher.path), windowsHide: false, stdio: 'ignore' });
        child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
      });
    } else await broker.launch({ exe: target.launcher.path, args, cwd: path.dirname(target.launcher.path) }, controls);
    return target;
  }
  return { resolve, launch };
}
module.exports = { createHoYoLauncher, readStarwardProtocol, validateStarwardProtocol };
