#!/usr/bin/env node
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const blockedExt = new Set([
  ".dll",
  ".exe",
  ".addon64",
  ".dlss5pkg",
  ".pdb",
  ".pem",
  ".p12",
  ".pfx",
]);
const blockedName = [/nvngx/i, /nr[-_]?kernel/i, /signing[-_]?key/i];
const skipDir = new Set([".git", "node_modules", "dist"]);

const found = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (skipDir.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
      continue;
    }
    const rel = relative(root, full);
    const lower = entry.toLowerCase();
    const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
    if (blockedExt.has(ext) || blockedName.some((re) => re.test(rel))) {
      found.push(rel);
    }
  }
}

walk(root);

if (found.length > 0) {
  console.error("拒绝提交专有/二进制载荷：");
  for (const file of found) console.error(`  ${file}`);
  process.exit(1);
}

console.log("payload check ok：树内无 DLL / addon / 签名材料。");
