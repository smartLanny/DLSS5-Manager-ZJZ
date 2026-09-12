import { Failures } from "../failures.js";

export type OptionalModuleId = "mihoyo-hooks" | "feedback-packaging" | "mfg-dlc-slot" | "d14-core";

export interface OptionalModule {
  id: OptionalModuleId;
  title: string;
  enabled: false;
  summary: string;
}

export const OPTIONAL_MODULES: OptionalModule[] = [
  {
    id: "mihoyo-hooks",
    title: "米哈游专属管理钩子",
    enabled: false,
    summary: "启动器路径、反作弊提示、专属反馈分流仍可在私有/ARR 发行线。本壳只保留挂钩点，不覆盖旧构建。",
  },
  {
    id: "feedback-packaging",
    title: "反馈打包",
    enabled: false,
    summary: "只读、脱敏、不自动开 Issue。契约概念对齐公开 Manager 的反馈文档，但不复制 ARR 源码。",
  },
  {
    id: "mfg-dlc-slot",
    title: "MFG DLC 槽",
    enabled: false,
    summary: "槽位默认绑定 MFG Unlock 0.9；0.7 仅回滚。下载走 pin 源，不进树。",
  },
  {
    id: "d14-core",
    title: "D14 Core 选择",
    enabled: false,
    summary: "Core 发版在 lab。本壳只记录“可选选择”，不把 #190 兼容工作倒进此仓。",
  },
];

export function requireOptional(id: OptionalModuleId): never {
  if (id === "d14-core" || id === "mihoyo-hooks") {
    throw Failures.labCoreOutOfScope(id);
  }
  throw Failures.optionalDisabled(id);
}
