'use strict';
// Explicit mount fixture based on 048's public controller/DOM contract, not a copy of the full Manager UI.
(function () {
  let model = { id: 'sample', busy: false, launching: false, draft: {},
    data: { game: { name: '示例游戏 · 隔离测试', installed: true, addonVersion: '0.4.7beta' },
      layout: { inputRoute: 'native', version: '0.4.7beta' }, verification: {} } };
  const originalMounts = [];
  function field(key, text, range = true) {
    return `<label class="gp-field"><span>${text}</span>${range ? `<div class="gp-range"><input type="range" value="1.2" min="0" max="2" step="0.05" data-gp-group="nr" data-gp-field="${key}"><output>1.2</output></div>` : `<select data-gp-group="nr" data-gp-field="${key}"><option value="0">默认</option><option value="1" selected>自然</option><option value="2">电影</option></select>`}</label>`;
  }
  window.GamePageUi = { marker: 'original-unchanged', mount(host) {
    originalMounts.push(host);
    function render() {
      const expanded = host.querySelector('details[data-gp-detail="nr"]')?.open;
      host.innerHTML = `<div class="gp-apply-bar"><strong>设置已就绪</strong><button class="button primary">启动游戏</button></div>
        <nav class="fixture-tabs">安装与画面　　超分与补帧　　高级与维护</nav>
        <section class="gp-section"><div class="gp-controls"><label class="gp-field"><span>图形 API</span><select data-gp-group="route" data-gp-field="api"><option>DirectX 12（自动）</option></select></label><label class="gp-field"><span>Core 配套</span><select data-gp-group="route" data-gp-field="version"><option>0.4.7beta</option></select></label></div></section>
        <section class="gp-section"><h3>NR 画面增强</h3><div class="gp-controls gp-nr-primary">${field('Intensity','模型强度')}${field('LocalToneStrength','局部明暗对比')}${field('LocalStructureStrength','整体细节强度')}</div>
        <p>☑ 人脸调节　　人脸细节强度沿用当前值</p>
        <details class="gp-nr-details" data-gp-detail="nr" ${expanded ? 'open' : ''}><summary>更多 NR 参数</summary><div class="gp-controls">${field('Style','画面风格',false)}${field('CustomWorkScale','自定义工作比例')}</div></details></section>`;
    }
    const listener = e => { if (e.target.dataset.gpField) model.draft[e.target.dataset.gpField] = e.target.value; };
    host.addEventListener('change', listener);
    return { open: async id => { model.id = id; render(); }, refresh: async () => render(), resume: () => render(), selectTab: () => render(),
      getState: () => structuredClone(model), setBusy: value => { model.busy = value; render(); },
      setData: patch => { Object.assign(model.data, patch); render(); }, hasDraft: () => Object.keys(model.draft).length > 0,
      originalAction: () => 'preserved', dispose: () => { host.removeEventListener('change', listener); host.textContent = ''; } };
  } };
  window.originalMounts = originalMounts;
  const invoke = async (method, data) => window.reportingHost(method, data);
  window.fixtureManager = {
    openCompatibilityFeedback: id => invoke('open', id),
    previewCompatibilityFeedback: (token, request) => invoke('preview', { token, request }),
    saveCompatibilityFeedback: (token, request) => invoke('save', { token, request }),
    discardCompatibilityFeedback: (token, id) => invoke('discard', { token, id }),
    closeCompatibilityFeedback: token => invoke('close', token)
  };
})();
