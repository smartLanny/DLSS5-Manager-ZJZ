import type { FailureShape } from "./types.js";

export class ManagerError extends Error {
  readonly code: string;
  readonly hint: string;

  constructor(code: string, message: string, hint: string) {
    super(message);
    this.name = "ManagerError";
    this.code = code;
    this.hint = hint;
  }

  toJSON(): FailureShape {
    return { code: this.code, message: this.message, hint: this.hint };
  }

  format(): string {
    return `[${this.code}] ${this.message}\n提示：${this.hint}`;
  }
}

export const Failures = {
  pinNotFound(id: string): ManagerError {
    return new ManagerError(
      "PIN_NOT_FOUND",
      `找不到组件 pin：${id}`,
      "对照 config/pins.json 与 docs/DLC-PIN.md；不要猜测 latest。",
    );
  },
  bridgeLatestForbidden(requested: string): ManagerError {
    return new ManagerError(
      "BRIDGE_LATEST_FORBIDDEN",
      `Bridge 拒绝 ${requested}。BG3 钉在 1.4.11。`,
      "lab #224：Bridge 必须可 pin，禁止无脑 latest / 1.4.13-pre。改配方或 pin 表，不要改 updater 去跟源站。",
    );
  },
  binaryForbidden(kind: string): ManagerError {
    return new ManagerError(
      "BINARY_FORBIDDEN",
      `本开源壳不嵌入 ${kind}。`,
      "NVIDIA DLL、专有 NR kernel、签名私钥都不进本仓。只维护 pin 与更新源；二进制走外链缓存。",
    );
  },
  labCoreOutOfScope(topic: string): ManagerError {
    return new ManagerError(
      "LAB_CORE_OUT_OF_SCOPE",
      `${topic} 属于 lab Core / 私有面，不在本 MIT 壳落地。`,
      "多 hook（lab #190）与 mgr #27/#28（lab PR #251）留在私有 lab，待 Windows 复测。本仓不宣称已修。",
    );
  },
  optionalDisabled(moduleId: string): ManagerError {
    return new ManagerError(
      "OPTIONAL_MODULE_DISABLED",
      `可选模块未启用：${moduleId}`,
      "米哈游钩子、反馈打包、MFG 槽、D14 Core 选择见 docs/OPTIONAL-MODULES.md。默认不覆盖旧发行线。",
    );
  },
  recipeUnknown(id: string): ManagerError {
    return new ManagerError(
      "RECIPE_UNKNOWN",
      `没有名为 ${id} 的配方。`,
      "运行 recipes 查看已登记配方。新游戏先加 recipe，再绑 pin，不要塞全家桶。",
    );
  },
  downloadBlocked(reason: string): ManagerError {
    return new ManagerError(
      "DOWNLOAD_BLOCKED",
      `更新下载被拦住：${reason}`,
      "默认只检查元数据。确认 pin 与用户同意后，才允许把外链二进制写入本机缓存。",
    );
  },
  manifestInvalid(reason: string): ManagerError {
    return new ManagerError(
      "MANIFEST_INVALID",
      `pin 清单无效：${reason}`,
      "schemaVersion 必须为 1，且 MFG 默认 pin 为 0.9、Bridge/BG3 为 1.4.11。",
    );
  },
} as const;

export function formatUnknown(error: unknown): string {
  if (error instanceof ManagerError) return error.format();
  if (error instanceof Error) return `[UNEXPECTED] ${error.message}`;
  return `[UNEXPECTED] ${String(error)}`;
}
