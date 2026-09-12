import { Failures } from "../failures.js";
import type { Recipe } from "../types.js";
import { planBridgeDlc, type BridgePlan } from "./bridge.js";

export interface RecipeAction {
  op: "install" | "uninstall";
  recipeId: string;
  dryRun: true;
  steps: string[];
  refused: string[];
  bridge?: BridgePlan;
}

export function planInstall(recipe: Recipe, bridgeContext?: unknown): RecipeAction {
  if (recipe.pins.bridge === "latest" || recipe.pins.bridge === "1.4.13-pre") {
    throw Failures.bridgeLatestForbidden(recipe.pins.bridge);
  }

  const steps = [
    `解析配方 ${recipe.id}（${recipe.title}）`,
    `应用 pin：${Object.entries(recipe.pins).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    "检查目标目录是否可写、是否被占用（只读探测）",
    "按 pin 向本机缓存索取外链 DLC（本 stub 不下载）",
    "事务：先备份再写入；失败可读并保留回滚入口",
  ];

  const refused = [
    "不把 NVIDIA DLL / NR kernel 写入本仓库",
    "不执行私有签名或防再分发逻辑",
    "不在此落地 lab #190 多 hook Core 兼容",
    "不宣称 mgr #27/#28 已修（仍在 lab PR #251）",
  ];

  if (recipe.optionalSlots.includes("d14-core")) {
    refused.push("D14 Core 选择保持可选，默认跳过");
  }

  const bridge = bridgeContext === undefined ? undefined : planBridgeDlc(recipe, bridgeContext);
  if (bridge) {
    if (bridge.state === "blocked") {
      steps.splice(0, steps.length, "仅报告可选桥接 DLC 拒绝原因；不执行安装，原游戏与现有 Core 保持不变。");
      refused.push(`[${bridge.code}] ${bridge.message}`);
    } else {
      steps.push(`[${bridge.code}] ${bridge.message}`, ...bridge.requiredChecks);
    }
  }
  return { op: "install", recipeId: recipe.id, dryRun: true, steps, refused,
    ...(bridge ? { bridge } : {}) };
}

export function planUninstall(recipe: Recipe): RecipeAction {
  return {
    op: "uninstall",
    recipeId: recipe.id,
    dryRun: true,
    steps: [
      `按配方 ${recipe.id} 查找本机事务日志`,
      "恢复首次 Original Backup，不二次覆盖备份",
      "可选槽（Feeder / MFG / D14）仅移除本壳写入的文件",
    ],
    refused: ["不会删除游戏本体或玩家存档", "不会从本仓取出任何二进制（本来就没有）"],
  };
}
