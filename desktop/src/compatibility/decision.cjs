'use strict';
const { safeText, frozen } = require('./model.cjs');
// Presentation adapter ONLY. Existing route services remain the authority.
function decisionView(input = {}) {
  const candidates = (Array.isArray(input.candidates) ? input.candidates : []).slice(0,32).filter(r => r && typeof r.id === 'string');
  const find = id => candidates.find(r => r.id === id);
  const locked = find(input.selectedId), recommendation = find(input.recommendedId);
  // A missing/unavailable explicit selection must not silently fall back to another NR owner.
  const selectedMissing = Boolean(input.selectedId && !locked);
  const candidate = locked || (!input.selectedId ? recommendation : null);
  const blockers = candidate ? (candidate.blockers || []).slice(0,8) : [];
  const available = candidate?.available === true && blockers.length === 0;
  const action = candidate?.action;
  const validAction = ['install','prepare','switch','repair','launch'].includes(action?.kind) && typeof action?.planId === 'string';
  const titles = {install:'安装推荐方案',prepare:'准备所需组件',switch:'备份并切换',repair:'检查并修复',launch:'启动游戏'};
  const state = input.runtime || {};
  const runtimeBound = Boolean(state.sessionId && state.sessionId === input.sessionId &&
    state.recipeFingerprint && state.recipeFingerprint === input.recipeFingerprint &&
    state.configurationGeneration === input.configurationGeneration && state.current === true);
  let status = input.installed ? '已安装 · 本次运行效果待确认' : '尚未安装';
  if (runtimeBound && state.loaded === true) status = '本次已加载 · 画面效果仍需确认';
  if (runtimeBound && state.nrCompleted === true) status = '本次 NR 已处理 · 不代表最终画面已验证';
  if (runtimeBound && state.failure) status = safeText(state.failure,180);
  if (selectedMissing) status = '原方案暂不可用，已保留选择；没有自动更换后端。';
  else if (blockers.length) status = safeText(blockers[0].message || blockers[0],180);
  const warnings = (candidate?.warnings || []).slice(0,6).map(r => safeText(r.message || r,180));
  return frozen({contextKey: String(input.contextKey || ''), title: safeText(candidate?.name || '先检查当前游戏',100),
    subtitle: input.selectedId ? '沿用你的选择' : '由现有兼容规则推荐', status,
    reasons:(candidate?.reasons || []).slice(0,3).map(r=>safeText(r.message || r,180)), warnings,
    primary: available && validAction ? { label:titles[action.kind], kind:action.kind, planId:action.planId } : null,
    selectedId: candidate?.id || null,
    alternatives: candidates.filter(r=>r.id !== candidate?.id).map(r=>({id:r.id,name:safeText(r.name || r.id),
      available:r.available === true && !(r.blockers || []).length, reason:safeText(r.blockers?.[0]?.message || r.reasons?.[0] || '尚无匹配测试',180)})),
    layers:(candidate?.layers || []).slice(0,8).map(r=>({label:safeText(r.label,60),name:safeText(r.name),version:safeText(r.version,80)})),
    verification: safeText(candidate?.verificationLabel || '尚无匹配的实际游戏验证',180)
  });
}
module.exports = { decisionView };
