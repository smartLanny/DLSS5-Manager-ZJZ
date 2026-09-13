import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const cli = fileURLToPath(new URL("../src/index.js", import.meta.url));
function run(args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 10000 });
  assert.ifError(r.error);
  return r;
}
function contextRun(value: unknown, recipe = "generic-dlss") {
  const dir = mkdtempSync(join(tmpdir(), "bridge-cli-"));
  try {
    const file = join(dir, "context with spaces.json");
    const bytes = JSON.stringify(value);
    writeFileSync(file, bytes);
    const r = run(["install", recipe, "--bridge-context", file]);
    assert.equal(readFileSync(file, "utf8"), bytes);
    return r;
  } finally { rmSync(dir, { force: true, recursive: true }); }
}
test("actual CLI passes explicit native evidence through the planner, without Feeder", () => {
  const r = contextRun({ enabled: true, gameApi: "dx12", architecture: "x64", nativeInputs: "usable",
    core: { buildId: "fixture", inputInterfaces: [], nativeD3D12: true }, packages: [] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /BRIDGE_NATIVE_PREFERRED/);
  assert.match(r.stdout, /"installAuthorized": false/);
  assert.match(r.stdout, /"contextSha256": "[a-f0-9]{64}"/);
});
test("actual CLI leaves the optional disabled route inert", () => {
  const r = contextRun({ enabled: false }); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /BRIDGE_NOT_REQUESTED/);
});
test("actual CLI returns failure for unknown inputs, not a successful installation", () => {
  const r = contextRun({ enabled: true, nativeInputs: "unknown" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /BRIDGE_INPUT_UNKNOWN/);
  assert.doesNotMatch(r.stdout, /"state": "candidate"/);
});
test("actual CLI retains the legacy one-argument dry-run", () => {
  const r = run(["install", "bg3"]); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"dryRun": true/);
  assert.doesNotMatch(r.stdout, /contextSha256/);
});
test("actual CLI does not silently ignore an incomplete option", () => {
  const r = run(["install", "bg3", "--bridge-context"]);
  assert.equal(r.status, 1); assert.match(r.stderr, /BRIDGE_CONTEXT_INVALID/);
});
test("actual CLI rejects malformed context without exposing its contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-cli-error-"));
  try {
    const file = join(dir, "invalid.json"); writeFileSync(file, '{"private": secret-marker-DO-NOT-ECHO}');
    const r = run(["install", "bg3", "--bridge-context", file]);
    assert.equal(r.status, 1); assert.match(r.stderr, /BRIDGE_CONTEXT_INVALID/);
    assert.doesNotMatch(r.stderr + r.stdout, /secret-marker/);
  } finally { rmSync(dir, { force: true, recursive: true }); }
});
