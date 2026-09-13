#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// URL.pathname is `/C:/...` on Windows. fileURLToPath is required here or
// the guard scans the wrong tree when invoked by npm on a Windows checkout.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const blockedExt = new Set([
  ".dll", ".exe", ".asi", ".addon32", ".addon64", ".dlss5pkg", ".pdb",
  ".pem", ".p12", ".pfx", ".key", ".secret",
]);
const blockedName = [
  /nvngx/i,
  /nr[-_]?kernel/i,
  /private[-_ ]?key/i,
  /signing[-_ ]?key/i,
  /trusted[-_ ]?keys?/i,
];
const skippedDirectories = new Set([
  ".git", "node_modules", "dist", "release", "releases", "deliveries",
  ".packaging-stage", "coverage", "build", "out", "output",
]);
const allowedGeneratedPrefixes = ["desktop/.packaging-stage/", "desktop/dist-external/"];
const privateKeyHeader = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;
const found = [];

function slash(value) { return value.replaceAll("\\", "/"); }
function relativePath(full) { return slash(relative(root, full)); }
function isAllowedGenerated(relativeName) {
  return allowedGeneratedPrefixes.some(prefix => relativeName.startsWith(prefix));
}
function looksBlocked(relativeName, entryName) {
  const lower = entryName.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot) : "";
  return blockedExt.has(ext) || blockedName.some(pattern => pattern.test(relativeName));
}
function scanTextForPrivateKey(full, relativeName, stat) {
  if (stat.size > 4 * 1024 * 1024 || /\.(?:png|jpg|jpeg|gif|webp|ico|zip|7z|tar|gz)$/i.test(full)) return;
  let text;
  try { text = readFileSync(full, "utf8"); } catch { return; }
  if (privateKeyHeader.test(text)) found.push({ file: relativeName, reason: "private-key-material" });
}
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const full = resolve(dir, entry.name);
    const rel = relativePath(full);
    if (isAllowedGenerated(`${rel}/`)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.isFile()) continue;
    const stat = lstatSync(full);
    if (looksBlocked(rel, entry.name)) found.push({ file: rel, reason: "binary-or-secret-name" });
    else scanTextForPrivateKey(full, rel, stat);
  }
}

// Scan the working tree while skipping generated/package output. This covers
// both tracked source and newly imported source files before they are staged.
walk(root);

// A tracked payload must never be hidden under an output directory exemption.
// This catches a future force-added DLL in the otherwise ignored stage.
let tracked = new Set();
try {
  const output = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "buffer", windowsHide: true });
  tracked = new Set(output.toString("utf8").split("\0").filter(Boolean).map(slash));
} catch {
  // An exported source tree without git is still checked by the filesystem walk.
}
for (const file of tracked) {
  const name = file.split("/").at(-1) || "";
  if (looksBlocked(file, name) && isAllowedGenerated(`${file}/`)) found.push({ file, reason: "tracked-payload-in-generated-output" });
}

if (found.length > 0) {
  console.error("拒绝提交专有/二进制载荷或签名材料：");
  for (const row of found) console.error(`  ${row.file} (${row.reason})`);
  process.exit(1);
}

console.log("payload check ok：源码树无 DLL / Addon / NVIDIA runtime / 签名材料（合法 stage 与 release 输出已跳过）。");
