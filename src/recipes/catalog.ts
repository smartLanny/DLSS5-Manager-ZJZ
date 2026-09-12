import { Failures } from "../failures.js";
import { getComponent, resolvePin } from "../pin/load.js";
import type { PinManifest, Recipe } from "../types.js";

export function listRecipes(manifest: PinManifest): Recipe[] {
  const mfg = resolvePin(getComponent(manifest, "mfg-unlock"));
  const nr = resolvePin(getComponent(manifest, "nvngx-dlssnr"));
  const bridgeBg3 = resolvePin(getComponent(manifest, "bridge"), "bg3");

  return [
    {
      id: "bg3",
      title: "Baldur's Gate 3",
      gameId: "bg3",
      pins: {
        bridge: bridgeBg3,
        "mfg-unlock": mfg,
        "nvngx-dlssnr": nr,
      },
      optionalSlots: ["feeder", "d14-core"],
      notes: "Bridge 钉 1.4.11（lab #224）。不跟 1.4.13-pre。D14 Core 选择是可选模块，默认不装。",
    },
    {
      id: "generic-dlss",
      title: "通用 DLSS 配方（发现后再绑）",
      pins: {
        "mfg-unlock": mfg,
        "nvngx-dlssnr": nr,
      },
      optionalSlots: ["bridge", "feeder", "mfg-dlc", "d14-core"],
      notes: "先发现游戏再填 Bridge pin。禁止预置 800MB+ 全家桶。",
    },
  ];
}

export function getRecipe(manifest: PinManifest, id: string): Recipe {
  const found = listRecipes(manifest).find((recipe) => recipe.id === id);
  if (!found) throw Failures.recipeUnknown(id);
  return found;
}
