'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installMock } = require('./helpers/game-page-beta3-fixture.cjs');
const { createPolicyFixture } = require('./helpers/game-page-policy-fixture.cjs');
const { supportedProfileOptions } = require('../src/product/hoyoshade-profiles');
const { coreMenu } = require('../src/product/core-menu');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-ui-upgrade-'));
const fixture = createPolicyFixture(path.join(root, 'policy'));
const product = require('../product.json');
const features = { on40: {}, on50: {}, hoyoProfiles: supportedProfileOptions({ exe: path.join(root, 'StarRail.exe') }) };
const preload = path.join(root, 'preload.cjs');
fs.writeFileSync(preload, `(${installMock.toString()})(${JSON.stringify(features)},${JSON.stringify({ captureOnly: true, paths: fixture.paths })});
const boot = window.manager.boot;
window.manager.boot = async () => { const result = await boot(); Object.assign(result.value.product, ${JSON.stringify(product)}); return result; };
window.__curatedCores = ${JSON.stringify(coreMenu([{ id: '0.4.7beta', ready: true }, { id: '0.5-dline12', ready: true }], { installedVersion: '0.5-dline12', defaultVersion: '0.4.7beta' }))};
`);
app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
let win, assertions = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(fn, ...args) { return win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`); }
async function check(fn, label) { if (!await evaluate(fn)) throw Error(label); assertions++; }
async function until(fn, label) {
  for (let n = 0; n < 200; n++) { if (await evaluate(fn)) return; await delay(25); }
  throw Error('Timed out: ' + label);
}
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1100, height: 780, frame: false, show: false, useContentSize: true,
      webPreferences: { preload, sandbox: true, contextIsolation: false, nodeIntegration: false, offscreen: true } });
    await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
    await until(() => document.querySelector('.open-game-page-btn'), 'library');
    for (const [width, height] of [[1100, 780], [900, 620], [1000, 620], [1440, 900]]) {
      win.setContentSize(width, height); await delay(80);
      await check(() => {
        const side = document.querySelector('.sidebar');
        return side.getBoundingClientRect().bottom <= innerHeight + 1 && side.clientHeight <= innerHeight;
      }, 'sidebar stays within window ' + width);
      for (const id of ['bilibiliBtn', 'qqBtn', 'updateBtn']) {
        await evaluate(id => document.getElementById(id).scrollIntoView({ block: 'nearest' }), id);
        await check((() => {
          const item = document.getElementById('updateBtn'), side = item.closest('.sidebar');
          return side.scrollHeight >= side.clientHeight;
        }), 'sidebar is a usable scroll region');
        const visible = await evaluate(id => {
          const item = document.getElementById(id), r = item.getBoundingClientRect();
          return r.top >= 0 && r.bottom <= innerHeight + 1 && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === item;
        }, id);
        if (!visible) throw Error('unreachable footer ' + id + ' at ' + width); assertions++;
      }
      for (const theme of ['light', 'dark']) {
        await evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.dataset.motion = 'off'; }, theme);
        await delay(40);
        await check(() => {
          const luminance = text => {
            const values = text.match(/[\d.]+/g).slice(0, 3).map(n => Number(n) / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
            return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
          };
          return ['gameNameInput', 'renameGameInput'].every(id => {
            const style = getComputedStyle(document.getElementById(id)), a = luminance(style.color), b = luminance(style.backgroundColor);
            return (Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5;
          });
        }, 'game-name contrast ' + theme + '/' + width);
      }
    }
    win.setContentSize(1100, 780);
    await evaluate(() => document.querySelector('.open-game-page-btn').click());
    await until(() => document.querySelector('.game-detail')?.__gpController.getState().loaded.includes('installation'), 'installation');
    await evaluate(() => {
      window.__gpMock.assessment.coreVersions = window.__curatedCores;
      window.__gpMock.assessment.game.addonVersion = window.__gpMock.assessment.deployment.version = window.__gpMock.assessment.defaults.version = '0.5-dline12';
      return document.querySelector('.game-detail').__gpController.refresh(true);
    });
    await check(() => document.querySelector('[data-gp-group="route"][data-gp-field="version"]').value === '0.5-dline12', 'installed D12 survives curated menu');
    await check(() => {
      const options = [...document.querySelector('[data-gp-group="route"][data-gp-field="version"]').options];
      return options.some(row => row.value === 'unavailable-core-d21' && row.disabled) && options.some(row => row.value === '0.5-dline12' && !row.disabled);
    }, 'unavailable D21 cannot masquerade as installed D12');
    for (const motion of ['on', 'off']) for (const [width, height] of [[1100, 780], [900, 620]]) {
      win.setContentSize(width, height);
      await evaluate(motion => {
        document.documentElement.dataset.motion = motion;
        document.documentElement.dataset.theme = 'light';
        const host = document.querySelector('.game-detail'); host.style.minHeight = '2400px';
        const field = host.querySelector('[data-gp-group="nr"][data-gp-field="Intensity"]');
        field.value = '1.15'; field.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('view-games').scrollTop = 600;
        host.querySelector('[data-gp-action="preview"]').click();
      }, motion);
      await until(() => document.querySelector('.gp-modal'), 'preview');
      await delay(260);
      await check(() => {
        const modal = document.querySelector('.gp-modal'), r = modal.getBoundingClientRect();
        return Math.abs(r.top) < 1 && Math.abs(r.left) < 1 && Math.abs(r.width - innerWidth) < 1 && Math.abs(r.height - innerHeight) < 1 &&
          document.elementFromPoint(10, innerHeight / 2) === modal;
      }, 'fixed preview covers window ' + motion + '/' + width);
      await check(() => {
        const card = document.querySelector('.gp-modal-card'); card.scrollTop = 0;
        const r = card.querySelector('h3').getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight;
      }, 'preview heading is reviewable');
      await evaluate(() => document.querySelector('[data-gp-action="modal-cancel"]').click());
      await until(() => !document.querySelector('.gp-modal'), 'preview cancel');
    }
    await check(() => !window.__gpMock.calls.some(row => row[0] === 'apply' || row[0] === 'launch' || row[0] === 'startup-failed' || row[0].startsWith('direct-')), 'no application or launch during visual verification');
    console.log(JSON.stringify({ ok: true, assertions, scope: 'real renderer; synthetic IPC; no games or driver writes' }));
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack); win?.destroy(); app.exit(1); }
});
