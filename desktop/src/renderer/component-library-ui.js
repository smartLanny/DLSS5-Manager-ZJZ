'use strict';
(function () {
  const $ = id => document.getElementById(id), message = $('componentLibraryMessage');
  let startupUpdateCheck = false;
  const KIND = Object.freeze({
    'nr-runtime': { label:'NR 显卡运行库', purpose:'按 RTX 系列为 AI Core 提供 NVIDIA NR 运行环境。' },
    core: { label:'AI 增强 Core', purpose:'负责 NR 画面增强；按游戏保存版本，不会被全局选择静默替换。' },
    bridge: { label:'DLSS5 Bridge', purpose:'在需要桥接的 DX11 / Vulkan 路线使用，并与 Core 输入接口配套。' },
    feeder: { label:'DLSS5 Feeder', purpose:'用于没有可用原生 DLSS 输入的游戏，不与 Bridge 同时安装。' },
    mfg: { label:'RTX40 多帧生成', purpose:'独立的补帧组件，不决定 AI Core、DLSS5 Bridge 或 DLSS5 Feeder 路线。' },
    host: { label:'DLSS5 Feeder 运行宿主', purpose:'为需要跨位数兼容的 Feeder 路线提供运行环境。' },
    'user-addon': { label:'用户 Add-on', purpose:'已导入组件库；只有在指定游戏中启用后才会加载。' },
    'custom-candidate': { label:'待确认的自定义文件', purpose:'已安全保存，但缺少身份或兼容契约，不会自动用于游戏。' }
  });
  const kindLabel = kind => KIND[kind]?.label || kind;
  const unwrap = result => { if (result?.ok === false) throw new Error(result.error?.message || '组件操作失败'); return result?.ok === true ? result.value : result; };
  const add = (parent, tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; parent.append(node); return node; };
  function staticRouteGuide(host) {
    const rows = [
      ['DirectX 12 原生 DLSS', 'AI Core + 显卡运行库', '不需要 DLSS5 Bridge / Feeder'],
      ['DirectX 11', 'AI Core + DLSS5 Bridge + 显卡运行库', 'Bridge 按 Core 接口自动匹配'],
      ['无原生 DLSS / DX9 / DX10', 'DLSS5 Feeder + 专用 Core/运行库', '不会再叠加 DLSS5 Bridge'],
      ['Vulkan', 'AI Core + DLSS5 Bridge + 显卡运行库', '标记为实验桥接，应用前核对 Core 接口']
    ];
    const grid = add(host, 'div', 'component-route-static');
    for (const [title, value, note] of rows) {
      const card = add(grid, 'article', 'component-route-static-card'); add(card, 'strong', '', title); add(card, 'span', '', value); add(card, 'small', '', note);
    }
  }
  function renderComponentStack(stack, gameName) {
    const host = $('componentRouteSummary'); host.replaceChildren();
    if (!stack) { add(host, 'p', 'component-route-empty', '尚无可展示的自动搭配。'); staticRouteGuide(host); return; }
    const header = add(host, 'div', 'component-route-result-head');
    const copy = add(header, 'div', 'component-route-result-copy');
    add(copy, 'small', '', gameName || '当前游戏'); add(copy, 'strong', '', stack.title || '组件搭配待确认'); add(copy, 'span', '', stack.summary || '');
    const status = add(header, 'span', `badge ${stack.status === 'ready' ? 'good' : stack.status === 'missing' ? 'bad' : 'warn'}`,
      stack.status === 'ready' ? '配套已明确' : stack.status === 'missing' ? `缺少 ${stack.missingCount || 1} 项` : '需要确认');
    status.setAttribute('aria-label', `组件状态：${status.textContent}`);
    const grid = add(host, 'div', 'component-route-items');
    for (const item of stack.items || []) {
      const card = add(grid, 'article', `component-route-item is-${item.status || 'pending'}`);
      add(card, 'span', 'component-route-item-label', item.label); add(card, 'strong', '', item.value); add(card, 'small', '', item.detail || '');
    }
    add(host, 'p', 'component-route-reason', stack.reason || '');
    if (stack.manualBridge) add(host, 'p', 'component-route-advanced-hint', '只有需要回退或排查兼容时，才到“高级设置”手动切换 DLSS5 Bridge。');
  }
  async function refreshComponentRoute() {
    const select = $('componentRouteGameSelect'), id = select.value;
    if (!id) { renderComponentStack(null); return; }
    const option = select.selectedOptions[0];
    $('componentRouteSummary').innerHTML = '<p class="component-route-empty"><span class="button-spinner" aria-hidden="true"></span> 正在匹配 API、Core 与桥接组件…</p>';
    try { const choices = unwrap(await window.manager.componentChoices(id)); renderComponentStack(choices.stack, option?.textContent || '当前游戏'); }
    catch (error) { const host = $('componentRouteSummary'); host.replaceChildren(); add(host, 'p', 'component-route-empty error', error.message); staticRouteGuide(host); }
  }
  function renderRuntimeGuide(setup = {}) {
    const guide = $('componentRuntimeGuide'), required = setup.runtimeDlcRequired === true;
    guide.classList.toggle('hidden', !required);
    if (!required) return;
    const family = setup.hardwareFamily === 'RTX50' ? 'RTX 50 系' : setup.hardwareFamily === 'RTX40' ? 'RTX 40 系（兼容 RTX 20/30）' : '对应显卡系列';
    const pack = setup.hardwareFamily === 'RTX50' ? 'NR-Runtime-RTX50.zip' : setup.hardwareFamily === 'RTX40' ? 'NR-Runtime-RTX40.zip' : 'NR-Runtime-RTX40+RTX50.zip';
    $('componentRuntimeGuideTitle').textContent = `还差一份 ${family}运行库`;
    $('componentRuntimeGuideText').textContent = `管理器和 Core 已准备好。点击“导入运行库 DLC”，选择 ${pack}，完成后即可安装。`;
    $('componentRuntimeGuideBadge').textContent = setup.hardwareFamily || '待识别';
  }
  async function refreshComponents() {
    const data = unwrap(await window.manager.listComponents());
    if (!startupUpdateCheck) {
      startupUpdateCheck = true;
      const checked = Date.parse(data.catalog.checkedAt || '');
      if (!Number.isFinite(checked) || Date.now() - checked > 24 * 60 * 60 * 1000 || checked > Date.now()) {
        void window.manager.checkComponentUpdates().then(unwrap).then(() => refreshComponents()).catch(() => {});
      }
    }
    renderRuntimeGuide(data.runtimeSetup);
    message.textContent = data.warnings?.length ? data.warnings.join('；') : data.runtimeSetup?.runtimeDlcRequired
      ? '请选择对应显卡系列的运行库 DLC；导入后会自动启用，不会修改已有游戏。'
      : '组件导入与校验均在本机完成；已有游戏不会被自动修改。';
    const storage=data.storage || {};
    $('componentStorageLocation').textContent = storage.root
      ? `组件库位置：${storage.root}${storage.cDrive ? '（当前在 C 盘；可使用上方“移动仓库”迁往其他盘）' : '（组件大文件不占用 C 盘）'}` : '';
    const host = $('componentLibraryRows'); host.replaceChildren();
    const visiblePackages = data.packages.filter(row => !row.internal);
    for (const item of visiblePackages) {
      const row = document.createElement('div'); row.className = 'component-package-row';
      const copy = document.createElement('div'); copy.className = 'component-package-copy';
      const title = document.createElement('strong'); title.textContent = kindLabel(item.kind);
      const meta = document.createElement('span'); meta.textContent = [item.version, item.variant].filter(Boolean).join(' · ');
      const note = document.createElement('small');
      note.textContent = item.kind === 'custom-candidate' ? `${KIND['custom-candidate'].purpose} 自定义候选、尚未验证。` : item.kind === 'user-addon' ? KIND['user-addon'].purpose : item.requiresAdapter
        ? '已下载上游原包，但还需要匹配的适配清单，暂不能直接装入游戏。'
        : item.validation === 'blocked' ? '校验未通过，暂不可应用。'
        : `${KIND[item.kind]?.purpose || '已完成本地校验。'}${item.validation === 'candidate' ? ' 应用前会按游戏再次核验。' : ''}`;
      copy.append(title, meta, note); row.append(copy);
      if (item.kind === 'nr-runtime') {
        const button = document.createElement('button'); button.className = 'button'; button.textContent = '用于后续安装'; button.disabled = item.validation === 'blocked';
        button.onclick = () => perform(async () => { sourceChanged(unwrap(await window.manager.activateComponentRuntime(item.id))); return '运行库来源已更新。请在游戏卡片中应用；现有游戏未修改。'; }); row.append(button);
      }
      if (item.kind === 'core') {
        const button = document.createElement('button'); button.className = 'button'; button.textContent = '作为安装候选'; button.disabled = item.validation === 'blocked';
        button.onclick = () => perform(async () => { sourceChanged(unwrap(await window.manager.activateComponentCore(item.id))); return 'Core 候选已加入安装来源，现有游戏未修改。'; }); row.append(button);
      }
      if (!row.querySelector('button')) { const badge = document.createElement('span'); badge.className = `badge ${item.kind === 'custom-candidate' ? 'warn' : item.validation === 'blocked' ? 'bad' : item.requiresAdapter ? 'warn' : 'good'}`; badge.textContent = item.kind === 'custom-candidate' ? '尚未验证' : item.validation === 'blocked' ? '不可用' : item.requiresAdapter ? '待适配' : item.kind === 'user-addon' ? '已导入' : '已准备'; row.append(badge); }
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
      const action = document.createElement('span'); action.className = 'component-download-action'; action.textContent = '下载并准备';
      copy.append(title, meta); button.append(copy, action);
      button.onclick = () => perform(async () => { unwrap(await window.manager.downloadComponent(item.id)); return '组件已下载到组件库并通过校验，未修改游戏。'; }); downloads.append(button);
    }
    if (!downloadable.length) { const empty = document.createElement('p'); empty.className = 'component-download-empty'; empty.textContent = '当前没有需要下载的新组件。'; downloads.append(empty); }
    const selectedRouteGame = $('componentRouteGameSelect').value, selectedGame = $('componentGameSelect').value;
    const games = unwrap(await window.manager.listGames());
    $('componentRouteGameSelect').replaceChildren();
    for (const game of games.filter(row => row.chosen?.path)) { const option = document.createElement('option'); option.value = game.id; option.textContent = game.name; $('componentRouteGameSelect').append(option); }
    if ([...$('componentRouteGameSelect').options].some(option => option.value === selectedRouteGame)) $('componentRouteGameSelect').value = selectedRouteGame;
    if (!$('componentRouteGameSelect').options.length) { const option = document.createElement('option'); option.textContent = '先在游戏库添加游戏'; option.disabled = true; $('componentRouteGameSelect').append(option); }
    await refreshComponentRoute();
    $('componentGameSelect').replaceChildren();
    for (const game of games.filter(g => ['dx11','vulkan'].includes(g.operationApi?.effectiveApi || g.chosen?.apiResolution?.api))) {
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
    $('componentProviderStatus').textContent = providers.reason || `${defaults.length ? 'DLSS5 Feeder 自动配套：' + defaults.join('；') + '。' : ''}只影响需要 Feeder 的新安装路线；原生 DX12、DLSS5 Bridge、已有游戏和 MFG 均保持不变。`;
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
    $('componentBridgeStatus').textContent = '正常情况由管理器自动选择。手动切换只作用于所选 DX11 / Vulkan 游戏，并按当前 Core 输入接口校验；同时只启用一份 DLSS5 Bridge。';
  }
  async function perform(action) {
    const controls = [...document.querySelectorAll('#componentLibraryPanel button')].map(button => ({button, disabled:button.disabled})); controls.forEach(({button}) => button.disabled = true);
    message.textContent = '正在校验组件文件…';
    try { message.textContent = await action(); await refreshComponents(); }
    catch (error) { message.textContent = error.message; }
    finally { controls.forEach(({button,disabled}) => button.disabled = disabled); $('applyBridgeComponentBtn').disabled = !$('componentBridgeSelect').selectedOptions[0] || $('componentBridgeSelect').selectedOptions[0].disabled; }
  }
  const importSelected = directory => perform(async () => { const value = unwrap(await window.manager.pickComponent(directory));
    if (!value) return '已取消导入。';
    return value.packages?.some(row => row.kind === 'custom-candidate')
      ? '文件已保存为“自定义候选、尚未验证”；缺少用途和兼容契约，不会用于游戏。'
      : '组件已导入组件库并完成校验，未修改游戏。'; });
  $('importRuntimeDlcBtn').onclick = () => perform(async () => {
    const value = unwrap(await window.manager.pickRuntimeDlc());
    if (!value) return '已取消导入。';
    sourceChanged(value);
    return value.message || (value.activated ? '运行库已导入并用于后续安装。' : '运行库已导入组件仓库。');
  });
  $('importComponentBtn').onclick = () => importSelected(false);
  $('importComponentDirBtn').onclick = () => importSelected(true);
  $('moveComponentStorageBtn').onclick = () => perform(async () => {
    const value=unwrap(await window.manager.moveComponentLibrary());
    return value ? value.message : '已取消移动。';
  });
  $('refreshComponentsBtn').onclick = () => perform(async () => '组件列表已刷新。');
  $('componentRouteGameSelect').onchange = () => refreshComponentRoute().catch(error => { message.textContent = error.message; });
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
  window.addEventListener('manager-components-changed', () => refreshComponents().catch(error => { message.textContent = error.message; }));
  refreshComponents().catch(error => { message.textContent = error.message; });
})();
