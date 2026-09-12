import { resolvePin } from "../pin/load.js";
import { describeFetch } from "../updater/plan.js";
import type { PinManifest } from "../types.js";

export interface ComponentRow {
  id: string;
  displayName: string;
  slot: string;
  pin: string;
  rollbacks: string[];
  source: string;
  wouldFetch: string;
}

export function listPinnedComponents(manifest: PinManifest, gameId?: string): ComponentRow[] {
  const plans = describeFetch(manifest, gameId);
  return manifest.components.map((component) => {
    const plan = plans.find((item) => item.componentId === component.id);
    const page = component.updateSource.pageUrl ?? "(无公开页)";
    return {
      id: component.id,
      displayName: component.displayName,
      slot: component.slot,
      pin: resolvePin(component, gameId),
      rollbacks: component.rollbacks ?? [],
      source: `${component.updateSource.kind} ${page}`,
      wouldFetch: plan?.how ?? "保持 pin，不下载。",
    };
  });
}
