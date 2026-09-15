'use strict';
(function () {
  const $ = id => document.getElementById(id), message = $('componentLibraryMessage');
  let startupUpdateCheck = false;
  const kindLabel = kind => ({ 'nr-runtime':'NR 运行库', core:'增强核心', bridge:'图形桥', feeder:'输入桥', mfg:'多帧生成组件', host:'跨位数宿主' })[kind] || kind;
  const unwrap = result => { if (result?.ok === false) throw new Error(result.error?.message || '组件操作失败'); return result?.ok === true ? result.value : result; };
  async function refreshComponents() {
    const data = unwrap(await window.manager.listComponents());
    if (!startupUpdateCheck) {
      startupUpdateCheck = true;
      const checked = Date.parse(data.catalog.checkedAt || '');
      if (!Number.isFinite(checked) || Date.now() - checked > 24 * 60 * 60 * 1000 || checked > Date.now()) {
        void window.manager.checkComponentUpdates().then(unwrap).then(() => refreshComponents()).catch(() => {});
      }
    }
    if (data.warnings?.length) message.textContent = data.warnings.join('；');
    const host = $('componentLibraryRows'); host.replaceChildren();
    const visiblePackages = data.packages.filter(row => !row.internal);
    for (const item of visiblePackages) {
      const row = document.createElement('div'); row.className = 'component-package-row';
      const copy = document.createElement('div'); copy.className = 'component-package-copy';
      const title = document.createElement('strong'); title.textContent = kindLabel(item.kind);
      const meta = document.createElement('span'); meta.textContent = [item.version, item.variant].filter(Boolean).join(' · ');
      const note = document.createElement('small');
      note.textContent = item.requiresAdapter ? '上游原包已缓存，还需匹配的输入适配包' : item.validation === 'blocked' ? '暂不可应用' : item.validation === 'candidate' ? '待验证候选' : '已校验并缓存';
      copy.append(title, meta, note); row.append(copy);
      if (item.kind === 'nr-runtime') {
        const button = document.createElement('button'); button.className = 'button'; button.textContent = '用于后续安装'; button.disabled = item.validation === 'blocked';
        button.onclick = () => perform(async () => { sourceChanged(unwrap(await window.manager.activateComponentRuntime(item.id))); return '运行库来源已更新。请在游戏卡片中应用；现有游戏未修改。'; }); row.append(button);
      }
      if (item.kind === 'core') {
        const button = document.createElement('button'); button.className = 'button'; button.textContent = '作为安装候选'; button.disabled = item.validation === 'blocked';
        button.onclick = () => perform(async () => { sourceChanged(unwrap(await window.manager.activateComponentCore(item.id))); return 'Core 候选已加入安装来源，现有游戏未修改。'; }); row.append(button);
      }
      if (!row.querySelector('button')) { const badge = document.createElement('span'); badge.className = 'badge good'; badge.textContent = '已缓存'; row.append(badge); }
      host.append(row);
    }
    if (!visiblePackages.length) { const empty = document.createElement('div'); empty.className = 'component-empty'; empty.innerHTML = '<strong>还没有导入可用组件</strong><span>可从上方导入已下载的组件，或打开下方在线仓库。</span>'; host.append(empty); }
    const downloads = $('componentUpdateRows'); downloads.replaceChildren();
    const downloadable = data.catalog.packages.filter(p => p.downloadUrl && !data.packages.some(row => row.id === p.id));
    $('componentDownloadCount').textContent = downloadable.length ? `${downloadable.length} 个可用` : '已是最新';
    for (const item of downloadable) {
      const button = document.createElement('button'); button.className = 'button component-download-card';
      const copy = document.createElement('span'); copy.className = 'component-download-copy';
      const title = document.createElement('strong'); title.textContent = kindLabel(item.kind);
      const meta = document.createElement('small'); meta.textContent = [item.version, item.variant].filter(Boolean).join(' · ');
      const action = document.createElement('span'); action.className = 'component-download-action'; action.textContent = '下载到缓存';
      copy.append(title, meta); button.append(copy, action);
      button.onclick = () => perform(async () => { unwrap(await window.manager.downloadComponent(item.id)); return '组件已下载并校验，未修改游戏。'; }); downloads.append(button);
    }
    if (!downloadable.length) { const empty = document.createElement('p'); empty.className = 'component-download-empty'; empty.textContent = '当前没有需要下载的新组件。'; downloads.append(empty); }
    const selectedGame = $('componentGameSelect').value;
    const games = unwrap(await window.manager.listGames()); $('componentGameSelect').replaceChildren();
    for (const game of games.filter(g => (g.operationApi?.effectiveApi || g.chosen?.apiResolution?.api) === 'dx11')) {
      const option = document.createElement('option'); option.value = game.id; option.textContent = game.name; $('componentGameSelect').append(option);
    }
    if ([...$('componentGameSelect').options].some(o => o.value === selectedGame)) $('componentGameSelect').value = selectedGame;
    await refreshBridgeChoices();
    const providers = unwrap(await window.manager.inspectComponentProviders()), select = $('componentProviderSelect');
    const selectedPackage = select.value; select.replaceChildren();
    const none = document.createElement('option'); none.value = ''; none.textContent = '恢复随包推荐配套'; select.append(none);
    for (const provider of providers.packages) {
      const option = document.createElement('option'); option.value = provider.id; option.disabled = !provider.selectable;
      option.textContent = `${provider.version} · ${(provider.gameApis || []).join('/')} ${provider.selectedRouteKeys?.length ? '（已用于部分安装路线）' : ''}${provider.reason || '（待游戏验证）'}`; select.append(option);
    }
    select.value = providers.packages.some(row => row.id === selectedPackage) ? selectedPackage : providers.selectedId || '';
    const defaults = Object.entries(providers.selectedByRoute || {}).map(([key,id]) => {
      const [api,arch,backend] = key.split('|'), provider = providers.packages.find(row => row.id === id);
      return `${api.toUpperCase()}／${arch === 'x86' ? '32' : '64'}位${backend === 'hoyoshade' ? '／米哈游' : ''}：${provider?.version || '来源缺失'}`;
    });
    $('componentProviderStatus').textContent = providers.reason || `${defaults.length ? '后续安装配套：' + defaults.join('；') + '。' : ''}选择只影响该包支持的 API、位数和加载方式；已有游戏保留原版本。MFG 在游戏补帧设置中切换。`;
  }
  function sourceChanged(result) {
    if (result?.state) window.dispatchEvent(new CustomEvent('manager-components-changed', { detail: result.state }));
  }
  async function refreshBridgeChoices() {
    const game = $('componentGameSelect').value, select = $('componentBridgeSelect'); select.replaceChildren();
    $('applyBridgeComponentBtn').disabled = true;
    if (!game) { $('componentBridgeStatus').textContent = '请先在游戏库添加 DX11 游戏。'; return; }
    const choices = unwrap(await window.manager.componentChoices(game));
    for (const bridge of choices.bridges) {
      const option = document.createElement('option'); option.value = bridge.id;
      option.textContent = `${bridge.label}${bridge.installed ? '（当前）' : ''}${!bridge.compatible ? '（接口不匹配）' : !bridge.ready ? '（未导入）' : bridge.runtimeVerified ? '' : '（游戏待验）'}`;
      option.disabled = !bridge.compatible || !bridge.ready; select.append(option);
    }
    const current = choices.bridges.find(b => b.installed && b.compatible && b.ready) || choices.bridges.find(b => b.compatible && b.ready);
    if (current) select.value = current.id;
    $('applyBridgeComponentBtn').disabled = !current;
    $('componentBridgeStatus').textContent = '切换会按现有安装事务备份、校验和恢复。请先关闭游戏；同时只启用一个桥接器。';
  }
  async function perform(action) {
    const controls = [...document.querySelectorAll('#componentLibraryPanel button')].map(button => ({button, disabled:button.disabled})); controls.forEach(({button}) => button.disabled = true);
    message.textContent = '正在校验组件文件…';
    try { message.textContent = await action(); await refreshComponents(); }
    catch (error) { message.textContent = error.message; }
    finally { controls.forEach(({button,disabled}) => button.disabled = disabled); $('applyBridgeComponentBtn').disabled = !$('componentBridgeSelect').selectedOptions[0] || $('componentBridgeSelect').selectedOptions[0].disabled; }
  }
  const importSelected = directory => perform(async () => { const value = unwrap(await window.manager.pickComponent(directory)); return value ? '组件已导入缓存，未修改游戏。' : '已取消导入。'; });
  $('importComponentBtn').onclick = () => importSelected(false);
  $('importComponentDirBtn').onclick = () => importSelected(true);
  $('refreshComponentsBtn').onclick = () => perform(async () => '组件列表已刷新。');
  $('componentGameSelect').onchange = () => refreshBridgeChoices().catch(error => { message.textContent = error.message; });
  $('applyBridgeComponentBtn').onclick = () => perform(async () => {
    unwrap(await window.manager.applyBridgeComponent($('componentGameSelect').value, $('componentBridgeSelect').value));
    return '此游戏的桥接设置已应用；运行效果请进游戏核对。';
  });
  $('checkComponentUpdatesBtn').onclick = () => perform(async () => {
    const results = unwrap(await window.manager.checkComponentUpdates());
    return results.map(row => `${kindLabel(row.kind)}：${row.error || row.releases.map(r => r.version + (r.preview ? ' 预览' : '')).join('／')}`).join('；') + '。上游新版需通过配套检查后应用，检查更新不会改动游戏。';
  });
  $('componentRuntimeHelpBtn').onclick = () => window.manager.openExternal('runtimePacksUrl');
  $('selectComponentProviderBtn').onclick = () => perform(async () => {
    unwrap(await window.manager.selectComponentProvider($('componentProviderSelect').value || null));
    window.dispatchEvent(new CustomEvent('manager-components-changed'));
    return '已更新此包支持的 API／位数配套，其他路线与已有游戏保持当前选择。';
  });
  refreshComponents().catch(error => { message.textContent = error.message; });
})();
