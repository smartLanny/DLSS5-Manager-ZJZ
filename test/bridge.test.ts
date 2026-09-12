import test from "node:test";
import assert from "node:assert/strict";
import { planBridgeDlc, type BridgeContext, type BridgeDlc } from "../src/recipes/bridge.js";
import { planInstall, planUninstall } from "../src/recipes/install.js";
import type { Recipe } from "../src/types.js";

// Pure metadata fixtures, not distributed binaries or verified game profiles.
const recipe: Recipe = {
  id: "fixture", title: "fixture", pins: { feeder: "0.15.1", bridge: "1.4.12" },
  optionalSlots: ["bridge", "feeder"], notes: "test only",
};
function pkg(component: "bridge" | "feeder" = "feeder"): BridgeDlc {
  return { component, version: component === "feeder" ? "0.15.1" : "1.4.12", variant: "fixture-adapter",
    sha256: "a".repeat(64), gameApis: ["dx9", "dx10", "dx11", "dx12", "vulkan", "opengl"],
    gameArchitectures: ["x86", "x64"], consumerInterface: "fixture-input-v1", compatibleCoreBuilds: ["fixture-core"],
    x64HostIncluded: true, licenseNoticeFiles: ["licenses/NOTICE.txt"] };
}
function context(): BridgeContext {
  return { enabled: true, gameApi: "dx12", architecture: "x64", nativeInputs: "absent",
    core: { buildId: "fixture-core", inputInterfaces: ["fixture-input-v1"], nativeD3D12: true }, packages: [pkg()] };
}

test("absent/disabled optional component does not require a package or native DLL", () => {
  for (const input of [undefined, { enabled: false }]) {
    const p = planBridgeDlc(recipe, input);
    assert.equal(p.state, "not-requested"); assert.equal(p.selected, null);
    assert.equal(p.preservesOriginal, true); assert.equal(p.installAuthorized, false);
  }
});
test("native x64 D3D12 wins even with no Feeder or matching package", () => {
  const c = context(); c.nativeInputs = "usable"; c.packages = [];
  const p = planBridgeDlc(recipe, c);
  assert.equal(p.state, "native"); assert.equal(p.component, null); assert.equal(p.selected, null);
});
test("native DX11/Vulkan asks for the pinned native mirror, not Feeder", () => {
  for (const api of ["dx11", "vulkan"] as const) {
    const c = context(); c.gameApi = api; c.nativeInputs = "usable"; c.packages = [pkg(), pkg("bridge")];
    const p = planBridgeDlc(recipe, c); assert.equal(p.state, "candidate"); assert.equal(p.component, "bridge");
  }
});
test("synthetic metadata match remains a dry-run and not an install/runtime claim", () => {
  const p = planBridgeDlc(recipe, context());
  assert.equal(p.state, "candidate"); assert.equal(p.component, "feeder");
  assert.equal(p.installAuthorized, false); assert.equal(p.dryRun, true); assert.equal(p.requiredChecks.length, 5);
});
test("multiple cached versions do not install multiple active bridges", () => {
  const c = context(); const old = pkg(); old.version = "0.13.1"; const newer = pkg(); newer.version = "0.16.0";
  c.packages = [old, pkg(), newer];
  const p = planBridgeDlc(recipe, c); assert.equal(p.selected?.version, "0.15.1");
  assert.equal(c.packages.length, 3); assert.equal(recipe.pins.feeder, "0.15.1");
});
test("same-version variants require explicit disambiguation", () => {
  const c = context(); const second = pkg(); second.variant = "fixture-other"; c.packages.push(second);
  assert.equal(planBridgeDlc(recipe, c).code, "BRIDGE_VARIANT_AMBIGUOUS");
  c.selectedVariant = "fixture-other"; assert.equal(planBridgeDlc(recipe, c).selected?.variant, "fixture-other");
});
test("missing DLC and changed Core interface preserve original, never swap an old Core in", () => {
  const c = context(); c.packages = [];
  assert.equal(planBridgeDlc(recipe, c).code, "BRIDGE_PACKAGE_MISSING");
  c.packages = [pkg()]; c.core.inputInterfaces = [];
  assert.equal(planBridgeDlc(recipe, c).code, "BRIDGE_CONTRACT_MISMATCH");
  assert.equal(c.core.buildId, "fixture-core");
});
for (const [name, patch] of [
  ["empty sha", { sha256: "" }], ["zero sha", { sha256: "0".repeat(64) }],
  ["wrong API", { gameApis: ["opengl"] }], ["wrong bitness", { gameArchitectures: ["x86"] }],
  ["wrong Core", { compatibleCoreBuilds: ["old-core"] }],
  ["wrong interface", { consumerInterface: "other-v2" }], ["no notices", { licenseNoticeFiles: [] }],
  ["notice traversal", { licenseNoticeFiles: ["../LICENSE"] }],
  ["absolute notice", { licenseNoticeFiles: ["/LICENSE"] }],
  ["drive notice", { licenseNoticeFiles: ["X:/LICENSE"] }],
  ["unknown API in set", { gameApis: ["dx12", "unknown"] }],
  ["unknown architecture in set", { gameArchitectures: ["x64", "any"] }],
] as const) test(`reject package ${name}`, () => {
  const c = context(); Object.assign(c.packages[0]!, patch);
  const p = planBridgeDlc(recipe, c); assert.equal(p.code, "BRIDGE_CONTRACT_MISMATCH");
  assert.equal(p.selected, null); assert.equal(p.preservesOriginal, true);
});
for (const field of ["gameApi", "architecture", "nativeInputs"] as const)
  test(`unknown ${field} does not trigger guessed fallback`, () => {
    const c = context(); c[field] = "unknown";
    assert.equal(planBridgeDlc(recipe, c).code, "BRIDGE_INPUT_UNKNOWN");
  });
test("x86 requires explicit x64 host metadata", () => {
  const c = context(); c.architecture = "x86"; c.gameApi = "dx9"; c.packages[0]!.x64HostIncluded = false;
  assert.equal(planBridgeDlc(recipe, c).state, "blocked");
  c.packages[0]!.x64HostIncluded = true; assert.equal(planBridgeDlc(recipe, c).state, "candidate");
});
for (const value of ["latest", "1.4.13-pre", "1.4.13-pre7", "", "^1.4.12"])
  test(`reject unapproved bridge pin ${JSON.stringify(value)}`, () => {
    const c = context(); c.gameApi = "dx11"; c.nativeInputs = "usable"; c.packages = [pkg("bridge")];
    assert.equal(planBridgeDlc({ ...recipe, pins: { bridge: value } }, c).code, "BRIDGE_PIN_REQUIRED");
  });
test("BG3 pin remains 1.4.11 even if the cache offers 1.4.12", () => {
  const c = context(); c.gameApi = "dx11"; c.nativeInputs = "usable"; c.packages = [pkg("bridge")];
  assert.equal(planBridgeDlc({ ...recipe, gameId: "bg3" }, c).code, "BRIDGE_GAME_PIN");
  c.packages[0]!.version = "1.4.11";
  assert.equal(planBridgeDlc({ ...recipe, gameId: "bg3", pins: { bridge: "1.4.11" } }, c).state, "candidate");
});
test("bad JSON shapes are rejected, not interpreted as defaults", () => {
  for (const c of [null, true, [], "yes", { enabled: "true" }, { ...context(), nativeInputs: ["usable"] }])
    assert.equal(planBridgeDlc(recipe, c).state, "blocked");
  assert.equal(planBridgeDlc(recipe, { ...context(), core: null }).code, "BRIDGE_CORE_UNKNOWN");
  assert.equal(planBridgeDlc(recipe, { ...context(), packages: null }).code, "BRIDGE_PACKAGES_INVALID");
});
test("unselected foreign packages never become a current pin", () => {
  const c = context(); c.packages = [{ ...pkg(), component: "bridge" }];
  assert.equal(planBridgeDlc(recipe, c).code, "BRIDGE_PACKAGE_MISSING");
});
test("the actual install planner invokes the optional contract gate", () => {
  const c = context(); c.packages = [];
  const denied = planInstall(recipe, c);
  assert.equal(denied.bridge?.code, "BRIDGE_PACKAGE_MISSING");
  assert.equal(denied.steps.length, 1); assert.ok(denied.refused.some(s => s.includes("BRIDGE_PACKAGE_MISSING")));
  const allowed = planInstall(recipe, context()); assert.equal(allowed.bridge?.state, "candidate");
  assert.equal(allowed.dryRun, true); assert.equal(allowed.bridge?.installAuthorized, false);
});
test("old install/uninstall callers remain compatible and have no new dependency", () => {
  const p = planInstall(recipe); assert.equal(p.bridge, undefined); assert.equal(p.steps.length, 5);
  assert.equal(planUninstall(recipe).bridge, undefined); assert.equal(planUninstall(recipe).dryRun, true);
});
test("existing hard blocked bridge pin still throws through old entrypoint", () => {
  assert.throws(() => planInstall({ ...recipe, pins: { bridge: "latest" } }), /Bridge/);
});
