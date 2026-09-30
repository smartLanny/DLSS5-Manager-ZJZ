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
      // Reads ReconstructionMode and NearBlackChromaGuard (both off by default).
      reconstruction: true,
      addon: { 'zh-CN': '213338900bfcbada149dc89e7fcea0b12f8843f0252a4cb81ce16e847d3b607d',
        en: '54f998be0c7d1c293fcb9a6b231f4ca917a826e6e9c40afa699903534cb97929' },
      chain: '1acf3cbe509a031be1763a8231cd81e6019aa3532368cd0b08a6c17bc94b70a2',
      carrier: null,
      ota: { 'zh-CN': '7b9dcb58260edc18e2dfd55111213cfb589d2bf958127bedde8e869cfc7f4e14',
        en: '6f37b47bd1d3be8d48094f0624362ba4fcce5824841ba5f52ddd62cd3dec505b' },
      blocker: '外部 Provider 路线（Bridge / Feeder 自动搭配）仍按游戏确认；原生 DX12 路线已由维护者实测。'
    },
    {
      // Maintainer handoff 2026-09-29 (product source cd8ba700, tag v0.5.2-beta.13).
      // One Core ships in two packages that differ only in the paired DLSS5 model
      // (RTX 40/50, RTX 20/30).
      // Maintainer game check of the default routes passed on 2026-09-29. Package
      // digests were recomputed from the downloaded files on 2026-09-30.
      id: '0.5.2-beta13', menuKey: '052', label: '0.5.2 Beta 13', menuLabel: '0.5.2 Beta 13 · 支持 RTX 20/30',
      displayVersion: '0.5.2-beta.13', buildVersion: '0.5.2-beta.13',
      sourceCommit: 'cd8ba7009d333f7b03c463dc4237a913f9913081', configContract: 'nr-uniform-colour-v2', provider: true, faceCompanions: true,
      reconstruction: true,
      addon: { 'zh-CN': '46dc1cd9e4a9a5542230219ec2dfcd8bc39889e94b8e922c636792d745b40d64',
        en: '6264bc14269431478053ef55e153e87344b836b1dff6d6f18db904c97e584032' },
      chain: '1acf3cbe509a031be1763a8231cd81e6019aa3532368cd0b08a6c17bc94b70a2',
      carrier: null,
      ota: {},
      // Handoff packages: install/ holds the Chinese Core, nrchain, one DLSS5 model and nr_face.
      packages: {
        'RTX40-50': { sha256: 'fed1aa879c498955cf5b044aa1e2475da679003444c3737921de596fd6c56c2e', bytes: 128847877,
          runtime: 'a2d16f9fba2b619559427821169918df56fc8e410a6ac87569953598a00b66fa', series: ['RTX40', 'RTX50'] },
        'RTX20-30': { sha256: 'e2994429b4433fc484a4aa59cc34dc4f7b3eb715ca29e9b341abdaab5bade29f', bytes: 153481194,
          runtime: '6dac1b40f0c87af84a8177b18c741e84fb0c914f204c9d87d95916b665ba3af8', series: ['RTX20', 'RTX30'] }
      },
      blocker: '维护者已在两款游戏中验收默认设置；RTX 20/30 版还没有在 20/30 系显卡上实测。'
    }
  ].map(row => Object.freeze({ ...row, addon: Object.freeze({ ...row.addon }), ota: Object.freeze({ ...row.ota }),
    packages: Object.freeze(Object.fromEntries(Object.entries(row.packages || {}).map(([key, value]) =>
      [key, Object.freeze({ ...value, series: Object.freeze([...value.series]) })]))) })));
  // New installations default to RECOMMENDED; STABLE stays one click away. Every
  // other Core is listed under “历史版本与回退”.
  const RECOMMENDED = '0.5.2-beta13';
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
  // A Core with packages only runs with the DLSS5 model paired for the GPU series.
  // Older Cores (no packages) keep the shared runtime; unknown series get null.
  const pairedRuntime = (id, series) => {
    const row = byId(id); if (!row) return null;
    for (const [variant, item] of Object.entries(row.packages)) if (item.series.includes(series)) return { variant, sha256: item.runtime, series: item.series };
    return null;
  };
  const requiresPairedRuntime = id => Object.keys(byId(id)?.packages || {}).length > 0;
  const isPairedRuntime = hash => CORES.some(row => Object.values(row.packages).some(item => item.runtime === hash));
  // A handoff package (install/ layout) of a cataloged Core, by archive digest.
  const coreForPackage = hash => {
    for (const row of CORES) for (const [variant, item] of Object.entries(row.packages)) if (item.sha256 === hash) return { core: row, variant, ...item };
    return null;
  };
  const sourceCommits = contract => CORES.filter(row => !contract || row.configContract === contract).map(row => row.sourceCommit);
  const faceCompanionIds = () => CORES.filter(row => row.faceCompanions).map(row => row.id);

  const valid = CORES.every(row => HASH.test(row.chain) && (row.carrier === null || HASH.test(row.carrier)) &&
      (row.ini === undefined || HASH.test(row.ini)) && /^[0-9a-f]{40}$/.test(row.sourceCommit) &&
      Object.values(row.addon).every(value => HASH.test(value)) && Object.values(row.ota).every(value => HASH.test(value)) &&
      Object.values(row.packages).every(item => HASH.test(item.sha256) && HASH.test(item.runtime) && Number.isSafeInteger(item.bytes) && item.series.length > 0)) &&
    new Set(CORES.map(row => row.id)).size === CORES.length && isProviderCoreId(RECOMMENDED);
  if (!valid) throw new Error('Core catalog is invalid.');

  return Object.freeze({ CORES, RECOMMENDED, STABLE, MAIN_MENU, byId, isProviderCoreId, isProviderCore,
    coreForAddonHash, coreForArchive, coreForPackage, pairedRuntime, requiresPairedRuntime, isPairedRuntime, sourceCommits, faceCompanionIds });
});
