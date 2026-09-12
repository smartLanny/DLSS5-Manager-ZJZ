'use strict';

(() => {
  function showToast(message, error = false) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.className = `toast show${error ? ' error' : ''}`;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { el.className = 'toast'; }, 4200);
  }

  function seriesLabel(policy) {
    const series = Array.isArray(policy && policy.hardwareSeries) ? policy.hardwareSeries : [];
    return series.length ? series.map(value => value.replace('RTX', 'RTX ')).join(' / ') : '未识别 RTX 代际';
  }

  function presetLabel(preset) {
    const value = String(preset || '').toLowerCase();
    if (value === 'm') return 'Model M';
    if (value === 'l') return 'Model L';
    if (value === 'k') return 'Model K';
    return 'NVIDIA 默认';
  }

  function noteFor(policy) {
    const series = seriesLabel(policy);
    const effective = String(policy && policy.effective || 'default').toLowerCase();
    const selected = String(policy && policy.selection || 'auto').toLowerCase();
    const prefix = selected === 'auto'
      ? `自动推荐：${series} → ${presetLabel(effective)}。`
      : `手动选择：${presetLabel(effective)}。`;

    let performance = '';
    if (effective === 'm') {
      performance = policy.fp8Penalty
        ? '⚠ RTX 20/30 缺少原生 FP8，M 的性能损失会明显高于 K；建议只用于手动 A/B。'
        : 'M 是 DLSS 4.5 第二代 Transformer，NVIDIA 推荐用于 DLSS Performance；兼顾画质与性能，RTX 40/50 默认推荐。';
    } else if (effective === 'l') {
      performance = policy.fp8Penalty
        ? '⚠ RTX 20/30 缺少原生 FP8，L 的性能损失会明显高于 K；不建议作为默认。'
        : 'L 是 DLSS 4.5 第二代模型：高画质优先，通常需要更多 GPU 计算，帧数可能低于 M/K；主要面向 4K Ultra Performance。';
    } else if (effective === 'k') {
      performance = 'K 是 DLSS 4.0 第一代 Transformer；RTX 20/30 默认推荐，兼顾性能与画质。';
    } else {
      performance = '不写入本管理器的 SR 模型覆盖，继续使用 NVIDIA App / 游戏当前策略。';
    }
    return `${prefix}${performance} 设置只会在下次通过本管理器启动游戏前写入 NVIDIA 每游戏配置，不会在游戏运行中重建 DLSS。`;
  }

  async function refreshDetail(detail) {
    const id = detail.dataset.gameDetail;
    const select = detail.querySelector('.sr-model-select');
    const note = detail.querySelector('.sr-model-note');
    const effective = detail.querySelector('.sr-model-effective');
    if (!id || !select || !note) return;
    select.disabled = true;
    try {
      const result = await window.manager.readSrModel(id);
      if (!result || result.ok !== true) throw new Error(result && result.error ? result.error.message : '读取模型设置失败');
      const policy = result.value;
      select.value = policy.selection;
      if (effective) effective.textContent = `启动时：${presetLabel(policy.effective)}`;
      note.textContent = noteFor(policy);
    } catch (error) {
      note.textContent = `DLSS SR 模型设置暂不可用：${error.message}`;
    } finally {
      select.disabled = false;
    }
  }

  function enhanceDetail(detail) {
    if (!detail || detail.dataset.srModelEnhanced === '1') return;
    const versionSelect = detail.querySelector('.game-version-select');
    const versionRow = versionSelect && versionSelect.closest('.control-row');
    if (!versionRow) return;
    detail.dataset.srModelEnhanced = '1';

    const row = document.createElement('div');
    row.className = 'control-row sr-model-row';
    row.innerHTML = '<label>DLSS SR 模型</label><select class="sr-model-select"><option value="auto">自动推荐（40/50 → M；20/30 → K）</option><option value="m">M — DLSS 4.5（推荐）</option><option value="l">L — DLSS 4.5（高画质，可能低帧数）</option><option value="k">K — DLSS 4.0（20/30 推荐）</option><option value="default">NVIDIA 默认 / 不覆盖</option></select><span class="sr-model-effective"></span>';
    const note = document.createElement('p');
    note.className = 'config-note sr-model-note';
    note.textContent = '正在读取显卡与模型策略…';
    versionRow.insertAdjacentElement('afterend', row);
    row.insertAdjacentElement('afterend', note);

    const select = row.querySelector('.sr-model-select');
    select.onchange = async event => {
      event.stopPropagation();
      select.disabled = true;
      try {
        const result = await window.manager.writeSrModel(detail.dataset.gameDetail, select.value);
        if (!result || result.ok !== true) throw new Error(result && result.error ? result.error.message : '保存模型设置失败');
        const policy = result.value;
        row.querySelector('.sr-model-effective').textContent = `启动时：${presetLabel(policy.effective)}`;
        note.textContent = noteFor(policy);
        showToast('DLSS SR 模型策略已保存；下次通过管理器启动游戏前应用。');
      } catch (error) {
        showToast(error.message, true);
        await refreshDetail(detail);
      } finally {
        select.disabled = false;
      }
    };
    refreshDetail(detail);
  }

  function scan() {
    document.querySelectorAll('.game-detail[data-game-detail]').forEach(enhanceDetail);
  }

  window.manager.onSrModelApplied(payload => {
    if (!payload || !payload.id) return;
    const details = [...document.querySelectorAll('.game-detail[data-game-detail]')];
    const detail = details.find(row => row.dataset.gameDetail === payload.id);
    if (detail) refreshDetail(detail);
    setTimeout(() => {
      const apply = payload.apply || {};
      if (apply.ok) {
        const text = String(payload.effective || 'default').toLowerCase() === 'default'
          ? '游戏已启动；DLSS SR 模型保持 NVIDIA 默认 / 当前配置。'
          : `游戏已启动；启动前已应用 DLSS SR ${presetLabel(payload.effective)}。`;
        showToast(text, false);
      } else {
        showToast(`游戏已启动，但 DLSS SR 模型未应用：${apply.error || 'NvAPI DRS 写入失败'}`, true);
      }
    }, 160);
  });

  const root = document.getElementById('gameList');
  if (root) new MutationObserver(scan).observe(root, { childList: true, subtree: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
  else scan();
})();
