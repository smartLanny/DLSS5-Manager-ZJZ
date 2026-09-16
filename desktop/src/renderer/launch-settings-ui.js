'use strict';

// A renderer-only editor. All reads and mutations go through the launch service.
(function (scope) {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const QUALITY = { game: '交还游戏控制', preserve: '保持当前档位（仅选模型）', dlaa: 'DLAA · 原生分辨率', quality: '质量', balanced: '平衡', performance: '性能', ultraPerformance: '超级性能', custom: '自定义输入比例' };
  const PRESET_PERCENT = { dlaa: 100, quality: 67, balanced: 59, performance: 50, ultraPerformance: 33 };
  const MODES = { restore: '使用原有设置', follow: '跟随游戏倍率', off: '关闭帧生成（驱动）', fixed: '固定倍率', dynamic: '动态目标帧率' };
  const BACKENDS = { native: '原生 DLSS', optiscaler: 'OptiScaler', nvidia: 'NVIDIA 官方 FG', rtx40: '旧版 RTX40 补帧', mfgunlock: 'RTX40 · MFG Unlock' };
  const SR_MODEL_LABELS = Object.freeze({ K: 'K · 老版兼容', M: 'M · 均衡推荐', L: 'L · 画质优化（帧率最低）' });
  const SR_MODEL_DESCRIPTIONS = Object.freeze({ K: '第一代 Transformer，RTX20 / RTX30 本机推荐。',
    M: 'RTX40 / RTX50 的均衡推荐，兼顾画质与帧率。', L: '更偏向画质，通常也是三个模型中帧率最低的选择。' });
  const option = (value, label, selected, disabled = false) => `<option value="${esc(value)}"${String(selected) === String(value) ? ' selected' : ''}${disabled ? ' disabled' : ''}>${esc(label)}</option>`;

  function unwrap(result) {
    if (!result || result.ok !== true) throw Object.assign(new Error(result?.error?.message || '设置操作失败。'), result?.error || {});
    return result.value;
  }

  function hardwareFacts(hardware = {}) {
    const names = Array.isArray(hardware.names) ? hardware.names : [];
    const named = names.map(name => String(name).match(/RTX\s*(20|30|40|50)\d{2}(?:\D|$)/i)?.[1]).filter(Boolean).map(s => `RTX${s}`);
    const series = [...new Set([...(Array.isArray(hardware.series) ? hardware.series : []), ...named].filter(s => /^RTX(?:20|30|40|50)$/.test(s)))];
    // The installation family RTX40 also includes RTX20/30; it is not FG evidence.
    const known = hardware.source !== 'unavailable' && series.length === 1 && hardware.family !== 'mixed';
    const relevantNames = names.filter(name => /RTX\s*(20|30|40|50)\d{2}(?:\D|$)/i.test(name));
    return { label: relevantNames.length ? relevantNames.join(' / ').replace(/NVIDIA (?:GeForce )?/g, '') : known ? series[0].replace('RTX', 'RTX ') : '显卡未确认', allNames: names.join(' / '),
      series: known ? series[0] : null, fgBackend: known && series[0] === 'RTX40' ? 'mfgunlock' : known && series[0] === 'RTX50' ? 'nvidia' : null };
  }

  function recommendedPreset(hardware) {
    const series = hardwareFacts(hardware).series;
    return series === 'RTX20' || series === 'RTX30' ? 'K' : series === 'RTX40' || series === 'RTX50' ? 'M' : null;
  }

  // New editor defaults are explicit requests, so older managers can still read
  // them. Saved `auto` keeps its existing quality-based NVIDIA policy.
  function initialSrFields(settings = {}, hardware = settings.hardware || {}) {
    const request = settings.requests?.sr?.request || settings.applied?.sr?.request;
    if (request) return { backend: 'native', quality: 'preserve', renderPercent: PRESET_PERCENT[request.quality] || 67,
      ...request, preset: request.preset ?? '' };
    const keepGame = { backend: 'native', quality: 'game', preset: '', renderPercent: 67 };
    const recommendation = recommendedPreset(hardware);
    const legacy = settings.legacy;
    if (legacy?.configured === true && legacy.managed !== true && !legacy.error) {
      const selection = String(legacy.selection || '').toUpperCase();
      const preset = selection === 'AUTO' ? recommendation : ['K', 'L', 'M'].includes(selection) ? selection : null;
      return preset ? { ...keepGame, quality: 'preserve', preset } : keepGame;
    }
    return recommendation ? { ...keepGame, quality: 'preserve', preset: recommendation } : keepGame;
  }

  function createRequest(domain, fields) {
    const backend = fields.backend;
    if (domain === 'sr') {
      if (!['native', 'optiscaler'].includes(backend)) throw new Error('请选择 SR 后端。');
      const quality = fields.quality;
      if (!Object.hasOwn(QUALITY, quality) || backend === 'optiscaler' && quality === 'preserve') throw new Error('请选择有效 SR 档位。');
      const request = { backend, quality };
      if (quality === 'game') return request;
      if (quality === 'custom') {
        const percent = Number(fields.renderPercent);
        if (fields.renderPercent === '' || !Number.isFinite(percent) || percent > 100 || percent < (backend === 'native' ? 33 : 100 / 3) || backend === 'native' && !Number.isInteger(percent))
          throw new Error(backend === 'native' ? '原生 DLSS 输入比例需为 33–100 的整数。' : 'OptiScaler 输入比例需为 33.334–100%。');
        request.renderPercent = percent;
      }
      if (backend === 'native' && fields.preset) {
        if (!['auto', 'K', 'L', 'M'].includes(fields.preset)) throw new Error('请选择自动推荐、K、L 或 M 模型。');
        request.preset = fields.preset;
      }
      if (quality === 'preserve' && !request.preset) throw new Error('仅改模型时，请选择自动推荐、K、L 或 M。');
      return request;
    }
    if (domain !== 'fg' || !['nvidia', 'rtx40', 'mfgunlock'].includes(backend)) throw new Error('当前显卡尚未确认可用的 FG 设置后端。');
    const mode = fields.mode;
    if (!(backend === 'nvidia' ? ['restore', 'off', 'fixed', 'dynamic'] : backend === 'mfgunlock' ? ['restore', 'follow', 'fixed', 'dynamic'] : ['restore', 'follow', 'fixed', 'dynamic']).includes(mode)) throw new Error('请选择有效 FG 模式。');
    const request = { backend, mode };
    if (mode === 'fixed') {
      const multiplier = Number(fields.multiplier);
      if (!Number.isInteger(multiplier) || multiplier < 2 || multiplier > 6) throw new Error('固定总倍率需为 2–6。');
      request.multiplier = multiplier;
    }
    if (mode === 'dynamic') {
      const targetFps = Number(fields.targetFps);
      if (fields.targetFps === '' || !Number.isInteger(targetFps) || targetFps < 0 || targetFps > 1000) throw new Error('动态目标需为 0（自动）或 1–1000 FPS 的整数。');
      request.targetFps = targetFps;
      if (backend === 'rtx40') request.experimental56 = fields.experimental56 === true;
    }
    if (backend === 'mfgunlock' && mode !== 'restore') {
      const enumField = (key, values, label) => {
        const value = fields[key];
        if (value === undefined || value === null || value === '') return;
        if (!values.includes(value)) throw new Error(`${label}无效。`);
        request[key] = value;
      };
      const integerField = (key, min, max, label) => {
        const value = fields[key];
        if (value === undefined || value === null || value === '') return;
        const number = Number(value);
        if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label}需为 ${min}–${max} 的整数。`);
        request[key] = number;
      };
      const booleanField = (key, label) => {
        const value = fields[key];
        if (value === undefined || value === null || value === '') return;
        if (typeof value === 'boolean') request[key] = value;
        else if (value === 'on' || value === 'off') request[key] = value === 'on';
        else throw new Error(`${label}需选择开启、关闭或保持插件设置。`);
      };
      enumField('runtimeMode', ['game', 'local', 'ota'], '运行库策略');
      enumField('hdrMode', ['native', 'ui-composition', 'automatic', 'final-color'], 'HDR 兼容模式');
      integerField('depthEdgeGuard', 0, 4, '边缘保护等级');
      integerField('maxCount', 2, 5, '运行库报告上限');
      for (const [key, label] of [
        ['freezeFallback', '卡死救援'], ['reflexSourceCap', 'Reflex 源帧限制'], ['temporalFix', '时序修复'],
        ['blackwellFrameworkKernels', 'Blackwell 框架内核'], ['thinGeometryIntermediateScatter', '细线中间帧分散'],
        ['thinGeometryValidatedWarpBlend', '细线校验混合'], ['thinGeometryPreviousScatter', '细线上一帧分散'], ['raiseFrameCeiling', '提高帧上限']
      ]) booleanField(key, label);
    }
    return request;
  }

  function requestLabel(domain, request) {
    if (!request) return '未保存覆盖请求';
    const parts = [BACKENDS[request.backend] || request.backend];
    if (domain === 'sr') {
      parts.push(QUALITY[request.quality] || request.quality);
      if (request.quality === 'custom') parts.push(`输入 ${request.renderPercent}%`);
      if (request.preset) parts.push(request.preset === 'auto' ? '模型自动推荐' : `模型 ${request.preset}`);
    } else {
      parts.push(MODES[request.mode] || request.mode);
      if (request.mode === 'fixed') parts.push(`总计 ${request.multiplier}×`);
      if (request.mode === 'dynamic') parts.push(request.targetFps === 0 ? '自动目标' : `${request.targetFps} FPS`);
      if (request.experimental56) parts.push('允许实验性 5/6×');
    }
    return parts.join(' · ');
  }

  function initialFields(domain, data) {
    const request = data.requests?.[domain]?.request || data.applied?.[domain]?.request;
    const legacy = legacyState(data);
    if (domain === 'sr') {
      // A proposed next-launch value is not a measurement of the game's current setting.
      const fields = { backend: 'native', quality: 'quality', preset: legacy?.preset || (recommendedPreset(data.hardware) ? 'auto' : ''), renderPercent: 67, ...request };
      fields.backend = 'native';
      if (fields.preset === 'auto' && !recommendedPreset(data.hardware)) fields.preset = '';
      if (!Object.hasOwn(PRESET_PERCENT, fields.quality) && fields.quality !== 'custom') fields.quality = 'quality';
      if (Object.hasOwn(PRESET_PERCENT, fields.quality)) fields.renderPercent = PRESET_PERCENT[fields.quality];
      return fields;
    }
    const backend = hardwareFacts(data.hardware).fgBackend || '';
    return { backend, mode: 'restore', multiplier: 2, targetFps: 0, experimental56: false,
      runtimeMode: '', hdrMode: '', depthEdgeGuard: '', freezeFallback: '', reflexSourceCap: '', maxCount: '',
      temporalFix: '', blackwellFrameworkKernels: '', thinGeometryIntermediateScatter: '',
      thinGeometryValidatedWarpBlend: '', thinGeometryPreviousScatter: '', raiseFrameCeiling: '', ...request };
  }

  function legacyState(data) {
    const legacy = data.legacy;
    if (!legacy || legacy.configured === false || legacy.managed === true || legacy.error || data.requests?.sr || data.applied?.sr) return null;
    const effective = String(legacy.effective || '').toUpperCase();
    const effectivePreset = ['K', 'L', 'M'].includes(effective) ? effective : null;
    const preset = legacy.selection === 'auto' ? 'auto' : effectivePreset;
    const label = effectivePreset ? `${legacy.selection === 'auto' ? '自动 → ' : ''}模型 ${effectivePreset}` : 'NVIDIA 默认 / 不覆盖';
    return { preset, label };
  }

  function statusMarkup(domain, data, dirty) {
    const saved = data.requests?.[domain]?.request;
    const applied = data.applied?.[domain];
    const readback = applied?.readbackVerified === true || applied?.configVerified === true;
    const legacy = domain === 'sr' ? legacyState(data) : null;
    const legacyError = domain === 'sr' && !saved && data.legacy?.error;
    const appliedLabel = applied?.request ? requestLabel(domain, applied.request) : null;
    return `<div class="launch-status" aria-live="polite"><span class="badge ${dirty ? 'warn' : applied ? 'good' : ''}">${dirty ? '等待应用' : applied ? '✓ 已应用配置' : legacy ? '沿用原模型设置' : legacyError ? '状态未确认' : '使用原有设置'}</span>${readback ? '<span class="badge good">✓ 配置已校验</span>' : ''}</div><p class="launch-saved">${esc(appliedLabel || (legacy ? `沿用原模型设置：${legacy.label}` : saved ? `已有保存设置：${requestLabel(domain, saved)}` : '更改选项后自动准备并应用，无需单独准备'))}</p>`;
  }

  function srFields(fields, hardware) {
    const recommended = recommendedPreset(hardware);
    const automatic = recommended ? option('auto', `自动推荐 · ${recommended}（推荐）`, fields.preset) : '';
    return `<label class="launch-field"><span>画质档位</span><select data-ls-field="quality" aria-label="SR 画质档位">${Object.entries(QUALITY).filter(([key]) => key !== 'game' && key !== 'preserve').map(([key, label]) => option(key, label, fields.quality)).join('')}</select></label>
      <label class="launch-field"><span>输入比例</span><div class="launch-number"><input data-ls-field="renderPercent" type="number" min="33" max="100" step="1" value="${esc(fields.renderPercent)}" aria-label="SR 输入分辨率百分比"><span>%</span></div><small>档位为近似宽高比例；改数值即自定义。</small></label>
      <label class="launch-field"><span>DLSS SR 模型</span><select data-ls-field="preset" aria-label="DLSS SR 模型">${option('', '保持游戏原设置', fields.preset)}${automatic}${option('K', '模型 K · 老版兼容', fields.preset)}${option('L', '模型 L · 画质优化（帧率最低）', fields.preset)}${option('M', '模型 M · 均衡推荐（RTX40 / RTX50）', fields.preset)}</select></label>
      <p class="config-note">用于已有原生 DLSS；不代表游戏当前档位。</p>`;
  }

  function hasLegacyOptiScaler(data) {
    return [data.requests?.sr, data.applied?.sr].some(entry => entry?.request?.backend === 'optiscaler');
  }

  function mfgAdvancedFields(fields) {
    const tri = (key, label, note = '') => { const selected = fields[key] === true ? 'on' : fields[key] === false ? 'off' : fields[key]; return `<label class="launch-field"><span>${label}</span><select data-ls-field="${key}">${option('', '保持插件当前设置', selected)}${option('on', '开启', selected)}${option('off', '关闭', selected)}</select>${note ? `<small>${note}</small>` : ''}</label>`; };
    return `<details class="launch-advanced"><summary>高级兼容设置 · 遇到问题时再调整</summary><div class="launch-grid">
      <label class="launch-field"><span>运行库策略</span><select data-ls-field="runtimeMode">${option('', '保持插件当前设置', fields.runtimeMode)}${option('game', '使用游戏自带（推荐）', fields.runtimeMode)}${option('local', '优先游戏目录本地库', fields.runtimeMode)}${option('ota', '使用 NVIDIA OTA 运行库', fields.runtimeMode)}</select></label>
      <label class="launch-field"><span>HDR 兼容</span><select data-ls-field="hdrMode">${option('', '保持插件当前设置', fields.hdrMode)}${option('native', '原生路径', fields.hdrMode)}${option('ui-composition', 'UI 合成', fields.hdrMode)}${option('automatic', '自动选择', fields.hdrMode)}${option('final-color', '最终颜色', fields.hdrMode)}</select></label>
      <label class="launch-field"><span>边缘保护</span><select data-ls-field="depthEdgeGuard">${option('', '保持插件当前设置', fields.depthEdgeGuard)}${[0, 1, 2, 3, 4].map(value => option(String(value), `${value}${value === 0 ? ' · 关闭' : ''}`, fields.depthEdgeGuard)).join('')}</select></label>
      <label class="launch-field"><span>运行库报告倍率上限</span><select data-ls-field="maxCount">${option('', '保持插件当前设置', fields.maxCount)}${[2, 3, 4, 5].map(value => option(String(value), `${value}×`, fields.maxCount)).join('')}</select></label>
      ${tri('freezeFallback', '3×/4× 卡死救援', '卡死时尝试软件节奏；正常游戏保持插件设置。')}
      ${fields.mode === 'dynamic' ? tri('reflexSourceCap', 'Dynamic Reflex 源帧限制') : ''}
      ${tri('temporalFix', '时序修复')}${tri('blackwellFrameworkKernels', 'Blackwell 框架内核')}
      ${tri('thinGeometryIntermediateScatter', '细线中间帧保护')}${tri('thinGeometryValidatedWarpBlend', '细线校验混合')}
      ${tri('thinGeometryPreviousScatter', '细线上一帧保护', '实验项，可能影响旧游戏。')}${tri('raiseFrameCeiling', '提高帧上限', '仅在确认需要 5×/6× 时考虑。')}
    </div></details>`;
  }

  function fgFields(fields, hardware, capability = {}, components = {}) {
    const facts = hardwareFacts(hardware);
    const available = facts.fgBackend && fields.backend === facts.fgBackend;
    if (!available) return `<p class="launch-unavailable">${fields.backend === 'rtx40' ? '旧补帧设置已保留。请先迁移组件，再重新选择；动态目标不会自动转换。' : facts.series === 'RTX20' || facts.series === 'RTX30' ? 'RTX 20 / 30 尚无已确认的 FG 控制路线。' : !facts.fgBackend ? '未确认单一 RTX 40 / 50 显卡，暂不能设置 FG。' : '已保存后端与当前显卡不符，请先还原本工具设置。'}</p><p class="config-note">仅管理已有 FG；已保存请求和还原入口仍保留。</p>`;
    const community = fields.backend === 'mfgunlock';
    const modes = community ? ['restore', 'follow', 'fixed', ...(capability.availableModes?.includes('dynamic') || fields.mode === 'dynamic' ? ['dynamic'] : [])] : ['restore', 'off', 'fixed', 'dynamic'];
    return `<label class="launch-field"><span>控制模式</span><select data-ls-field="mode" aria-label="FG 控制模式">${modes.map(key => option(key, MODES[key], fields.mode)).join('')}</select></label>
      ${fields.mode === 'fixed' ? `<label class="launch-field"><span>总帧倍率</span><select data-ls-field="multiplier" aria-label="FG 总帧倍率">${[2, 3, 4, 5, 6].map(value => option(String(value), `${value}× · 1 帧渲染 + ${value - 1} 帧生成${community && value >= 5 ? '（实验）' : ''}`, String(fields.multiplier))).join('')}</select><small>包含渲染帧；实际可用倍率需游戏内确认。</small></label>${community ? `<details class="launch-advanced"><summary>实验倍率说明${Number(fields.multiplier) >= 5 ? ` · 当前 ${esc(fields.multiplier)}×` : ''}</summary><p class="config-note">5/6× 为兼容路线的实验选项；实际支持情况需游戏内验证。</p></details>` : ''}` : ''}
      ${fields.mode === 'dynamic' ? `<label class="launch-field"><span>动态目标</span><div class="launch-number"><input data-ls-field="targetFps" type="number" min="0" max="1000" step="1" value="${esc(fields.targetFps)}" aria-label="FG 动态目标帧率"><span>FPS</span></div><small>0 为自动，范围 1–1000 FPS。</small></label>` : ''}
      ${community && fields.mode !== 'restore' ? mfgAdvancedFields(fields) : ''}
      <p class="config-note">${fields.mode === 'restore' ? '恢复原有配置，不会关闭 FG。' : !community && fields.mode === 'off' ? '请求驱动关闭 FG；游戏菜单可能不变。' : community ? '请先在游戏内开启 FG。MFG 固定值是绝对倍率，可以提高或降低游戏请求；完全退出并重启游戏后核对。' : '使用原生 FG，请在游戏中开启。'} 游戏内开关暂无法读取。</p>${community ? `<p class="config-note">游戏内菜单：ReShade → Add-ons → MFG Unlock。当前组件：${esc(components.installedProviderDetails?.version || components.catalog?.find(row => row.id === components.defaultProvider)?.version || '1.0（推荐）')}；来源：mavismmg/MFGAdaUnlock-RenoDx。设置读回不等于实际生成帧已验证。</p><button class="button subtle" type="button" data-ls-action="mfg-source">查看 MFG Unlock 开源项目</button>` : ''}`;
  }

  function fgComponentMarkup(data, busy, recoveryBusy = busy, allowPrepare = true) {
    const info = data.fgComponents;
    const facts = hardwareFacts(data.hardware);
    if (!info) return '<div class="launch-components"><p>组件状态待确认，请重新读取。</p></div>';
    const native = info.route === 'native' || facts.fgBackend === 'nvidia';
    const blockers = Array.isArray(info.blockers) ? info.blockers : [];
    const missing = Array.isArray(info.missing) ? info.missing : [];
    const legacy = info.legacyNeedsMigration === true || [data.requests?.fg?.request, data.applied?.fg?.request].some(request => request?.backend === 'rtx40');
    const migrationPending = info.migrationPending === true || Boolean(info.migrationPending?.token);
    const fileRecoveryPending = info.fileRecoveryPending === true;
    return `<div class="launch-components"><strong>${native ? 'RTX 50 · 原生帧生成' : info.route === 'compatibility' ? 'RTX 40 · 兼容帧生成' : '帧生成路线待确认'}</strong><span class="badge${info.ready ? ' good' : ''}">${info.ready ? '✓ 配套已就绪' : '配套待确认'}</span>
      <p>${native ? info.needsCleanup ? '更改补帧选项时会恢复旧兼容组件，再使用原生路线。' : '使用游戏和驱动的原生帧生成，无需另装兼容库。' : info.route !== 'compatibility' ? '请先确认显卡与游戏的 FG 路线。' : info.ready ? '兼容组件已就绪。' : '更改补帧选项时会自动准备配套组件。'}</p><p class="config-note">需要游戏已有受支持的帧生成；不是向任意游戏注入补帧。游戏只有 2× 选项时可请求更高倍率，实际生效仍取决于游戏、驱动和组件。</p>
      ${blockers.length ? `<p class="launch-error">${blockers.map(esc).join('<br>')}</p>` : ''}
      ${missing.length ? `<details><summary>待准备的组件（${missing.length}）</summary><ul>${missing.map(item => `<li>${esc(typeof item === 'string' ? item : item.label || item.name || item.role)}</li>`).join('')}</ul></details>` : ''}
      ${!native && info.backend !== 'mfgunlock' && info.runtime && info.runtime.ready !== true ? `<div class="payload-source-actions">${info.runtime.repair !== 'game-files' ? `<button class="button primary" type="button" data-ls-action="runtime-help"${busy ? ' disabled' : ''}>下载 VC++ x64 运行库</button>` : ''}<button class="button" type="button" data-ls-action="runtime-check"${busy ? ' disabled' : ''}>重新检查运行库</button></div><p class="config-note">${info.runtime.repair === 'game-files' ? '请验证游戏文件后重查；不会覆盖游戏自带运行库。' : '微软官方下载；安装或修复完成后重新检查。'}</p>` : ''}
      ${fileRecoveryPending || migrationPending ? `<button class="button primary" type="button" data-ls-action="recover-components"${recoveryBusy ? ' disabled' : ''}>${fileRecoveryPending ? '恢复未完成组件操作' : '恢复未完成迁移'}</button>` : legacy && !native ? `<p class="config-note">迁移会先撤销旧补帧设置，再替换本工具管理的旧组件。新方案默认跟随游戏，不沿用旧动态目标。</p><button class="button primary" type="button" data-ls-action="migrate-components"${busy || !allowPrepare ? ' disabled' : ''}>迁移并准备 MFG Unlock</button>` : info.needsCleanup ? `<button class="button primary" type="button" data-ls-action="native-route"${busy ? ' disabled' : ''}>切换为原生帧生成</button>` : ''}
      ${!native && info.managed ? `<button class="button subtle" type="button" data-ls-action="remove-components"${busy ? ' disabled' : ''}>移除兼容组件</button>` : ''}
    </div>`;
  }

  function driverScopeMarkup(scope, busy = false) {
    if (!scope) return '';
    if (scope.error || scope.status === 'unknown') return `<div class="launch-driver-scope launch-driver-scope-unknown" role="status"><span>NVIDIA 设置范围暂时无法读取。</span><button class="button subtle" type="button" data-ls-action="reload"${busy ? ' disabled' : ''}>重新检查</button></div>`;
    const applications = Array.isArray(scope.applications) ? scope.applications.filter(item => typeof item === 'string' && item.trim()) : [];
    if (scope.shared !== true && applications.length <= 1) return '';
    const name = scope.name || 'NVIDIA 游戏配置';
    return `<details class="launch-driver-scope"><summary>NVIDIA 游戏配置：${esc(name)} · 关联 ${applications.length} 个启动入口；超分补帧设置会同步用于这些入口</summary>${applications.length ? `<ul>${applications.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}</details>`;
  }

  function mount(host, id, options = {}) {
    if (!host || host.launchSettingsController) return host?.launchSettingsController;
    const manager = options.manager || scope.manager;
    const capabilityMissing = options.nativeDlssAvailable === false;
    const fgCapabilityMissing = options.nativeFgAvailable === false;
    let data = null, busy = false, generation = 0;
    const drafts = {}, dirty = {}, messages = {}, timers = {};
    const queued = new Set();
    const attached = () => host.isConnected !== false;
    function setMessage(domain, text, error = false) { messages[domain] = { text, error }; }
    function render() {
      if (!attached() || !data) return;
      const scrollOwner = host.closest?.('.view');
      const scrollTop = scrollOwner?.scrollTop;
      const focused = scope.document?.activeElement;
      const focusField = host.contains?.(focused) ? focused?.dataset?.lsField : null;
      const focusDomain = focusField && focused.closest('[data-ls-domain]')?.dataset.lsDomain;
      const facts = hardwareFacts(data.hardware);
      const pending = Array.isArray(data.pending) && data.pending.length > 0;
      const owned = domain => Boolean(data.requests?.[domain]?.request || data.applied?.[domain] || (domain === 'sr'
        ? data.legacy?.configured || data.legacy?.baselineCaptured || data.legacy?.error
        : data.fgComponents?.managed || data.fgComponents?.legacyNeedsMigration || data.fgComponents?.migrationPending || data.fgComponents?.fileRecoveryPending));
      const hasOwned = owned('sr') || owned('fg');
      host.innerHTML = `<div class="launch-head"><div><h4>超分补帧</h4><p>${capabilityMissing && fgCapabilityMissing ? '此游戏未检测到原生 DLSS 超分或补帧；画面增强请在“画面设置”中查看。' : '更改选项后自动准备并应用，无需再点准备按钮；运行中的游戏需要重启。'}</p></div><span title="${esc(facts.allNames)}">${esc(facts.label)}</span>${hasOwned ? `<button class="button subtle" type="button" data-ls-action="restore-all" title="撤销管理器的 SR / FG 覆盖，恢复原有游戏及驱动设置"${busy || pending ? ' disabled' : ''}>恢复默认</button>` : ''}</div>${!capabilityMissing || !fgCapabilityMissing || hasOwned ? driverScopeMarkup(data.driverScope, busy || pending) : ''}${pending ? `<div class="launch-recovery" role="alert"><span>${esc(data.notice || '上次操作未完成，请先恢复。')}</span><button class="button" type="button" data-ls-action="recover">恢复未完成操作</button></div>` : data.notice ? `<p class="launch-message launch-error" role="alert">${esc(data.notice)}</p>` : ''}${data.legacy?.error ? `<p class="launch-message launch-error">旧 SR 记录读取失败：${esc(data.legacy.error.message)}。恢复记录已保留。</p>` : ''}
        <div class="launch-grid">${['sr', 'fg'].map(domain => {
          const fields = drafts[domain];
          const legacyOptiScaler = domain === 'sr' && hasLegacyOptiScaler(data);
          const available = domain === 'sr' ? !legacyOptiScaler : facts.fgBackend && fields.backend === facts.fgBackend;
          const message = messages[domain];
          const missingCapability = domain === 'sr' ? capabilityMissing : fgCapabilityMissing;
          if (missingCapability) return `<section class="launch-panel launch-panel-unavailable" data-ls-domain="${domain}" aria-label="${domain === 'sr' ? 'SR 超分辨率' : 'FG 帧生成'}"><div class="launch-panel-title"><h4>${domain === 'sr' ? 'SR 超分' : 'FG 帧生成'}</h4><span class="badge">未检测到支持</span></div><p class="launch-unavailable">${domain === 'sr' ? '未检测到原生 DLSS 超分，本次没有可准备的超分功能。' : '未检测到原生 Streamline 补帧，本次没有可准备的补帧功能。'}</p>${owned(domain) ? `<p class="config-note">旧设置或恢复记录仍保留，可使用恢复入口处理。</p>${domain === 'fg' ? fgComponentMarkup(data, busy || pending, busy, false) : statusMarkup(domain, data, dirty[domain])}` : ''}${message ? `<p class="launch-message${message.error ? ' launch-error' : ''}" role="${message.error ? 'alert' : 'status'}">${esc(message.text)}</p>` : ''}</section>`;
          return `<section class="launch-panel" data-ls-domain="${domain}" aria-label="${domain === 'sr' ? 'SR 超分辨率' : 'FG 帧生成'}"><div class="launch-panel-title"><h4>${domain === 'sr' ? 'SR 超分' : 'FG 帧生成'}</h4><span>${domain === 'sr' ? '画质与模型' : '倍率与目标'}</span></div>
            ${domain === 'fg' ? fgComponentMarkup(data, busy || pending || fgCapabilityMissing, busy) : ''}
            ${domain === 'fg' && fgCapabilityMissing ? '<p class="launch-unavailable">未确认游戏已有 Streamline DLSS 帧生成，暂不写入补帧设置。</p>' : ''}
            <fieldset${busy || pending || (domain === 'sr' ? capabilityMissing : fgCapabilityMissing) || !available ? ' disabled' : ''}><legend class="sr-only">${domain.toUpperCase()} 设置</legend>${legacyOptiScaler ? '<p class="launch-unavailable">检测到旧 OptiScaler 设置。请先点击总的“恢复默认”，再设置原生 DLSS；恢复记录仍会保留。</p>' : domain === 'sr' ? srFields(fields, data.hardware) : fgFields(fields, data.hardware, data.featureStates?.fg, data.fgComponents)}
            ${statusMarkup(domain, data, dirty[domain])}${message ? `<p class="launch-message${message.error ? ' launch-error' : ''}" role="${message.error ? 'alert' : 'status'}">${esc(message.text)}</p>` : ''}
            ${message?.error && dirty[domain] ? '<button class="button subtle" type="button" data-ls-action="auto">重试应用</button>' : ''}</fieldset></section>`;
        }).join('')}</div>`;
      const recover = host.querySelector('[data-ls-action="recover"]');
      if (recover) recover.disabled = busy;
      if (focusField && focusDomain && !busy) host.querySelector(`[data-ls-domain="${focusDomain}"] [data-ls-field="${focusField}"]`)?.focus?.({ preventScroll: true });
      if (scrollOwner && typeof scrollTop === 'number') scrollOwner.scrollTop = scrollTop;
    }
    async function refresh(resetDrafts = false) {
      const token = ++generation;
      const next = unwrap(await manager.inspectLaunchSettings(id));
      if (token !== generation || !attached()) return;
      data = next;
      for (const domain of ['sr', 'fg']) if (resetDrafts || !drafts[domain]) { drafts[domain] = initialFields(domain, data); dirty[domain] = false; }
      render();
    }
    async function perform(action, domain) {
      if (busy) return;
      busy = true;
      let succeeded = false;
      try {
        if (domain) delete messages[domain];
        if (action === 'auto' && (domain === 'sr' ? capabilityMissing : fgCapabilityMissing) || fgCapabilityMissing && ['prepare', 'migrate-components'].includes(action))
          throw new Error(domain === 'sr' ? '未检测到普通 DLSS，请先确认所选游戏 EXE。' : '未确认游戏已有可用的帧生成组件。');
        if (action === 'auto') {
          const request = createRequest(domain, drafts[domain]);
          setMessage(domain, '正在应用…'); render();
          if (typeof manager.updateLaunchSettings !== 'function') throw new Error('管理器设置接口未完整更新，请重启新版后重试。');
          let response = await manager.updateLaunchSettings(id, domain, request, { allowAntiCheat: false });
          if (response?.ok === false && response.error?.code === 'ERR_ANTI_CHEAT_CONFIRM') {
            if (typeof scope.confirmAntiCheat !== 'function' || !await scope.confirmAntiCheat(id)) throw new Error('已取消组件安装。');
            response = await manager.updateLaunchSettings(id, domain, request, { allowAntiCheat: true });
          }
          const result = unwrap(response);
          if (result?.applied !== true && result?.skipped !== true) throw new Error('未能确认设置已应用。');
          dirty[domain] = false;
          setMessage(domain, result.noOp ? '已与当前配置一致。' : '设置已应用；效果以游戏内实际表现为准。');
        } else if (action === 'restore-all') {
          for (const key of ['sr', 'fg']) { clearTimeout(timers[key]); queued.delete(key); }
          render();
          const result = unwrap(await manager.resetAllLaunchSettings(id));
          if (result?.restored !== true) throw new Error('未能确认所有设置已恢复。');
          for (const key of ['sr', 'fg']) { dirty[key] = false; setMessage(key, '已撤销管理器覆盖，恢复原有设置。'); }
        } else if (action === 'runtime-help') {
          render();
          if (unwrap(await manager.openExternal('vcRuntimeUrl')) !== true) throw new Error('无法打开微软下载，请稍后重试。');
          setMessage('fg', '已打开微软运行库下载；安装或修复完成后点击“重新检查运行库”。');
        } else if (action === 'mfg-source') {
          render();
          if (unwrap(await manager.openExternal('mfgUnlockUrl')) !== true) throw new Error('无法打开 MFG Unlock 开源项目。');
          setMessage('fg', '已打开 MFG Unlock 开源项目；当前推荐 1.0，0.9 为回退。');
        } else if (action === 'runtime-check') {
          render();
        } else if (action === 'prepare' || action === 'migrate-components') {
          render();
          let response = await manager.prepareFgComponents(id, { allowAntiCheat: false, migrateLegacy: action === 'migrate-components' });
          if (response?.ok === false && response.error?.code === 'ERR_ANTI_CHEAT_CONFIRM') {
            if (typeof scope.confirmAntiCheat !== 'function' || !await scope.confirmAntiCheat(id)) throw new Error('已取消组件安装。');
            response = await manager.prepareFgComponents(id, { allowAntiCheat: true, migrateLegacy: action === 'migrate-components' });
          }
          unwrap(response);
          setMessage('fg', 'MFG Unlock 已准备，默认跟随游戏；重启后在游戏中开启帧生成，并打开 ReShade 的 MFG Unlock 面板核对。');
        } else if (action === 'recover-components') {
          render(); unwrap(await manager.recoverFgComponents(id)); setMessage('fg', '未完成迁移已恢复，请重新检查后选择方案。');
        } else if (action === 'native-route' || action === 'remove-components') {
          render();
          unwrap(await manager.restoreFgComponents(id));
          setMessage('fg', action === 'native-route' ? '已切换为原生帧生成路线。' : '已移除本工具安装的兼容组件。');
        } else if (action === 'recover') {
          render();
          unwrap(await manager.recoverLaunchSettings(id));
          for (const key of ['sr', 'fg']) setMessage(key, '未完成操作已恢复。');
        } else throw new Error('不支持的设置操作。');
        succeeded = true;
      } catch (error) {
        const text = `${error.message}${error.code ? ` [${error.code}]` : ''}`;
        setMessage(domain || 'sr', text, true);
      }
      {
        try { await refresh(false); }
        catch (error) { setMessage(domain || 'sr', `${succeeded ? '操作已完成；' : ''}状态读取失败：${error.message}。请重新读取。`, true); }
        if (succeeded && action === 'restore-all' && data) for (const key of ['sr', 'fg']) drafts[key] = initialFields(key, data);
        if (succeeded && ['native-route', 'remove-components', 'migrate-components', 'recover-components', 'prepare'].includes(action) && data) { drafts.fg = initialFields('fg', data); dirty.fg = false; }
        if (succeeded && ['prepare', 'migrate-components'].includes(action) && data?.fgComponents?.ready !== true) setMessage('fg', '组件检查尚未通过，请处理上方提示后重试。', true);
        if (succeeded && action === 'runtime-check') setMessage('fg', data?.fgComponents?.runtime?.ready === true
          ? '基础运行库文件检查通过；游戏内加载与帧生成仍需验证。' : '运行库检查尚未通过，请处理上方提示。', data?.fgComponents?.runtime?.ready !== true);
      }
      busy = false;
      render();
      const next = queued.values().next().value;
      if (next) { queued.delete(next); void perform('auto', next); }
    }
    function schedule(domain) {
      clearTimeout(timers[domain]);
      timers[domain] = setTimeout(() => {
        if (!dirty[domain]) return;
        if (busy) queued.add(domain); else void perform('auto', domain);
      }, options.autoApplyDelay ?? 500);
    }
    host.onchange = event => {
      const field = event.target?.dataset?.lsField;
      const domain = event.target?.closest('[data-ls-domain]')?.dataset.lsDomain;
      if (!field || !domain || busy) return;
      drafts[domain][field] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
      if (domain === 'sr' && field === 'quality' && Object.hasOwn(PRESET_PERCENT, drafts.sr.quality)) drafts.sr.renderPercent = PRESET_PERCENT[drafts.sr.quality];
      if (domain === 'sr' && field === 'renderPercent') drafts.sr.quality = 'custom';
      dirty[domain] = true;
      delete messages[domain];
      schedule(domain);
      if (event.target.type === 'number') return;
      render();
    };
    host.oninput = event => {
      // Numeric edits are applied only after the user pauses typing.
      const field = event.target?.dataset?.lsField;
      const domain = event.target?.closest('[data-ls-domain]')?.dataset.lsDomain;
      if (!field || !domain || busy || event.target.type !== 'number') return;
      drafts[domain][field] = event.target.value;
      if (domain === 'sr' && field === 'renderPercent') {
        drafts.sr.quality = 'custom';
        event.target.closest('[data-ls-domain]').querySelector('[data-ls-field="quality"]').value = 'custom';
      }
      dirty[domain] = true;
      schedule(domain);
      const panel = event.target.closest('[data-ls-domain]');
      const badge = panel.querySelector('.launch-status .badge');
      if (badge) { badge.textContent = '等待应用'; badge.className = 'badge warn'; }
    };
    host.onclick = event => {
      const button = event.target?.closest('[data-ls-action]');
      if (!button || button.disabled || busy) return;
      event.stopPropagation();
      const action = button.dataset.lsAction;
      const domain = button.closest('[data-ls-domain]')?.dataset.lsDomain;
      if (action === 'reload') { controller.ready = initialize(); return; }
      void perform(action, domain);
    };
    async function initialize() {
      try {
        if (!manager || typeof manager.inspectLaunchSettings !== 'function') throw new Error('当前程序未提供启动设置接口。');
        await refresh();
      } catch (error) {
        if (attached()) host.innerHTML = `<div class="launch-recovery" role="alert"><span>${esc(error.message)}</span><button class="button" data-ls-action="reload" type="button">重新读取</button></div>`;
      }
    }
    const controller = { refresh, perform, getState: () => ({ data, drafts, dirty, busy }), ready: null };
    host.launchSettingsController = controller;
    controller.ready = initialize();
    return controller;
  }

  const api = { mount, createRequest, hardwareFacts, recommendedPreset, initialFields, initialSrFields, SR_MODEL_LABELS, SR_MODEL_DESCRIPTIONS,
    requestLabel, statusMarkup, fgComponentMarkup, driverScopeMarkup };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else scope.launchSettingsUi = api;
})(typeof window === 'object' ? window : globalThis);
