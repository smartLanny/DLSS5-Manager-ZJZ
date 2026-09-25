void OnRegisterOverlay(reshade::api::effect_runtime* /*runtime*/) {
  bool gate_patched = false;
  bool midpoint_patched = false;
  bool blackwell_patched = false;
  bool thin_geometry_patched = false;
  size_t gate_provider_count = 0;
  size_t gate_site_count = 0;
  size_t midpoint_provider_count = 0;
  size_t blackwell_provider_count = 0;
  size_t thin_geometry_provider_count = 0;
  std::string midpoint_detail;
  std::string blackwell_detail;
  ThinGeometryModulePatch thin_geometry_last;
  bool ceiling_patched = false;
  unsigned int ceiling_compiled = 0;
  unsigned int ceiling_effective = 0;
  size_t flip_meter_site_count = 0;
  AcquireSRWLockShared(&g_provider_maintenance_lock);
  gate_patched = g_gate_patched.load(std::memory_order_relaxed);
  midpoint_patched = g_midpoint_patched.load(std::memory_order_relaxed);
  blackwell_patched = g_blackwell_patched.load(std::memory_order_relaxed);
  thin_geometry_patched = g_thin_geometry_patched.load(std::memory_order_relaxed);
  gate_provider_count = g_gate_modules.size();
  gate_site_count = g_gate_sites.size();
  midpoint_provider_count = g_midpoint_modules.size();
  blackwell_provider_count = g_blackwell_modules.size();
  thin_geometry_provider_count = g_thin_geometry_modules.size();
  midpoint_detail = g_midpoint_detail;
  blackwell_detail = g_blackwell_detail;
  if (!g_thin_geometry_modules.empty()) {
    thin_geometry_last = g_thin_geometry_modules.back();
  }
  ReleaseSRWLockShared(&g_provider_maintenance_lock);
  AcquireSRWLockShared(&g_streamline_maintenance_lock);
  ceiling_patched = g_ceiling_patched.load(std::memory_order_relaxed);
  ceiling_compiled = g_ceiling_compiled;
  ceiling_effective = g_ceiling_effective;
  flip_meter_site_count = g_flip_meter_sites.size();
  ReleaseSRWLockShared(&g_streamline_maintenance_lock);

  bool configured_enabled = g_configured_enabled.load(std::memory_order_relaxed);
  if (ImGui::Checkbox("下次启动启用插件", &configured_enabled)) {
    g_configured_enabled.store(configured_enabled, std::memory_order_relaxed);
    reshade::set_config_value(nullptr, kConfigSection, "Enabled",
                              configured_enabled ? 1 : 0);
  }
  const bool enabled = g_enabled.load(std::memory_order_relaxed);
  if (configured_enabled != enabled) {
    ImGui::TextDisabled("需要重启；本次游戏仍为%s。",
                        enabled ? "已启用" : "已关闭");
  }

  int count = static_cast<int>(g_max_count.load(std::memory_order_relaxed));
  if (ImGui::SliderInt("向游戏报告的最高倍率", &count,
                       static_cast<int>(kMinCount), static_cast<int>(kMaxCount))) {
    if (count < static_cast<int>(kMinCount)) count = static_cast<int>(kMinCount);
    if (count > static_cast<int>(kMaxCount)) count = static_cast<int>(kMaxCount);
    g_max_count.store(static_cast<unsigned int>(count), std::memory_order_relaxed);
    reshade::set_config_value(nullptr, kConfigSection, "MaxCount", count);
  }
  ImGui::TextDisabled(
      "DLSS-G 下次查询运行库时生效；如果游戏中没有出现选项，\n"
      "请在游戏里先关闭再开启帧生成。");

  const DetectedRenderApi render_api = g_render_api.load(std::memory_order_relaxed);
  ImGui::Text("ReShade 检测到的渲染接口：%s%s", RenderApiName(render_api),
              render_api == DetectedRenderApi::kVulkan ? "（实验）" : "");

  constexpr const char* kRuntimeModes[] = {
      "使用游戏自带（推荐）",
      "优先本地运行库（关闭 OTA）",
      "强制使用 NVIDIA OTA 运行库"};
  int runtime_mode = static_cast<int>(
      g_configured_runtime_selection_mode.load(std::memory_order_relaxed));
  if (ImGui::Combo("Streamline 运行库选择", &runtime_mode, kRuntimeModes,
                   static_cast<int>(std::size(kRuntimeModes)))) {
    g_configured_runtime_selection_mode.store(
        static_cast<unsigned int>(runtime_mode), std::memory_order_relaxed);
    reshade::set_config_value(nullptr, kConfigSection, "RuntimeSelectionMode",
                              runtime_mode);
  }
  ImGui::TextDisabled(
      "需要重启。本地模式会清除 Streamline OTA 标记，OTA 模式会启用它。\n"
      "请使用版本完全匹配的整套 Streamline，不要混装不同版本 DLL。");
  const int active_runtime_mode = static_cast<int>(
      mfgunlock::framecount::g_runtime_selection_mode.load(
          std::memory_order_relaxed));
  if (runtime_mode != active_runtime_mode) {
    ImGui::TextDisabled("运行库选择已保存，下次启动生效。");
  }
  if (active_runtime_mode != static_cast<int>(
                                 mfgunlock::framecount::RuntimeSelectionMode::kGameDefault)) {
    if (mfgunlock::framecount::g_runtime_selection_observed.load(
            std::memory_order_acquire)) {
      ImGui::Text("slInit policy: flags 0x%llx -> 0x%llx; result %u.",
                  mfgunlock::framecount::g_runtime_flags_before.load(
                      std::memory_order_relaxed),
                  mfgunlock::framecount::g_runtime_flags_after.load(
                      std::memory_order_relaxed),
                  mfgunlock::framecount::g_runtime_selection_result.load(
                      std::memory_order_relaxed));
    } else {
      ImGui::TextDisabled(
          "本次启动时，所选运行库策略没有在 slInit 前生效。");
      if (!HasEarlyLoadEntry()) {
        ImGui::TextWrapped(
            "此游戏会在常规 ReShade 插件加载前初始化 Streamline。"
            "要使用本地或 OTA 策略，需要开启提前加载。");
        if (ImGui::Button("下次启动提前加载此插件")) {
          if (EnsureEarlyLoadEntry()) {
            reshade::log::message(
                reshade::log::level::info,
                "mfgunlock: added this addon to ADDON.LoadFromDllMain; restart required for the Streamline runtime-selection hook.");
          } else {
            reshade::log::message(
                reshade::log::level::error,
                "mfgunlock: could not update ADDON.LoadFromDllMain; add renodx-mfgunlock.addon64 manually and restart.");
          }
        }
      } else {
        ImGui::TextDisabled(
            "已配置提前加载，但没有观察到 slInit；请确认配置中的插件文件名与实际文件一致，"
            "然后完全退出并重启游戏。");
      }
    }
  }

  bool flip_off =
      g_configured_force_flip_meter_off.load(std::memory_order_relaxed);
  if (ImGui::Checkbox("下次启动启用 3x/4x 卡死救援（兼容模式）",
                      &flip_off)) {
    g_configured_force_flip_meter_off.store(flip_off,
                                             std::memory_order_relaxed);
    reshade::set_config_value(nullptr, kConfigSection, "ForceFlipMeteringOff", flip_off ? 1 : 0);
  }
  ImGui::TextDisabled(
      "新版 Streamline 默认保持关闭。仅在 3x/4x 卡死时开启；\n"
      "每次游戏只应用一次，修改后请完全重启游戏。");

  ImGui::Separator();
  const bool active_flip_off =
      g_force_flip_meter_off.load(std::memory_order_relaxed);
  if (flip_off != active_flip_off) {
    ImGui::TextDisabled("卡死救援设置已保存，下次启动生效。");
  }
  if (!active_flip_off) {
    ImGui::TextDisabled("当前使用 Streamline 原生帧节奏，未启用卡死救援补丁。");
  } else if (g_flip_meter_patched.load(std::memory_order_acquire)) {
    ImGui::Text("Flip-metering forced off: +0x%x pinned to %u, %zu site(s).",
                g_flip_meter_offset.load(std::memory_order_relaxed),
                g_flip_meter_value.load(std::memory_order_relaxed),
                flip_meter_site_count);
  } else if (g_flip_meter_attempts.load(std::memory_order_relaxed) >=
             kMaxFlipMeterAttempts) {
    // The counter only advances once the plugin HAS been found, and both give-up
    // paths slam it to the maximum -- so this state is "found it, could not patch
    // it", which is the opposite of what this line used to say.
    ImGui::TextDisabled("DLSS-G plugin found, but flip metering could not be patched.");
    ImGui::TextDisabled("See the ReShade log for the module and the step that failed.");
  } else if (g_flip_meter_attempts.load(std::memory_order_relaxed) > 0) {
    ImGui::TextDisabled("DLSS-G plugin found; flip-metering patch pending (%d).",
                        g_flip_meter_attempts.load(std::memory_order_relaxed));
  } else {
    ImGui::TextDisabled("DLSS-G plugin not located yet -- turn frame generation on.");
  }
  if (ceiling_patched) {
    ImGui::Text("Streamline device-limit bypassed: compiled %ux, effective %ux.",
                ceiling_compiled + 1, ceiling_effective + 1);
  }
  if (mfgunlock::framecount::g_capacity_advertised.load(std::memory_order_relaxed)) {
    ImGui::Text("Native menu maximum: runtime %ux, advertised %ux.",
                mfgunlock::framecount::g_runtime_max_generated.load(std::memory_order_relaxed) + 1,
                mfgunlock::framecount::g_advertised_max_generated.load(
                    std::memory_order_relaxed) + 1);
  }
  if (mfgunlock::framecount::g_state_seen.load(std::memory_order_relaxed)) {
    const unsigned int status =
        mfgunlock::framecount::g_dlssg_status.load(std::memory_order_relaxed);
    ImGui::Text("Actual presentations since last state query: %u.",
                mfgunlock::framecount::g_actual_frames_presented.load(std::memory_order_relaxed));
    if (status != 0) {
      ImGui::Text("DLSS-G runtime status: failure flags 0x%x.", status);
    } else {
      const unsigned int observed =
          mfgunlock::framecount::g_max_actual_frames_presented.load(std::memory_order_relaxed);
      if (observed > 1) {
        ImGui::Text("MFG validation: active; observed up to %u actual presentations.", observed);
      } else {
        ImGui::TextDisabled("DLSS-G status is OK; generated output has not been confirmed yet.");
      }
    }
  } else {
    ImGui::TextDisabled("No successful slDLSSGGetState telemetry sample yet (last result: %u).",
                        mfgunlock::framecount::g_state_result.load(std::memory_order_relaxed));
  }

  ImGui::Separator();
  constexpr const char* kHdrModes[] = {
      "原生路径（默认，推荐大多数游戏）",
      "强制 UI 合成（高级）",
      "自动保护 + UI 合成（HDR 兼容）",
      "最终颜色回退（故障排查）"};
  int hdr_mode = static_cast<int>(
      mfgunlock::framecount::g_hdr_compatibility_mode.load(std::memory_order_relaxed));
  if (ImGui::Combo("帧生成输入画质模式", &hdr_mode, kHdrModes,
                   static_cast<int>(std::size(kHdrModes)))) {
    mfgunlock::framecount::g_hdr_compatibility_mode.store(
        static_cast<unsigned int>(hdr_mode), std::memory_order_relaxed);
    mfgunlock::framecount::NotifyQualityModeChanged();
    reshade::set_config_value(nullptr, kConfigSection, "HDRCompatibilityMode", hdr_mode);
  }
  if (hdr_mode == static_cast<int>(
                      mfgunlock::framecount::HdrCompatibilityMode::kNative)) {
    ImGui::TextDisabled(
        "保持游戏提供的无 HUD 和 UI 标签不变。\n"
        "推荐大多数游戏使用；HUD 出现异常时请选此项。");
  } else if (hdr_mode == static_cast<int>(
                             mfgunlock::framecount::HdrCompatibilityMode::kUiRecomposition)) {
    ImGui::TextDisabled(
        "强制 Streamline 分开处理场景与 UI。游戏必须提供正确匹配的\n"
        "缓冲区和色彩空间，否则可能出现异常。");
  } else if (hdr_mode == static_cast<int>(
                             mfgunlock::framecount::HdrCompatibilityMode::kFinalColorFallback)) {
    ImGui::TextDisabled(
        "HUD/UI 元数据无效时拒绝可选输入，并安全回退到最终颜色。\n"
        "HDR、交换链、分辨率、选项或倍率变化后会重置一次时序历史。");
  } else {
    ImGui::TextDisabled(
        "遇到 HDR 画面异常时可尝试自动模式。HUD 异常则改回“原生路径”。\n"
        "匹配的 SDR 输入可使用 UI 合成，不安全输入会自动回退。");
  }
  ImGui::TextDisabled(
      "此选项不会改写颜色、深度、运动矢量、时序内核或帧节奏。");
  const bool hdr_active =
      mfgunlock::framecount::g_hdr_active.load(std::memory_order_relaxed);
  const bool hdr_seen =
      mfgunlock::framecount::g_hdr_state_seen.load(std::memory_order_acquire);
  ImGui::Text("HDR output detected: %s.",
              hdr_seen ? (hdr_active ? "yes" : "no") : "not observed yet");
  if (mfgunlock::framecount::g_ui_recomposition_applied.load(std::memory_order_relaxed)) {
    ImGui::Text("Streamline accepted the UI-capable path (source options v%u).",
                mfgunlock::framecount::g_ui_recomposition_source_version.load(
                    std::memory_order_relaxed));
    if (hdr_mode == static_cast<int>(
                        mfgunlock::framecount::HdrCompatibilityMode::kAutomaticHybrid)) {
      ImGui::TextDisabled(
          "Quality Guard still controls whether optional HUD-less/UI tags are used.");
    }
  } else if (mfgunlock::framecount::g_ui_recomposition_fell_back.load(
                 std::memory_order_relaxed)) {
    ImGui::Text("UI Composition rejected (result %u); safe fallback is active.",
                mfgunlock::framecount::g_ui_recomposition_result.load(
                    std::memory_order_relaxed));
  } else if (hdr_mode == static_cast<int>(
                             mfgunlock::framecount::HdrCompatibilityMode::kAutomaticHybrid) &&
             hdr_active) {
    ImGui::TextDisabled(
        "Automatic HDR final-color fallback active; UI Composition is intentionally not submitted.");
  } else if (hdr_mode == static_cast<int>(
                             mfgunlock::framecount::HdrCompatibilityMode::kAutomaticHybrid)) {
    ImGui::TextDisabled(
        hdr_seen
            ? "Automatic SDR path is waiting for SetOptions and a valid HUD-less/UI pair."
            : "Automatic mode is waiting for the primary swapchain color space.");
  } else if (hdr_mode == static_cast<int>(
                             mfgunlock::framecount::HdrCompatibilityMode::kUiRecomposition)) {
    ImGui::TextDisabled("UI Composition has not been submitted yet; toggle FG after changing modes.");
  } else if (hdr_mode == static_cast<int>(
                             mfgunlock::framecount::HdrCompatibilityMode::kFinalColorFallback)) {
    ImGui::TextDisabled(
        "Conservative final-color fallback active; UI Composition is intentionally not submitted.");
  }
  if (mfgunlock::framecount::g_hud_inputs_suppressed.load(std::memory_order_relaxed)) {
    ImGui::Text("Quality Guard filtered incompatible optional HUD/UI input.");
    ImGui::TextDisabled("Observed issue mask: 0x%X.",
                        mfgunlock::framecount::g_quality_issue_mask.load(
                            std::memory_order_relaxed));
  }
  if (mfgunlock::framecount::g_quality_mode_change_pending.load(
          std::memory_order_acquire)) {
    ImGui::TextDisabled(
        "Quality-mode option change pending; toggle Frame Generation off/on to apply it.");
  }
  if (mfgunlock::framecount::g_quality_tag_batch_too_large.load(
          std::memory_order_relaxed)) {
    ImGui::TextDisabled(
        "Quality Guard saw a tag batch larger than 64; that batch was forwarded unchanged.");
  }
  if (mfgunlock::framecount::g_quality_viewport_capacity_exhausted.load(
          std::memory_order_relaxed)) {
    ImGui::TextDisabled(
        "More than eight Streamline viewports were seen; extra viewports use conservative fallback.");
  }
  const auto reset_count = mfgunlock::framecount::g_quality_resets_injected.load(
      std::memory_order_relaxed);
  if (reset_count != 0) {
    ImGui::Text("Quality Guard synchronized temporal history %llu time(s).", reset_count);
  }

  constexpr const char* kDepthEdgeModes[] = {
      "关闭（使用游戏数值）",
      "轻度（20.0）",
      "平衡（10.0）",
      "强（4.0）",
      "激进（1.0）"};
  int depth_edge_level = static_cast<int>(
      mfgunlock::framecount::g_depth_edge_guard_level.load(std::memory_order_relaxed));
  if (ImGui::Combo("可选深度边缘保护", &depth_edge_level,
                   kDepthEdgeModes,
                   static_cast<int>(std::size(kDepthEdgeModes)))) {
    mfgunlock::framecount::g_depth_edge_guard_level.store(
        static_cast<unsigned int>(depth_edge_level), std::memory_order_relaxed);
    mfgunlock::framecount::NotifyDepthEdgeTuningChanged();
    reshade::set_config_value(nullptr, kConfigSection, "DepthEdgeGuardLevel",
                              depth_edge_level);
  }
  ImGui::TextDisabled(
      "数值越低，可能越有利于近处物体和屏幕下方的边缘分离。\n"
      "不会在转动镜头时重置，也不会修改帧节奏。");
  if (mfgunlock::framecount::g_depth_edge_override_applied.load(
          std::memory_order_relaxed)) {
    ImGui::Text("Depth-edge override active; game supplied %.3f.",
                mfgunlock::framecount::g_last_native_depth_separation.load(
                    std::memory_order_relaxed));
  }

  ImGui::Separator();
  bool dynamic_mfg =
      mfgunlock::framecount::g_dynamic_mfg_enabled.load(std::memory_order_relaxed);
  if (ImGui::Checkbox("使用 NVIDIA Dynamic MFG（310.9.1 + SL 2.14.1）", &dynamic_mfg)) {
    mfgunlock::framecount::g_dynamic_mfg_enabled.store(dynamic_mfg,
                                                        std::memory_order_relaxed);
    mfgunlock::framecount::NotifyDynamicModeChanged();
    reshade::set_config_value(nullptr, kConfigSection, "DynamicMFG",
                              dynamic_mfg ? 1 : 0);
  }
  int dynamic_target = static_cast<int>(
      mfgunlock::framecount::g_dynamic_target_fps.load(std::memory_order_relaxed));
  if (ImGui::InputInt("Dynamic 输出目标帧率", &dynamic_target, 1, 10)) {
    if (dynamic_target < 0) dynamic_target = 0;
    if (dynamic_target > 1000) dynamic_target = 1000;
    mfgunlock::framecount::g_dynamic_target_fps.store(
        static_cast<unsigned int>(dynamic_target), std::memory_order_relaxed);
    mfgunlock::framecount::NotifyDynamicModeChanged();
    reshade::set_config_value(nullptr, kConfigSection, "DynamicTargetFPS",
                              dynamic_target);
  }
  ImGui::TextDisabled(
      "需要 D3D12、595.41+ 驱动、DLSS-G 310.9.1 和 Streamline 2.14.1。\n"
      "0 = 显示器刷新率；使用 Streamline 原生 eDynamic 调度，不挂钩 Present。\n"
      "开启垂直同步时，Streamline 会忽略此数值并以显示器刷新率为目标。\n"
      "修改 Dynamic 设置后，请在游戏中关闭再开启帧生成。");
  if (mfgunlock::framecount::g_dynamic_change_pending.load(
          std::memory_order_acquire)) {
    ImGui::TextDisabled(
        "Dynamic 设置已修改，正在等待游戏成功调用 SetOptions。");
  }
  const uint64_t streamline_version =
      mfgunlock::framecount::g_active_streamline_version.load(std::memory_order_relaxed);
  const uint64_t dlssg_version =
      mfgunlock::framecount::g_last_dlssg_version.load(std::memory_order_relaxed);
  if (mfgunlock::framecount::g_streamline_version_seen.load(std::memory_order_acquire)) {
    ImGui::Text("Observed Streamline DLSS-G: %u.%u.%u.%u%s.",
                static_cast<unsigned int>((streamline_version >> 48u) & 0xffffu),
                static_cast<unsigned int>((streamline_version >> 32u) & 0xffffu),
                static_cast<unsigned int>((streamline_version >> 16u) & 0xffffu),
                static_cast<unsigned int>(streamline_version & 0xffffu),
                mfgunlock::framecount::g_streamline_2_14_1_active.load(
                    std::memory_order_relaxed) ? " (supported)" : " (not Dynamic-supported)");
  }
  if (mfgunlock::framecount::g_dlssg_version_seen.load(std::memory_order_acquire)) {
    ImGui::Text("Observed DLSS-G provider candidate: %u.%u.%u.%u%s.",
                static_cast<unsigned int>((dlssg_version >> 48u) & 0xffffu),
                static_cast<unsigned int>((dlssg_version >> 32u) & 0xffffu),
                static_cast<unsigned int>((dlssg_version >> 16u) & 0xffffu),
                static_cast<unsigned int>(dlssg_version & 0xffffu),
                mfgunlock::framecount::g_dlssg_310_9_1_seen.load(
                    std::memory_order_relaxed) ? " (supported candidate seen)"
                                               : " (not Dynamic-supported)");
  }
  if (render_api != DetectedRenderApi::kD3D12) {
    ImGui::TextDisabled("Dynamic MFG 不可用：当前渲染接口不是 D3D12。");
  } else if (!mfgunlock::framecount::g_streamline_version_seen.load(
                 std::memory_order_acquire) ||
             !mfgunlock::framecount::g_dlssg_version_seen.load(
                 std::memory_order_acquire)) {
    ImGui::TextDisabled("Dynamic MFG 正在等待读取已加载的 Streamline / DLSS-G 版本。");
  } else if (!mfgunlock::framecount::g_streamline_2_14_1_active.load(
                 std::memory_order_acquire) ||
             !mfgunlock::framecount::g_dlssg_310_9_1_seen.load(
                 std::memory_order_acquire)) {
    ImGui::TextDisabled("Dynamic MFG 不可用：此版本必须精确匹配 2.14.1 和 310.9.1。");
  } else if (!mfgunlock::framecount::g_dynamic_support_seen.load(
                 std::memory_order_acquire)) {
    ImGui::TextDisabled("DLSS-G 尚未报告 Dynamic MFG 支持状态。");
  } else if (!mfgunlock::framecount::g_dynamic_supported.load(
                 std::memory_order_relaxed)) {
    ImGui::TextDisabled("Dynamic MFG 不可用：当前运行库或驱动报告不支持。");
  } else if (mfgunlock::framecount::g_dynamic_applied.load(
                 std::memory_order_relaxed)) {
    ImGui::Text("Dynamic MFG active; requested target: %s.",
                dynamic_target == 0 ? "display refresh" :
                                      (std::to_string(dynamic_target) + " FPS").c_str());
  } else if (mfgunlock::framecount::g_dynamic_fell_back.load(
                 std::memory_order_relaxed)) {
    ImGui::Text("Dynamic MFG rejected (result %u); fixed MFG fallback is active.",
                mfgunlock::framecount::g_dynamic_result.load(
                    std::memory_order_relaxed));
  } else {
    ImGui::TextDisabled("Dynamic MFG supported; waiting for the next SetOptions call.");
  }
  if (!mfgunlock::framecount::g_vsync_support_seen.load(std::memory_order_acquire)) {
    ImGui::TextDisabled("DLSS-G has not reported its VSync capability yet.");
  } else if (mfgunlock::framecount::g_vsync_supported.load(
                 std::memory_order_relaxed)) {
    ImGui::TextDisabled(
        "The active DLSS-G runtime reports VSync support. Streamline 2.14.1 adds\n"
        "VSync and frame-limiter support to Dynamic MFG on compatible D3D12 systems.");
  } else {
    ImGui::TextDisabled(
        "The active DLSS-G runtime reports VSync unavailable; this can indicate\n"
        "an older/mismatched runtime or an unsupported presentation mode.");
  }
  bool reflex_source_cap =
      mfgunlock::framecount::g_dynamic_reflex_source_cap.load(
          std::memory_order_relaxed);
  if (ImGui::Checkbox("高级：用 Reflex 限制游戏实际渲染帧率",
                      &reflex_source_cap)) {
    mfgunlock::framecount::g_dynamic_reflex_source_cap.store(
        reflex_source_cap, std::memory_order_relaxed);
    mfgunlock::framecount::NotifyDynamicModeChanged();
    reshade::set_config_value(nullptr, kConfigSection,
                              "DynamicReflexSourceCap",
                              reflex_source_cap ? 1 : 0);
  }
  ImGui::TextDisabled(
      "这是源渲染帧限制，不是最终输出帧率目标。除非你已经按倍率和刷新率\n"
      "计算好渲染帧率上限，否则请保持关闭。");
  if (dynamic_mfg && dynamic_target != 0 && reflex_source_cap) {
    if (mfgunlock::framecount::g_reflex_limit_applied.load(
            std::memory_order_acquire)) {
      const unsigned int effective_us =
          mfgunlock::framecount::g_reflex_effective_limit_us.load(
              std::memory_order_relaxed);
      ImGui::Text("Reflex source-frame cap active: %u us (~%u rendered FPS); game requested %u us.",
                  effective_us,
                  effective_us == 0 ? 0u : (1000000u + effective_us / 2u) / effective_us,
                  mfgunlock::framecount::g_reflex_native_limit_us.load(
                      std::memory_order_relaxed));
    } else if (!mfgunlock::framecount::g_reflex_hooked.load(
                   std::memory_order_acquire)) {
      ImGui::TextDisabled(
          "The game has not exposed slReflexSetOptions; the advanced source cap is unavailable.");
    } else if (!mfgunlock::framecount::g_reflex_options_seen.load(
                   std::memory_order_acquire)) {
      ImGui::TextDisabled(
          "Reflex source-cap hook is ready; waiting for the game's Reflex options.");
    } else {
      ImGui::TextDisabled("Reflex source-frame cap pending (last result: %u).",
                          mfgunlock::framecount::g_reflex_limit_result.load(
                              std::memory_order_relaxed));
    }
  }

  int force = static_cast<int>(
      mfgunlock::framecount::g_force_multiplier.load(std::memory_order_relaxed));
  // 6x == numFramesToGenerate 5, which is the Streamline plugin's own hard
  // ceiling (its wrapper clamps the count to 5). Whether the runtime accepts it
  // is up to that plugin -- a refusal is logged and falls back to the game's
  // own request, so asking costs nothing.
  if (ImGui::SliderInt("固定总帧倍率（绝对值）", &force, 0, 6,
                       force == 0 ? "关闭（由游戏决定）" : "%dx")) {
    if (force != 0 && force < 2) force = 2;
    mfgunlock::framecount::g_force_multiplier.store(static_cast<unsigned int>(force),
                                                    std::memory_order_relaxed);
    mfgunlock::framecount::NotifyFixedMultiplierChanged(
        static_cast<unsigned int>(force));
    reshade::set_config_value(nullptr, kConfigSection, "ForceMultiplier", force);
  }
  ImGui::TextDisabled(
      "游戏已有 2x/3x/4x 选项时建议保持关闭；固定值会覆盖游戏内选择，\n"
      "既可能提高也可能降低倍率。Dynamic MFG 开启时优先生效。");
  const bool game_request_seen =
      mfgunlock::framecount::g_game_request_seen.load(std::memory_order_acquire);
  if (game_request_seen) {
    ImGui::Text("Game request: %ux.",
                mfgunlock::framecount::g_last_requested.load(
                    std::memory_order_relaxed) + 1);
  } else {
    ImGui::TextDisabled("Game request: not observed yet.");
  }
  if (mfgunlock::forcepolicy::IsFixedMultiplier(
          static_cast<unsigned int>(force))) {
    ImGui::Text("Addon fixed request: %dx.", force);
  } else {
    ImGui::TextDisabled("Addon fixed request: off (game decides).");
  }

  const auto fixed_status =
      static_cast<mfgunlock::forcepolicy::FixedOverrideStatus>(
          mfgunlock::framecount::g_fixed_override_status.load(
              std::memory_order_acquire));
  const bool effective_seen =
      mfgunlock::framecount::g_effective_request_seen.load(
          std::memory_order_acquire);
  const unsigned int effective_multiplier =
      mfgunlock::framecount::g_last_effective_generated.load(
          std::memory_order_relaxed) + 1;
  switch (fixed_status) {
    case mfgunlock::forcepolicy::FixedOverrideStatus::kPending:
      ImGui::TextDisabled(
          "Effective request: pending the next enabled slDLSSGSetOptions call.");
      break;
    case mfgunlock::forcepolicy::FixedOverrideStatus::kApplied:
      ImGui::Text("Effective downstream request: %ux (addon override accepted).",
                  effective_multiplier);
      break;
    case mfgunlock::forcepolicy::FixedOverrideStatus::kRejected:
      if (effective_seen) {
        ImGui::Text("Effective downstream request: %ux (game fallback).",
                    effective_multiplier);
      }
      ImGui::TextDisabled("The runtime rejected the addon's fixed request.");
      break;
    case mfgunlock::forcepolicy::FixedOverrideStatus::kBlockedByPacing:
      if (effective_seen) {
        ImGui::Text("Effective downstream request: %ux (game fallback).",
                    effective_multiplier);
      }
      ImGui::TextDisabled(
          "Addon override blocked: legacy flip pacing was not verified.");
      break;
    case mfgunlock::forcepolicy::FixedOverrideStatus::kUnsupportedAbi:
      if (effective_seen) {
        ImGui::Text("Effective downstream request: %ux (game fallback).",
                    effective_multiplier);
      }
      ImGui::TextDisabled(
          "Addon override unsupported by the game's DLSSGOptions ABI.");
      break;
    case mfgunlock::forcepolicy::FixedOverrideStatus::kDynamicPriority:
      ImGui::TextDisabled(
          "Effective multiplier: Dynamic MFG/provider-controlled; fixed request is not applied.");
      break;
    case mfgunlock::forcepolicy::FixedOverrideStatus::kMatchedGameRequest:
      ImGui::Text("Effective downstream request: %ux (already matched addon request).",
                  effective_multiplier);
      break;
    case mfgunlock::forcepolicy::FixedOverrideStatus::kNative:
    default:
      if (effective_seen) {
        ImGui::Text("Effective downstream request: %ux (game controlled).",
                    effective_multiplier);
      } else if (mfgunlock::framecount::g_hooked.load(
                     std::memory_order_acquire)) {
        ImGui::TextDisabled(
            "Effective request: waiting for an enabled slDLSSGSetOptions call.");
      }
      break;
  }
  if (!mfgunlock::framecount::g_hooked.load(std::memory_order_acquire)) {
    ImGui::TextDisabled("sl.interposer.dll not hooked (no Streamline in this game?).");
  }

  ImGui::Separator();
  bool temporal =
      g_configured_temporal_fix.load(std::memory_order_relaxed);
  if (ImGui::Checkbox("下次启动启用时序修复（避免中间帧挤压）",
                      &temporal)) {
    g_configured_temporal_fix.store(temporal, std::memory_order_relaxed);
    reshade::set_config_value(nullptr, kConfigSection, "TemporalFix", temporal ? 1 : 0);
  }
  ImGui::TextDisabled("加载时只应用一次；修改后请重启游戏。");
  if (temporal != g_temporal_fix.load(std::memory_order_relaxed)) {
    ImGui::TextDisabled("Temporal-fix change is saved for the next restart.");
  }

  bool blackwell = g_configured_blackwell_framework_kernels.load(
      std::memory_order_relaxed);
  if (ImGui::Checkbox("下次启动优先完整 Blackwell 框架内核（实验）",
                      &blackwell)) {
    g_configured_blackwell_framework_kernels.store(
        blackwell, std::memory_order_relaxed);
    reshade::set_config_value(nullptr, kConfigSection, "BlackwellFrameworkKernels",
                              blackwell ? 1 : 0);
  }
  ImGui::TextDisabled(
      "开启：验证通过时使用完整运动矢量/修复路径；关闭：使用旧版中点修正。\n"
      "修改后请重启游戏。");
  if (blackwell !=
      g_blackwell_framework_kernels.load(std::memory_order_relaxed)) {
    ImGui::TextDisabled("Kernel-path change is saved for the next restart.");
  }

  ImGui::Separator();
  ImGui::TextColored(ImVec4(1.0f, 0.78f, 0.22f, 1.0f),
                     "细小物体插帧增强（实验）");
  ImGui::TextDisabled(
      "针对细小物体与重投影的 DLSS-G 内核实验。前两项默认开启，也可分别关闭。\n"
      "修改任一选项后请重启游戏；不同游戏的效果可能不同。");

  bool intermediate_scatter =
      g_configured_thin_geometry_intermediate_scatter.load(
          std::memory_order_relaxed);
  if (ImGui::Checkbox(
          "保留中间帧分散信息（实验，推荐）##thin_intermediate",
          &intermediate_scatter)) {
    g_configured_thin_geometry_intermediate_scatter.store(
        intermediate_scatter, std::memory_order_relaxed);
    reshade::set_config_value(nullptr, kConfigSection,
                              "ThinGeometryIntermediateScatter",
                              intermediate_scatter ? 1 : 0);
  }
  ImGui::TextWrapped(
      "默认开启。DLSS-G 为中间生成帧构建运动矢量时，适当放宽一项运动一致性拒绝，\n"
      "独立深度测试仍保留。可能改善栅栏、植被和移动边缘；若出现拖影、鬼影或\n"
      "遮挡边缘异常，请关闭。");

  bool validated_warp =
      g_configured_thin_geometry_validated_warp_blend.load(
          std::memory_order_relaxed);
  if (ImGui::Checkbox(
          "经校验的变形混合（实验，推荐）##thin_validated_warp",
          &validated_warp)) {
    g_configured_thin_geometry_validated_warp_blend.store(
        validated_warp, std::memory_order_relaxed);
    reshade::set_config_value(nullptr, kConfigSection,
                              "ThinGeometryValidatedWarpBlend",
                              validated_warp ? 1 : 0);
  }
  ImGui::TextWrapped(
      "默认开启。后期混合实验会先检查候选范围、颜色有效性和相互一致性，\n"
      "再逐步增加对合格变形颜色的权重。可能减少闪烁，但某些场景也可能增加残影。");

  bool previous_scatter =
      g_configured_thin_geometry_previous_scatter.load(
          std::memory_order_relaxed);
  if (ImGui::Checkbox(
          "保留上一帧到当前帧的分散信息（实验/不稳定）##thin_previous",
          &previous_scatter)) {
    g_configured_thin_geometry_previous_scatter.store(
        previous_scatter, std::memory_order_relaxed);
    reshade::set_config_value(nullptr, kConfigSection,
                              "ThinGeometryPreviousScatter",
                              previous_scatter ? 1 : 0);
  }
  ImGui::TextDisabled(
      "高级研究选项，默认关闭。它会改变真实帧之间的运动拒绝，早期游戏测试不稳定。\n"
      "不建议日常使用；边界逻辑不会改变。");

  if (validated_warp !=
          g_thin_geometry_validated_warp_blend.load(std::memory_order_relaxed) ||
      previous_scatter !=
          g_thin_geometry_previous_scatter.load(std::memory_order_relaxed) ||
      intermediate_scatter !=
          g_thin_geometry_intermediate_scatter.load(std::memory_order_relaxed)) {
    ImGui::TextDisabled(
        "细小物体选项已保存，下次启动生效。");
  }

  const auto show_thin_result = [](const char* label,
                                   const mfgunlock::thingeometry::MechanismResult& result) {
    if (!result.requested) return;
    if (result.applied) {
      ImGui::TextWrapped("%s: applied (%s).", label, result.detail.c_str());
    } else {
      ImGui::TextDisabled("%s: not applied (%s).", label,
                          result.detail.empty() ? "waiting for a supported provider"
                                                : result.detail.c_str());
    }
  };
  if (thin_geometry_provider_count != 0) {
    ImGui::TextDisabled("Validated provider result: %s; processed provider(s): %zu.",
                        thin_geometry_last.provider_version.empty()
                            ? "unsupported/unknown"
                            : thin_geometry_last.provider_version.c_str(),
                        thin_geometry_provider_count);
    show_thin_result("Validated warp blend",
                     thin_geometry_last.result.validated_warp_blend);
    show_thin_result("Previous scatter retention",
                     thin_geometry_last.result.previous_scatter);
    show_thin_result("Intermediate scatter retention",
                     thin_geometry_last.intermediate_scatter);
  } else if (g_thin_geometry_validated_warp_blend.load(
                 std::memory_order_relaxed) ||
             g_thin_geometry_previous_scatter.load(std::memory_order_relaxed) ||
             g_thin_geometry_intermediate_scatter.load(
                 std::memory_order_relaxed)) {
    ImGui::TextDisabled("Waiting for a supported DLSS-G provider (attempt %d).",
                        g_thin_geometry_attempts.load(std::memory_order_relaxed));
  }
  if (thin_geometry_patched) {
    ImGui::TextDisabled(
        "At least one thin-geometry mechanism passed exact validation this session.");
  }

  ImGui::Separator();
  if (blackwell_patched) {
    ImGui::TextWrapped("Blackwell framework kernels: %zu provider(s); last result: %s.",
                       blackwell_provider_count, blackwell_detail.c_str());
  } else if (midpoint_patched) {
    ImGui::TextWrapped("Temporal fix: %zu provider(s); last result: %s.",
                       midpoint_provider_count, midpoint_detail.c_str());
    if (g_blackwell_framework_kernels.load(std::memory_order_relaxed) &&
        !blackwell_detail.empty()) {
      ImGui::TextDisabled("Full Blackwell path fell back safely: %s.",
                          blackwell_detail.c_str());
    }
  } else {
    ImGui::TextDisabled("Temporal fix not applied yet (attempt %d).",
                        g_midpoint_attempts.load(std::memory_order_relaxed));
  }

  ImGui::Separator();
  if (mfgunlock::loadhook::g_hooked.load(std::memory_order_acquire)) {
    ImGui::Text("Load-time trigger armed (%u snippet load(s) caught).",
                mfgunlock::loadhook::g_catches.load(std::memory_order_relaxed));
  } else {
    ImGui::TextDisabled("Load-time trigger not installed.");
  }
  if (g_discovery_worker_running.load(std::memory_order_acquire)) {
    ImGui::TextDisabled("Bounded fallback discovery running (%u/%u passes; no Present polling).",
                        g_discovery_worker_passes.load(std::memory_order_relaxed),
                        kDiscoveryRetryLimit);
  } else if (g_discovery_worker_finished.load(std::memory_order_acquire)) {
    if (DiscoveryRequirementsMet()) {
      ImGui::TextDisabled("Bounded fallback discovery complete; no Present polling is active.");
    } else {
      ImGui::TextDisabled("Bounded fallback discovery finished; waiting on load-time triggers.");
    }
  }

  ImGui::Separator();
  if (gate_patched) {
    ImGui::Text("DLSS-G arch gates rewritten: %zu provider(s), %zu site(s).",
                gate_provider_count, gate_site_count);
  } else {
    ImGui::TextDisabled("DLSS-G snippet not located yet (attempt %d) -- enable frame generation.",
                        g_gate_attempts.load(std::memory_order_relaxed));
  }

  ImGui::Separator();
  ImGui::TextDisabled("Legacy NGX parameter-vtable override disabled; using verified code gates.");
}
