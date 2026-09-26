(function (root, factory) {
  const catalog = factory();
  if (typeof module === 'object' && module.exports) module.exports = catalog;
  else root.ManagerCoreCatalog = catalog;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // The only place that names the current unified Core line. A new Core is one
  // new entry here plus `scripts/import-core-ota.cjs`. Digests identify bytes
  // only: OTA import, staging and installation recompute SHA-256 from the real
  // files and refuse any mismatch, so an entry never authorizes unknown files.
  const HASH = /^[a-f0-9]{64}$/;
  const CORES = Object.freeze([
    {
      id: '0.5-dline21-unified3', menuKey: 'unified3', label: '0.5D21 unified3', menuLabel: '0.5D21 unified3 · 历史回退',
      displayVersion: '0.5 D21 unified3', buildVersion: 'beta0.5-dline21-unified3',
      sourceCommit: '7a90660bc468ca86a02abe2e145638b51489d549', configContract: 'nr-uniform-v1', provider: false, faceCompanions: true,
      addon: { 'zh-CN': '01b4155dcca346f6b3485f210191baaaf4af6faa9dfb9b29302c8f7e36ae3c93' },
      chain: '1acf3cbe509a031be1763a8231cd81e6019aa3532368cd0b08a6c17bc94b70a2',
      carrier: 'eb604bc1149da67492660a6d9e6dc622ca8fbcd247f67f8592aabc7cee633900',
      ota: { 'zh-CN': '1b51ab5646a10bb3f17db04de52c26f62dc8a40435e24ea145af1bebfcd8be46' },
      blocker: '具体游戏和 NVIDIA 实机尚未验证；此 Core 未声明外部 Provider V1 接口。'
    },
    {
      id: '0.5-dline21-unified5', menuKey: 'unified5', label: '0.5 Unified5', menuLabel: '0.5 Unified5 · 五层统一设置',
      displayVersion: '0.5 Unified5', buildVersion: 'beta0.5-dline21-unified5',
      sourceCommit: '38f5fff6fb6b20ce5fb09b0cca5020fcc4d9171d', configContract: 'nr-uniform-colour-v2', provider: true, faceCompanions: true,
      addon: { 'zh-CN': '054c878c5fc152901c0a85672ca47ee3b08e04a2c1572d8f11f88317a198c580',
        en: 'cd88c92c64b76e9955552ea832227125517590f3ab598bf9c384e2ec34231bd9' },
      chain: '1acf3cbe509a031be1763a8231cd81e6019aa3532368cd0b08a6c17bc94b70a2',
      carrier: 'f4e9a5e0e573ee80b0f3d154138736d5fa912d92fbc987cb07599d165c4caaf1',
      ini: '041046365e601b0d88e580eac6f8e7257da3f87ee8fa04d1ae8b3d6401b8bc43',
      ota: { 'zh-CN': '55d044a6739ba89b8411f33fe0a336fc5de1477c216db3c6672ebaab572c4162' },
      blocker: 'Provider V1 已实现；与 Feeder 成品及实际游戏的配套验收未完成，不自动启用外部路线。'
    },
    {
      // Maintainer handoff 2026-09-25 (source tag v0.5.1-beta-ui1). Game-tested by
      // the maintainer; the digests are checked again against the delivered files.
      id: '0.5.1-beta-ui1', menuKey: '051', label: '0.5.1', menuLabel: '0.5.1 · 细节增强与去暗噪',
      displayVersion: '0.5.1-Beta-Reconstruction1-UI1', buildVersion: 'beta0.5-dline21-unified10-reconstruction1-ui1',
      sourceCommit: '31cddd0739ff39bf926eb5e2f444531c63968e63', configContract: 'nr-uniform-colour-v2', provider: true, faceCompanions: true,
      addon: { 'zh-CN': '213338900bfcbada149dc89e7fcea0b12f8843f0252a4cb81ce16e847d3b607d',
        en: '54f998be0c7d1c293fcb9a6b231f4ca917a826e6e9c40afa699903534cb97929' },
      chain: '1acf3cbe509a031be1763a8231cd81e6019aa3532368cd0b08a6c17bc94b70a2',
      carrier: null,
      ota: { 'zh-CN': '7b9dcb58260edc18e2dfd55111213cfb589d2bf958127bedde8e869cfc7f4e14',
        en: '6f37b47bd1d3be8d48094f0624362ba4fcce5824841ba5f52ddd62cd3dec505b' },
      blocker: '外部 Provider 路线（Bridge / Feeder 自动搭配）仍按游戏确认；原生 DX12 路线已由维护者实测。'
    }
  ].map(row => Object.freeze({ ...row, addon: Object.freeze({ ...row.addon }), ota: Object.freeze({ ...row.ota }) })));
  // New installations default to RECOMMENDED; STABLE stays one click away. Every
  // other Core is listed under “历史版本与回退”.
  const RECOMMENDED = '0.5.1-beta-ui1';
  const STABLE = '0.4.7beta';
  const MAIN_MENU = Object.freeze([RECOMMENDED, STABLE]);

  const byId = id => CORES.find(row => row.id === id) || null;
  const isProviderCoreId = id => byId(id)?.provider === true;
  // A catalog ID alone never grants the provider stack; the addon bytes must match.
  const isProviderCore = (id, hash) => isProviderCoreId(id) && Object.values(byId(id).addon).includes(hash);
  const coreForAddonHash = hash => CORES.find(row => Object.values(row.addon).includes(hash)) || null;
  const coreForArchive = hash => {
    for (const row of CORES) for (const [language, digest] of Object.entries(row.ota)) if (digest === hash) return { core: row, language };
    return null;
  };
  const sourceCommits = contract => CORES.filter(row => !contract || row.configContract === contract).map(row => row.sourceCommit);
  const faceCompanionIds = () => CORES.filter(row => row.faceCompanions).map(row => row.id);

  const valid = CORES.every(row => HASH.test(row.chain) && (row.carrier === null || HASH.test(row.carrier)) &&
      (row.ini === undefined || HASH.test(row.ini)) && /^[0-9a-f]{40}$/.test(row.sourceCommit) &&
      Object.values(row.addon).every(value => HASH.test(value)) && Object.values(row.ota).every(value => HASH.test(value))) &&
    new Set(CORES.map(row => row.id)).size === CORES.length && isProviderCoreId(RECOMMENDED);
  if (!valid) throw new Error('Core catalog is invalid.');

  return Object.freeze({ CORES, RECOMMENDED, STABLE, MAIN_MENU, byId, isProviderCoreId, isProviderCore,
    coreForAddonHash, coreForArchive, sourceCommits, faceCompanionIds });
});
