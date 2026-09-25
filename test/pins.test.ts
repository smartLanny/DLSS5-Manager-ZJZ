import assert from "node:assert/strict";
import test from "node:test";
import { getComponent, loadPinManifest, parsePinManifest, resolvePin } from "../src/pin/load.js";
import { ManagerError } from "../src/failures.js";

test("owner pins: MFG 0.9 is the only selectable install or rollback", () => {
  const manifest = loadPinManifest();
  const mfg = getComponent(manifest, "mfg-unlock");
  assert.equal(mfg.defaultPin, "0.9");
  assert.deepEqual(mfg.rollbacks, []);
});

test("rejects old MFG releases as rollback choices", () => {
  const manifest = loadPinManifest();
  const broken = structuredClone(manifest) as unknown as Record<string, unknown>;
  const components = broken.components as Array<Record<string, unknown>>;
  const mfg = components.find((c) => c.id === "mfg-unlock");
  assert.ok(mfg);
  mfg.rollbacks = ["0.7-zh-CN"];
  assert.throws(() => parsePinManifest(broken), (err: unknown) => {
    assert.ok(err instanceof ManagerError);
    assert.equal(err.code, "MANIFEST_INVALID");
    return true;
  });
});

test("owner pins: Bridge BG3 stays 1.4.11 and never latest", () => {
  const manifest = loadPinManifest();
  const bridge = getComponent(manifest, "bridge");
  assert.equal(resolvePin(bridge, "bg3"), "1.4.11");
  assert.deepEqual(new Set(bridge.neverForce), new Set(["latest", "1.4.13-pre"]));
});

test("rejects MFG default other than 0.9", () => {
  const manifest = loadPinManifest();
  const broken = structuredClone(manifest) as unknown as Record<string, unknown>;
  const components = broken.components as Array<Record<string, unknown>>;
  const mfg = components.find((c) => c.id === "mfg-unlock");
  assert.ok(mfg);
  mfg.defaultPin = "0.7";
  assert.throws(() => parsePinManifest(broken), (err: unknown) => {
    assert.ok(err instanceof ManagerError);
    assert.equal(err.code, "MANIFEST_INVALID");
    return true;
  });
});
