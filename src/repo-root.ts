import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function findRepoRoot(start = fileURLToPath(new URL(".", import.meta.url))): string {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "config", "pins.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("找不到仓库根（需要 package.json 与 config/pins.json）。");
}
