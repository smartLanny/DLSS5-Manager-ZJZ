import { resolvePin } from "../pin/load.js";
import type { FetchPlan, PinManifest } from "../types.js";

export function describeFetch(manifest: PinManifest, gameId?: string): FetchPlan[] {
  return manifest.components.map((component) => {
    const pin = resolvePin(component, gameId);
    const source = component.updateSource;
    const how = howToFetch(component.id, source.kind, pin);
    return {
      componentId: component.id,
      displayName: component.displayName,
      pin,
      method: "GET",
      metadataUrl: source.metadataUrl,
      pageUrl: source.pageUrl,
      downloadsBinaries: false,
      autoApply: false,
      cadenceHours: manifest.checkCadence.periodicHours,
      how,
    };
  });
}

function howToFetch(id: string, kind: string, pin: string): string {
  switch (kind) {
    case "github-releases":
      return `对 metadataUrl 发 GET（GitHub Releases JSON）。对照 tag 与 pin=${pin}；只报告，不下载 zip/addon，不自动改 pin。`;
    case "pin-manifest":
      return `GET 本仓 pins.json。${id} 以配方/游戏 pin 为准，忽略源站 latest。`;
    case "changelog-gate":
      return `无默认下载根。仅当配方 changelog 开门后才检查；主 OTA 可省略 ${id}。`;
    case "rhi-or-nvidia":
      return `类 RHI：若日后接入公开目录则只拉版本条目。当前场上 pin=${pin}，无证据不 bump；绝不把 NVIDIA DLL 拉进仓库。`;
    default:
      return `未知源类型 ${kind}：保持 pin=${pin}，不做下载。`;
  }
}
