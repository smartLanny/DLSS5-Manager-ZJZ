import assert from "node:assert/strict";
import test from "node:test";
import { planDiscovery } from "../src/discovery/index.js";
import { Failures, formatUnknown } from "../src/failures.js";
import { requireOptional } from "../src/optional/modules.js";

test("failures are readable with code and hint", () => {
  const err = Failures.bridgeLatestForbidden("1.4.13-pre");
  const text = err.format();
  assert.match(text, /BRIDGE_LATEST_FORBIDDEN/);
  assert.match(text, /1\.4\.11/);
  assert.match(text, /#224/);
});

test("optional D14 / miHoYo stay out of this tree", () => {
  assert.throws(() => requireOptional("d14-core"), (err: unknown) => {
    assert.equal((err as { code?: string }).code, "LAB_CORE_OUT_OF_SCOPE");
    return true;
  });
  assert.throws(() => requireOptional("mihoyo-hooks"), (err: unknown) => {
    assert.equal((err as { code?: string }).code, "LAB_CORE_OUT_OF_SCOPE");
    return true;
  });
  assert.throws(() => requireOptional("feedback-packaging"), (err: unknown) => {
    assert.equal((err as { code?: string }).code, "OPTIONAL_MODULE_DISABLED");
    return true;
  });
});

test("discovery reports scan roots instead of inventing games", () => {
  const plan = planDiscovery();
  assert.equal(plan.games.length, 0);
  assert.ok(plan.stores.some((s) => s.store === "steam" && s.roots.length > 0));
});

test("unknown errors still format", () => {
  assert.match(formatUnknown(new Error("boom")), /UNEXPECTED/);
});
