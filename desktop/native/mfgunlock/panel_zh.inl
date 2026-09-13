// Chinese presentation for MFGAdaUnlock-RenoDx 0.7. Runtime hooks, defaults,
// INI keys, add-on registration and diagnostic log messages remain upstream.
// The host owns its font atlas. Never rebuild or mutate it from an overlay.
bool MfgChineseGlyphsAvailable() noexcept {
  ImFont* font = ImGui::GetFont();
  return font != nullptr && font->IsGlyphInFont(static_cast<ImWchar>(0x4E2D)) &&
         font->IsGlyphInFont(static_cast<ImWchar>(0x8865)) &&
         font->IsGlyphInFont(static_cast<ImWchar>(0x5E27)) &&
         font->IsGlyphInFont(static_cast<ImWchar>(0x8BBE));
}
bool g_mfg_chinese_ui = false;
const char* MfgUi(const char* english, const char* chinese) noexcept {
  return g_mfg_chinese_ui ? chinese : english;
}
void OnRegisterOverlay(reshade::api::effect_runtime* /*runtime*/) {
  g_mfg_chinese_ui = MfgChineseGlyphsAvailable();
  if (!g_mfg_chinese_ui) {
    ImGui::TextWrapped("Chinese glyphs are unavailable in the ReShade font. In Settings > Overlay & Styling select zh-CN/System Default or C:\\Windows\\Fonts\\msyh.ttc, then restart the game. English remains readable here.");
  }
  ImGui::TextUnformatted(MfgUi("RTX 40 - MFG Unlock", "RTX 40 · MFG 补帧"));
  const unsigned int force = mfgunlock::framecount::g_force_multiplier.load(std::memory_order_relaxed);
  const char* preview = force == 0 ? MfgUi("Follow game", "跟随游戏") : force == 2 ? "2x" : force == 3 ? "3x" : force == 4 ? "4x"
      : force == 5 ? MfgUi("5x (saved experimental request)", "5×（已保存的实验请求）")
      : MfgUi("6x (saved experimental request)", "6×（已保存的实验请求）");
  if (ImGui::BeginCombo(MfgUi("Requested multiplier###mfg-force", "请求倍率###mfg-force"), preview)) {
    const unsigned int choices[] = {0, 2, 3, 4};
    const char* labels[] = {MfgUi("Follow game", "跟随游戏"), "2x", "3x", "4x"};
    for (unsigned int index = 0; index < 4; ++index) {
      if (ImGui::Selectable(labels[index], force == choices[index])) {
        mfgunlock::framecount::g_force_multiplier.store(choices[index], std::memory_order_relaxed);
        reshade::set_config_value(nullptr, kConfigSection, "ForceMultiplier", choices[index]);
      }
    }
    ImGui::EndCombo();
  }
  ImGui::TextWrapped("%s", MfgUi("Enable FG in the game first; requests only raise the multiplier.",
      "先在游戏内开启帧生成；仅向上请求倍率。"));
  ImGui::TextWrapped("%s", MfgUi("In-game changes are saved automatically.", "游戏内修改自动保存。"));
  if (force > 4) ImGui::TextWrapped("%s", MfgUi(
      "The saved 5x/6x value is retained, but is not a verified selectable mode in this package.",
      "已保留原有 5×/6× 请求；本配套未把它列为已验证的可选模式。"));
  const bool state_seen = mfgunlock::framecount::g_state_seen.load(std::memory_order_relaxed);
  const unsigned int status = mfgunlock::framecount::g_dlssg_status.load(std::memory_order_relaxed);
  if (state_seen && status == 0) {
    ImGui::TextUnformatted(MfgUi("DLSS-G reports a valid runtime state.", "DLSS-G 已返回正常运行状态。"));
    ImGui::Text(MfgUi("Presentations in the latest sample: %u", "最近一次采样的呈现帧数：%u"),
        mfgunlock::framecount::g_actual_frames_presented.load(std::memory_order_relaxed));
    ImGui::TextWrapped("%s", MfgUi("A sample count is not a measured FPS multiplier; compare the same scene to validate output.",
        "单次采样帧数不等于实测帧率倍率；请用同场景对照确认输出。"));
  } else if (state_seen) {
    ImGui::Text(MfgUi("DLSS-G reported status flags: 0x%x", "DLSS-G 状态异常：0x%x"), status);
  } else {
    ImGui::TextWrapped("%s", MfgUi("Waiting for the game's frame-generation state. Open a playable scene with FG enabled.",
        "等待游戏的补帧状态。请先开启帧生成并进入可游玩场景。"));
  }
  if (ImGui::CollapsingHeader(MfgUi("How to use###mfg-help", "使用说明###mfg-help"))) {
    ImGui::TextWrapped("%s", MfgUi(
        "This only raises a lower game request. 2x does not disable FG or lower a higher request. Use Follow game when the game has its own multiplier selector.",
        "本插件只提高较低请求。2× 不会关闭补帧，也不会降低已有更高倍率。游戏自带倍率选项时建议跟随游戏。"));
    ImGui::TextWrapped("%s", MfgUi(
        "Changes are saved to the active ReShade.ini. The multiplier is read on the next game options call; toggle FG in the game or fully restart if unchanged. Manager changes require a full game restart.",
        "修改保存到活动 ReShade.ini。倍率在游戏下次提交设置时读取；未变化时可重新开关游戏补帧，或完全重启。管理器中的修改需重启游戏。"));
  }
  if (ImGui::CollapsingHeader(MfgUi("Compatibility settings###mfg-compat", "兼容设置###mfg-compat"))) {
    bool enabled = g_enabled.load(std::memory_order_relaxed);
    if (ImGui::Checkbox(MfgUi("Allow higher-multiplier capability unlock###mfg-enabled", "允许解锁更高倍率###mfg-enabled"), &enabled)) {
      g_enabled.store(enabled, std::memory_order_relaxed);
      reshade::set_config_value(nullptr, kConfigSection, "Enabled", enabled ? 1 : 0);
    }
    ImGui::TextWrapped("%s", MfgUi("This is not a live master FG off switch. Existing patches are not undone here; fully restart after changing it. Disable FG in the game, or remove this addon after exiting, to stop using the corresponding path.",
        "能力解锁设置，非实时总开关。已加载补丁不会撤销；更改后需完全重启。关闭补帧请用游戏设置；移除插件需先退出游戏。"));
    int count = static_cast<int>(g_max_count.load(std::memory_order_relaxed));
    if (ImGui::SliderInt(MfgUi("Reported capacity (generated frames)###mfg-max", "报告容量（生成帧数）###mfg-max"), &count,
                         static_cast<int>(kMinCount), static_cast<int>(kMaxCount))) {
      count = std::clamp(count, static_cast<int>(kMinCount), static_cast<int>(kMaxCount));
      g_max_count.store(static_cast<unsigned int>(count), std::memory_order_relaxed);
      reshade::set_config_value(nullptr, kConfigSection, "MaxCount", count);
    }
    ImGui::TextWrapped("%s", MfgUi("A legacy capability hint, not the actual multiplier or proof of support. Keep the existing default.",
        "这是旧能力提示值，不是实际倍率或支持证明；建议保留默认值。"));
    bool temporal = g_temporal_fix.load(std::memory_order_relaxed);
    if (ImGui::Checkbox(MfgUi("Temporal interpolation correction###mfg-temporal", "时间插值修正（推荐开启）###mfg-temporal"), &temporal)) {
      g_temporal_fix.store(temporal, std::memory_order_relaxed);
      reshade::set_config_value(nullptr, kConfigSection, "TemporalFix", temporal ? 1 : 0);
    }
    ImGui::TextUnformatted(MfgUi("Applied at load; restart after changing.", "加载时应用；更改后需重启。"));
    bool flip_off = g_force_flip_meter_off.load(std::memory_order_relaxed);
    if (ImGui::Checkbox(MfgUi("Legacy software pacing###mfg-pacing", "旧版软件帧节奏兼容###mfg-pacing"), &flip_off)) {
      g_force_flip_meter_off.store(flip_off, std::memory_order_relaxed);
      reshade::set_config_value(nullptr, kConfigSection, "ForceFlipMeteringOff", flip_off ? 1 : 0);
    }
    ImGui::TextWrapped("%s", MfgUi("Keep off normally. Try only if 3x/4x freezes; a full restart is required.",
        "通常保持关闭；仅在 3×/4× 画面冻结时尝试，更改后需完全重启。"));
    int hdr_mode = static_cast<int>(mfgunlock::framecount::g_hdr_compatibility_mode.load(std::memory_order_relaxed));
    const char* hdr_labels[] = {MfgUi("Keep game inputs", "保留游戏输入"), MfgUi("UI recomposition (experimental)", "界面重组（实验）"),
        MfgUi("Automatic Quality Guard (recommended)", "自动输入保护（推荐）")};
    if (ImGui::Combo(MfgUi("Frame-generation input quality###mfg-quality", "补帧输入保护###mfg-quality"), &hdr_mode, hdr_labels, 3)) {
      mfgunlock::framecount::g_hdr_compatibility_mode.store(static_cast<unsigned int>(hdr_mode), std::memory_order_relaxed);
      mfgunlock::framecount::g_ui_recomposition_applied.store(false, std::memory_order_relaxed);
      mfgunlock::framecount::g_ui_recomposition_fell_back.store(false, std::memory_order_relaxed);
      mfgunlock::framecount::g_hud_inputs_suppressed.store(false, std::memory_order_relaxed);
      mfgunlock::framecount::NotifyQualityModeChanged();
      reshade::set_config_value(nullptr, kConfigSection, "HDRCompatibilityMode", hdr_mode);
    }
    ImGui::TextWrapped("%s", MfgUi("Automatic mode filters incompatible optional HUD/UI inputs while retaining required scene data. It does not change the requested multiplier or add another FG pass.",
        "自动模式过滤不兼容的可选 HUD/界面输入，并保留必需的场景数据；不会改动请求倍率或增加一次补帧。"));
    int depth_edge_level = static_cast<int>(mfgunlock::framecount::g_depth_edge_guard_level.load(std::memory_order_relaxed));
    const char* edge_labels[] = {MfgUi("Off (default)", "关闭（默认）"), MfgUi("Mild", "轻度"), MfgUi("Balanced", "平衡"),
        MfgUi("Strong", "较强"), MfgUi("Aggressive", "激进")};
    if (ImGui::Combo(MfgUi("Optional depth-edge adjustment###mfg-depth", "深度边缘调节（可选）###mfg-depth"), &depth_edge_level, edge_labels, 5)) {
      mfgunlock::framecount::g_depth_edge_guard_level.store(static_cast<unsigned int>(depth_edge_level), std::memory_order_relaxed);
      mfgunlock::framecount::NotifyDepthEdgeTuningChanged();
      reshade::set_config_value(nullptr, kConfigSection, "DepthEdgeGuardLevel", depth_edge_level);
    }
    ImGui::TextWrapped("%s", MfgUi("Keep off unless the same scene shows an improvement. This is not an NR face mask and does not change frame pacing.",
        "仅在同场景观察到改善时使用；这不是 NR 人脸遮罩，也不会改变帧节奏。"));
  }
  if (ImGui::CollapsingHeader(MfgUi("Runtime details###mfg-details", "运行详情###mfg-details"))) {
    const DetectedRenderApi render_api = g_render_api.load(std::memory_order_relaxed);
    ImGui::Text(MfgUi("Renderer: %s%s", "图形 API：%s%s"), RenderApiName(render_api),
        render_api == DetectedRenderApi::kVulkan ? MfgUi(" (experimental)", "（实验）") : "");
    if (g_gate_patched.load(std::memory_order_acquire))
      ImGui::Text(MfgUi("Capability patches: %zu provider(s), %zu site(s)", "能力补丁：%zu 个运行库，%zu 处"), g_gate_modules.size(), g_gate_sites.size());
    else ImGui::TextUnformatted(MfgUi("A compatible DLSS-G provider has not been located yet.", "尚未找到匹配的 DLSS-G 运行库。"));
    if (g_midpoint_patched.load(std::memory_order_acquire))
      ImGui::TextWrapped(MfgUi("Temporal correction: %zu provider(s); %s", "时间修正：%zu 个运行库；%s"), g_midpoint_modules.size(), g_midpoint_detail.c_str());
    else ImGui::TextUnformatted(MfgUi("Temporal correction has not been applied.", "尚未应用时间修正。"));
    if (g_ceiling_patched.load(std::memory_order_acquire))
      ImGui::Text(MfgUi("Streamline limit: compiled %ux, advertised %ux", "Streamline 上限：内置 %u×，报告 %u×"), g_ceiling_compiled + 1, g_ceiling_effective + 1);
    if (mfgunlock::framecount::g_capacity_advertised.load(std::memory_order_relaxed))
      ImGui::Text(MfgUi("Native menu capacity: runtime %ux, advertised %ux", "游戏菜单容量：运行库 %u×，报告 %u×"),
          mfgunlock::framecount::g_runtime_max_generated.load(std::memory_order_relaxed) + 1,
          mfgunlock::framecount::g_advertised_max_generated.load(std::memory_order_relaxed) + 1);
    if (mfgunlock::framecount::g_intercepted.load(std::memory_order_relaxed))
      ImGui::Text(MfgUi("Game requested %ux; override requested %u generated frames", "游戏请求 %u×；覆盖请求 %u 张生成帧"),
          mfgunlock::framecount::g_last_requested.load(std::memory_order_relaxed) + 1,
          mfgunlock::framecount::g_last_forced.load(std::memory_order_relaxed));
    else if (mfgunlock::framecount::g_declined_no_pacing.load(std::memory_order_relaxed))
      ImGui::TextWrapped("%s", MfgUi("The multiplier was not raised because pacing was not ready; the game request was retained.",
          "帧节奏条件尚未满足，未提高倍率；已保留游戏原请求。"));
    else ImGui::TextUnformatted(MfgUi("Waiting for a game options call.", "等待游戏提交补帧设置。"));
    ImGui::Text(MfgUi("Successful state samples: %llu", "成功状态采样：%llu"), mfgunlock::framecount::g_state_samples.load(std::memory_order_relaxed));
    ImGui::Text(MfgUi("Quality Guard filtered %llu optional-input batches", "自动输入保护已过滤 %llu 批可选输入"),
        mfgunlock::framecount::g_hud_suppression_calls.load(std::memory_order_relaxed));
    ImGui::TextWrapped("%s", MfgUi("Keep the ReShade log for feedback. A loaded addon or raised capability is not proof of the final generated-frame rate.",
        "反馈时请保留 ReShade 日志。插件已加载或报告容量提高，都不等于最终生成帧率已验收。"));
  }
}
