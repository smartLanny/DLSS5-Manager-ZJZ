import type { Recipe } from "../types.js";

export type GameApi = "dx9" | "dx10" | "dx11" | "dx12" | "vulkan" | "opengl";
export type GameArch = "x86" | "x64";
export type BridgeComponent = "bridge" | "feeder";

/** Package metadata, NOT proof that a binary is authenticated or game-tested. */
export interface BridgeDlc {
  component: BridgeComponent;
  version: string;
  variant: string;
  sha256: string;
  gameApis: GameApi[];
  gameArchitectures: GameArch[];
  consumerInterface: string;
  compatibleCoreBuilds: string[];
  x64HostIncluded: boolean;
  licenseNoticeFiles: string[];
}
export interface BridgeContext {
  enabled: boolean;
  gameApi: GameApi | "unknown";
  architecture: GameArch | "unknown";
  // Requires real input evidence, not merely finding a DLSS DLL on disk.
  nativeInputs: "usable" | "absent" | "unknown";
  core: { buildId: string; inputInterfaces: string[]; nativeD3D12: boolean };
  packages: BridgeDlc[];
  selectedVariant?: string;
}
export interface BridgePlan {
  state: "not-requested" | "native" | "candidate" | "blocked";
  component: BridgeComponent | null;
  selected: { version: string; variant: string; sha256: string } | null;
  code: string;
  message: string;
  dryRun: true;
  installAuthorized: false;
  preservesOriginal: true;
  requiredChecks: string[];
}
const APIS = new Set<string>(["dx9", "dx10", "dx11", "dx12", "vulkan", "opengl"]);
const ARCHES = new Set<string>(["x86", "x64"]);
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200 && v.trim() === v;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= 128 && v.every(text);
const version = (v: unknown): v is string => text(v) && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(v);
const noticePath = (v: string): boolean =>
  !v.includes("\\") && !v.includes(":") && !v.startsWith("/") &&
  v.split("/").every(p => p !== "." && p !== ".." && /^[A-Za-z0-9_.-]+$/.test(p));

function result(state: BridgePlan["state"], code: string, message: string,
                component: BridgeComponent | null = null, pkg?: BridgeDlc): BridgePlan {
  return {
    state, code, message, component,
    selected: pkg ? { version: pkg.version, variant: pkg.variant, sha256: pkg.sha256.toLowerCase() } : null,
    dryRun: true, installAuthorized: false, preservesOriginal: true,
    requiredChecks: state === "candidate" ? [
      "Authenticate the approved manifest and hash the actual cached package bytes",
      "Review every bundled file's redistribution terms and preserve notices",
      "Recheck Core build/interface, game API/bitness and helper identity before installation",
      "Require game closed; one active input bridge; journal/backup/rollback before writes",
      "Verify actual provider Query/readiness and frame/resource contracts in the game",
    ] : [],
  };
}

/** Pure, fail-closed metadata plan. Never loads a DLL, downloads, or changes pins.
 * Multiple cached versions are allowed; exactly one pinned compatible variant wins.
 * Missing optional providers block only this requested route, not native rendering.
 */
export function planBridgeDlc(recipe: Recipe, input?: unknown): BridgePlan {
  if (input === undefined || (record(input) && input.enabled === false))
    return result("not-requested", "BRIDGE_NOT_REQUESTED", "桥接 DLC 未启用，保留原生路线/原图。");
  if (!record(input) || input.enabled !== true || !text(input.gameApi) || !APIS.has(input.gameApi) ||
      !text(input.architecture) || !ARCHES.has(input.architecture) ||
      (input.nativeInputs !== "usable" && input.nativeInputs !== "absent"))
    return result("blocked", "BRIDGE_INPUT_UNKNOWN", "API、位数或原生输入证据不足；不猜测安装路线。");
  const core = input.core;
  if (!record(core) || !text(core.buildId) || !Array.isArray(core.inputInterfaces) ||
      !core.inputInterfaces.every(text) || core.inputInterfaces.length > 128 || typeof core.nativeD3D12 !== "boolean")
    return result("blocked", "BRIDGE_CORE_UNKNOWN", "缺少明确的 Core 构建与输入接口信息，不能把旧配套直接换成新版。");
  if (input.nativeInputs === "usable" && input.gameApi === "dx12" &&
      input.architecture === "x64" && core.nativeD3D12)
    return result("native", "BRIDGE_NATIVE_PREFERRED", "原生 D3D12 输入优先；不要求 Feeder，也不附加光流/SR。");

  const interfaces = core.inputInterfaces;
  const coreBuild = core.buildId;
  const component: BridgeComponent = input.nativeInputs === "usable" ? "bridge" : "feeder";
  const pin = recipe.pins[component];
  if (!version(pin) || (component === "bridge" && pin.startsWith("1.4.13-pre")))
    return result("blocked", "BRIDGE_PIN_REQUIRED", "所需桥接器必须使用已批准的固定版本，不能使用 latest/未准入候选。", component);
  if (recipe.gameId === "bg3" && component === "bridge" && pin !== "1.4.11")
    return result("blocked", "BRIDGE_GAME_PIN", "此配方已有 BG3 Bridge 1.4.11 固定要求，不由 DLC 目录提升版本。", component);
  if (!Array.isArray(input.packages) || input.packages.length > 128)
    return result("blocked", "BRIDGE_PACKAGES_INVALID", "DLC 元数据目录无效。", component);
  if (input.selectedVariant !== undefined && !text(input.selectedVariant))
    return result("blocked", "BRIDGE_VARIANT_INVALID", "桥接变体选择无效。", component);

  const candidates = input.packages.filter(p => record(p) && p.component === component && p.version === pin &&
    (input.selectedVariant === undefined || p.variant === input.selectedVariant));
  if (candidates.length === 0)
    return result("blocked", "BRIDGE_PACKAGE_MISSING", "未找到固定版本的输入 DLC；保留原图，请准备对应组件。", component);
  const valid = candidates.filter((p): p is BridgeDlc => {
    if (!record(p)) return false;
    return text(p.variant) && typeof p.sha256 === "string" && /^[a-fA-F0-9]{64}$/.test(p.sha256) && !/^0{64}$/.test(p.sha256) &&
      strings(p.gameApis) && p.gameApis.every(api => APIS.has(api)) && p.gameApis.includes(input.gameApi as GameApi) &&
      strings(p.gameArchitectures) && p.gameArchitectures.every(arch => ARCHES.has(arch)) && p.gameArchitectures.includes(input.architecture as GameArch) &&
      text(p.consumerInterface) && interfaces.includes(p.consumerInterface) &&
      strings(p.compatibleCoreBuilds) && p.compatibleCoreBuilds.includes(coreBuild) &&
      typeof p.x64HostIncluded === "boolean" && (input.architecture !== "x86" || p.x64HostIncluded) &&
      strings(p.licenseNoticeFiles) && p.licenseNoticeFiles.every(noticePath);
  });
  if (valid.length !== candidates.length)
    return result("blocked", "BRIDGE_CONTRACT_MISMATCH", "桥接包的 API、位数、Core 接口/构建、宿主、摘要或许可证清单不匹配。", component);
  if (valid.length !== 1)
    return result("blocked", "BRIDGE_VARIANT_AMBIGUOUS", "同一 pin 存在多个变体；请明确选择，不按目录顺序猜测。", component);
  return result("candidate", "BRIDGE_METADATA_MATCH", "仅配套元数据匹配；未授权安装，未证明实际加载或游戏兼容。", component, valid[0]);
}
