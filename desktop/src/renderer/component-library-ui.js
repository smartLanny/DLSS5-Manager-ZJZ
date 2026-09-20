'use strict';
(function () {
  const $ = id => document.getElementById(id), message = $('componentLibraryMessage');
  const labels = { bridge: 'Bridge', feeder: 'Feeder', mfg: 'RTX 40 多帧生成', 'dlssg-sm86': 'RTX 20/30 多帧生成',
    'nr-runtime': '显卡运行库 DLC', core: 'Core', host: 'Feeder 运行宿主', 'user-addon': '用户插件', 'custom-candidate': '自定义候选' };
  const unwrap = result => { if (result?.ok === false) throw new Error(result.error?.message || '组件操作失败'); return result?.ok === true ? result.value : result; };
  const add = (parent, tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; parent.append(node); return node; };
  const label = kind => labels[kind] || kind;
  const running = new Set();
  let loaded = false, refreshPromise = null, refreshAgain = false, routeGeneration = 0;
  function sourceChanged(result) {
    window.dispatchEvent(new CustomEvent('manager-components-changed', { detail: result?.state }));
  }
  function renderRuntimeGuide(setup = {}) {
    const required = setup.runtimeDlcRequired === true && setup.ready !== true;
    $('componentRuntimeGuide').classList.toggle('hidden', !required);
    if (!required) return;
    const family = setup.hardwareFamily === 'RTX50' ? 'RTX 50' : setup.hardwareFamily === 'RTX40' ? 'RTX 20/30/40' : '当前显卡';
    $('componentRuntimeGuideTitle').textContent = `首次安装需要 ${family} 运行库`;
    $('componentRuntimeGuideText').textContent = '导入对应的运行库 DLC 后，返回游戏点击“应用”。';
    $('componentRuntimeGuideBadge').textContent = setup.hardwareFamily || '待识别';
  }
  function renderGroups(overview) {
    const host = $('componentLibraryRows'); host.replaceChildren();
    for (const group of overview.groups || []) {
      const row = add(host, 'article', 'component-package-row component-package-summary');
      const copy = add(row, 'div', 'component-package-copy');
      add(copy, 'strong', '', label(group.kind));
      const current = group.entries?.find(x => x.filesReady !== false && x.validation !== 'blocked');
      add(copy, 'span', '', current ? `${group.bundled ? '内置' : '已导入'} ${current.version}` : '随包文件未就绪');
      add(copy, 'small', '', group.message);
      add(row, 'span', `badge ${group.state === 'prepared' ? 'good' : 'warn'}`,
        group.state === 'prepared' ? '已准备' : group.state === 'needs-adapter' ? '待适配' : group.state === 'invalid' ? '需检查' : '未准备');
    }
    if (!host.childElementCount) add(host, 'p', 'component-empty', '未能读取随包组件，请刷新重试。');
  }
  function renderUpdates(overview) {
    const host = $('componentUpdateRows'); host.replaceChildren();
    const updates = overview.updates || [], ready = updates.filter(x => x.downloadable);
    $('componentDownloadCount').textContent = ready.length ? `${ready.length} 项可更新` : '暂无可用更新';
    for (const item of updates) {
      const row = add(host, 'article', 'component-package-row');
      const copy = add(row, 'div', 'component-package-copy');
      add(copy, 'strong', '', `${label(item.kind)} ${item.version}`);
      add(copy, 'small', '', item.message);
      if (item.downloadable) {
        const button = add(row, 'button', 'button', '下载更新');
        button.disabled = running.has(`download:${item.kind}`);
        button.onclick = () => perform(button, `download:${item.kind}`, '正在下载组件…', async () => {
          unwrap(await window.manager.downloadComponent(item.id)); sourceChanged();
          return '更新已准备，请到游戏页面应用。';
        });
      } else add(row, 'span', 'badge warn', '待验证');
    }
    if (!updates.length) add(host, 'p', 'component-download-empty', overview.checkedAt ? '当前可用组件已准备。' : '使用随包组件即可，也可以检查更新。');
  }
  function renderInventory(data) {
    const host = $('componentInventoryDetails'); host.replaceChildren();
    for (const item of (data.packages || []).filter(row => !row.internal)) {
      const row = add(host, 'div', 'component-package-row');
      const copy = add(row, 'div', 'component-package-copy');
      add(copy, 'strong', '', label(item.kind));
      add(copy, 'span', '', [item.version, item.variant].filter(Boolean).join(' · '));
      add(copy, 'small', '', item.validation === 'blocked' ? '文件校验未通过' : item.requiresAdapter ? '配套待适配' : item.source === 'bundled' ? '随包组件' : '已导入组件库');
      if (['nr-runtime', 'core'].includes(item.kind)) {
        const button = add(row, 'button', 'button', item.kind === 'core' ? '加入安装候选' : '用于后续安装');
        button.disabled = item.validation === 'blocked' || running.has(`activate:${item.kind}`);
        button.onclick = () => perform(button, `activate:${item.kind}`, '正在核对安装来源…', async () => {
          sourceChanged(unwrap(await (item.kind === 'core' ? window.manager.activateComponentCore(item.id) : window.manager.activateComponentRuntime(item.id))));
          return '安装来源已更新，现有游戏保持原设置。';
        });
      }
    }
    if (!host.childElementCount) add(host, 'p', 'component-empty', '暂无额外导入的组件。');
    $('componentStorageLocation').textContent = data.storage?.root ? `组件库：${data.storage.root}` : '';
  }
  async function refreshComponents() {
    if (refreshPromise) { refreshAgain = true; return refreshPromise; }
    refreshPromise = (async () => {
      do {
        refreshAgain = false;
        const data = unwrap(await window.manager.listComponents());
        loaded = true;
        renderRuntimeGuide(data.runtimeSetup); renderGroups(data.componentOverview || {});
        renderUpdates(data.componentOverview || {}); renderInventory(data);
        if (data.warnings?.length && !running.size) message.textContent = data.warnings.join('；');
      } while (refreshAgain);
    })();
    try { await refreshPromise; } finally { refreshPromise = null; }
  }
  async function refreshComponentRoute(loadGames = false) {
    const generation = ++routeGeneration, select = $('componentRouteGameSelect'), host = $('componentRouteSummary');
    try {
      if (loadGames) {
        const selected = select.value, games = unwrap(await window.manager.listGames());
        if (generation !== routeGeneration) return;
        select.replaceChildren();
        for (const game of games.filter(x => x.chosen?.path)) {
          const option = add(select, 'option', '', game.name); option.value = game.id;
        }
        if ([...select.options].some(x => x.value === selected)) select.value = selected;
      }
      host.replaceChildren();
      if (!select.value) { add(host, 'p', 'component-route-empty', '添加游戏后可查看实际搭配。'); return; }
      add(host, 'p', 'component-route-empty', '正在读取…');
      const result = unwrap(await window.manager.componentChoices(select.value));
      if (generation !== routeGeneration) return;
      host.replaceChildren();
      if (!result.stack) { add(host, 'p', 'component-route-empty', '请先在游戏页面选择图形接口。'); return; }
      add(host, 'strong', '', result.stack.title);
      const grid = add(host, 'div', 'component-route-items');
      for (const item of result.stack.items || []) {
        const card = add(grid, 'article', 'component-route-item');
        add(card, 'span', '', item.label); add(card, 'strong', '', item.value); add(card, 'small', '', item.detail || '');
      }
    } catch (error) {
      if (generation === routeGeneration) { host.replaceChildren(); add(host, 'p', 'error', error.message); }
    }
  }
  async function perform(button, key, progress, action) {
    if (running.has(key)) return;
    running.add(key); button.disabled = true; message.textContent = progress;
    let outcome;
    try { outcome = await action(); await refreshComponents(); }
    catch (error) { outcome = error.message; }
    finally {
      running.delete(key); button.disabled = false;
      if (!button.isConnected) await refreshComponents().catch(() => {});
      message.textContent = outcome || '已完成。';
    }
  }
  function bind(id, key, progress, action) { const button = $(id); button.onclick = () => perform(button, key, progress, action); }
  const importSelected = async directory => {
    const value = unwrap(await window.manager.pickComponent(directory));
    if (!value) return '已取消导入。';
    sourceChanged();
    return value.packages?.some(row => row.kind === 'custom-candidate') ? '文件已保存为待验证候选。' : '组件已导入，可到游戏页面应用。';
  };
  bind('importRuntimeDlcBtn', 'runtime', '请选择运行库 DLC…', async () => {
    const result = unwrap(await window.manager.pickRuntimeDlc());
    if (!result) return '已取消导入。'; sourceChanged(result);
    return result.message || '运行库已导入，可继续应用游戏设置。';
  });
  bind('importComponentBtn', 'import', '请选择组件文件…', () => importSelected(false));
  bind('importComponentDirBtn', 'import', '请选择组件目录…', () => importSelected(true));
  bind('moveComponentStorageBtn', 'move', '正在准备移动组件库…', async () => {
    const result = unwrap(await window.manager.moveComponentLibrary()); return result?.message || '已取消移动。';
  });
  bind('refreshComponentsBtn', 'refresh', '正在刷新…', async () => '组件状态已刷新。');
  bind('checkComponentUpdatesBtn', 'updates', '正在检查更新…', async () => {
    const results = unwrap(await window.manager.checkComponentUpdates());
    const failures = results.filter(row => row.error);
    return failures.length ? `${failures.map(row => label(row.kind)).join('、')}暂时无法检查更新；可以继续使用内置组件。` : '检查完成，兼容更新显示在下方。';
  });
  $('componentRuntimeHelpBtn').onclick = () => window.manager.openExternal('runtimePacksUrl');
  $('componentRouteGameSelect').onchange = () => void refreshComponentRoute();
  $('componentRouteDetails').addEventListener('toggle', () => { if ($('componentRouteDetails').open) void refreshComponentRoute(true); });
  window.addEventListener('manager-components-changed', () => {
    if (loaded) refreshComponents().catch(error => { message.textContent = error.message; });
  });
  const view = $('view-addons');
  const loadIfVisible = () => { if (view.classList.contains('active') && !loaded) refreshComponents().catch(error => { message.textContent = error.message; }); };
  new MutationObserver(loadIfVisible).observe(view, { attributes: true, attributeFilter: ['class'] });
  loadIfVisible();
})();
