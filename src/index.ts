#!/usr/bin/env node
import { listPinnedComponents } from "./components/list.js";
import { planDiscovery } from "./discovery/index.js";
import { formatUnknown, ManagerError } from "./failures.js";
import { OPTIONAL_MODULES, requireOptional, type OptionalModuleId } from "./optional/modules.js";
import { loadPinManifest } from "./pin/load.js";
import { getRecipe, listRecipes } from "./recipes/catalog.js";
import { planInstall, planUninstall } from "./recipes/install.js";
import { checkUpdates, refuseBinaryDownload } from "./updater/check.js";
import { describeFetch } from "./updater/plan.js";

function print(title: string, value: unknown): void {
  console.log(title);
  console.log(JSON.stringify(value, null, 2));
}

function usage(): string {
  return `DLSS5-Manager-ZJZ 开源壳（MIT）

用法：
  dlss5-manager-zjz pins [--game bg3]
  dlss5-manager-zjz check [--live] [--game bg3]
  dlss5-manager-zjz discover
  dlss5-manager-zjz recipes
  dlss5-manager-zjz install <recipe-id>
  dlss5-manager-zjz uninstall <recipe-id>
  dlss5-manager-zjz optional
  dlss5-manager-zjz help

默认只列 pin、说明如何拉取元数据。--live 才访问更新源 JSON。
本仓不嵌入 NVIDIA DLL / NR kernel / 签名逻辑。
mgr #27/#28 仍在 lab PR #251，此处不宣称已修。`;
}

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function opt(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0] ?? "help";
  const rest = argv.slice(1);

  if (command === "help" || command === "-h" || command === "--help") {
    console.log(usage());
    return 0;
  }

  const manifest = loadPinManifest();
  const gameId = opt(rest, "--game");

  switch (command) {
    case "pins":
      print("当前 pin", {
        updatedAt: manifest.updatedAt,
        cadence: manifest.checkCadence,
        components: listPinnedComponents(manifest, gameId),
      });
      return 0;
    case "check": {
      const plans = describeFetch(manifest, gameId);
      const reports = await checkUpdates(manifest, { live: flag(rest, "--live"), gameId });
      print("更新检查（元数据）", { plans, reports });
      return 0;
    }
    case "discover":
      print("游戏发现计划", planDiscovery());
      return 0;
    case "recipes":
      print("配方", listRecipes(manifest));
      return 0;
    case "install": {
      const id = rest[0];
      if (!id || id.startsWith("-")) throw new ManagerError("RECIPE_UNKNOWN", "请指定配方 id。", usage());
      print("安装（dry-run）", planInstall(getRecipe(manifest, id)));
      return 0;
    }
    case "uninstall": {
      const id = rest[0];
      if (!id || id.startsWith("-")) throw new ManagerError("RECIPE_UNKNOWN", "请指定配方 id。", usage());
      print("卸载（dry-run）", planUninstall(getRecipe(manifest, id)));
      return 0;
    }
    case "optional": {
      const id = rest[0];
      if (id && !id.startsWith("-")) requireOptional(id as OptionalModuleId);
      print("可选模块（默认关闭）", OPTIONAL_MODULES);
      return 0;
    }
    case "download":
      refuseBinaryDownload(rest[0] ?? "DLC 二进制");
      return 2;
    default:
      console.error(usage());
      return 2;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(formatUnknown(error));
    process.exitCode = 1;
  },
);
