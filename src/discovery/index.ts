import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GameCandidate } from "../types.js";

export interface DiscoveryPlan {
  stores: Array<{ store: "steam" | "epic" | "manual"; roots: string[]; readable: string[] }>;
  games: GameCandidate[];
  notes: string[];
}

function unique(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))];
}

export function steamRoots(home = homedir(), platform = process.platform): string[] {
  if (platform === "win32") {
    return unique([
      "C:\\Program Files (x86)\\Steam",
      "C:\\Program Files\\Steam",
      join(home, "Steam"),
    ]);
  }
  return unique([
    join(home, ".steam", "steam"),
    join(home, ".local", "share", "Steam"),
    join(home, ".var", "app", "com.valvesoftware.Steam", "data", "Steam"),
  ]);
}

export function epicRoots(home = homedir(), platform = process.platform): string[] {
  if (platform === "win32") {
    return unique(["C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests"]);
  }
  return unique([
    join(home, ".local", "share", "Epic", "EpicGamesLauncher", "Data", "Manifests"),
    join(home, ".config", "Epic", "EpicGamesLauncher", "Data", "Manifests"),
  ]);
}

export function planDiscovery(): DiscoveryPlan {
  const steam = steamRoots();
  const epic = epicRoots();
  return {
    stores: [
      { store: "steam", roots: steam, readable: steam.filter((p) => existsSync(p)) },
      { store: "epic", roots: epic, readable: epic.filter((p) => existsSync(p)) },
      { store: "manual", roots: [], readable: [] },
    ],
    games: [],
    notes: [
      "本环境多半没有 Steam/Epic 库；壳先报扫描根，不假装发现了游戏。",
      "Windows 产品线再解析 libraryfolders.vdf 与 Epic manifest；此处不复制 ARR 管理器实现。",
      "手动游戏：传入 EXE 路径即可绑定配方，不要求玩家填 SHA。",
    ],
  };
}
