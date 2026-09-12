import assert from "node:assert/strict";
import test from "node:test";
import { listPinnedComponents } from "../src/components/list.js";
import { Failures } from "../src/failures.js";
import { loadPinManifest } from "../src/pin/load.js";
import { getRecipe } from "../src/recipes/catalog.js";
import { planInstall } from "../src/recipes/install.js";
import { checkUpdates, decideUpdate, refuseBinaryDownload } from "../src/updater/check.js";
import { describeFetch } from "../src/updater/plan.js";

test("component stub lists pins and fetch plan without binaries", () => {
  const manifest = loadPinManifest();
  const rows = listPinnedComponents(manifest, "bg3");
  const mfg = rows.find((r) => r.id === "mfg-unlock");
  const bridge = rows.find((r) => r.id === "bridge");
  assert.equal(mfg?.pin, "0.9");
  assert.equal(bridge?.pin, "1.4.11");
  assert.match(mfg?.wouldFetch ?? "", /不下载|不自动/);
  for (const plan of describeFetch(manifest, "bg3")) {
    assert.equal(plan.downloadsBinaries, false);
    assert.equal(plan.autoApply, false);
  }
});

test("updater keeps pin when source is newer", () => {
  const manifest = loadPinManifest();
  const mfg = manifest.components.find((c) => c.id === "mfg-unlock");
  assert.ok(mfg);
  const report = decideUpdate(mfg, "0.9", "0.4");
  assert.equal(report.action, "keep-pin");
  assert.match(report.message, /0\.9/);
});

test("updater blocks Bridge latest / 1.4.13-pre", () => {
  const manifest = loadPinManifest();
  const bridge = manifest.components.find((c) => c.id === "bridge");
  assert.ok(bridge);
  const report = decideUpdate(bridge, "1.4.11", "1.4.13-pre");
  assert.equal(report.action, "blocked-latest");
});

test("live check uses metadata JSON only", async () => {
  const manifest = loadPinManifest();
  const fetchImpl: typeof fetch = async (url) => {
    assert.match(String(url), /api\.github\.com\/repos\/.+\/releases/);
    return new Response(
      JSON.stringify([{ tag_name: "v0.4", name: "0.4", published_at: "2026-09-03T00:00:00Z" }]),
      { status: 200 },
    );
  };
  const reports = await checkUpdates(manifest, { live: true, gameId: "bg3", fetchImpl });
  const mfg = reports.find((r) => r.componentId === "mfg-unlock");
  assert.equal(mfg?.sourceLatest, "v0.4");
  assert.equal(mfg?.action, "keep-pin");
  assert.equal(mfg?.pin, "0.9");
});

test("install dry-run refuses proprietary payloads and #27/#28 claims", () => {
  const recipe = getRecipe(loadPinManifest(), "bg3");
  const plan = planInstall(recipe);
  assert.equal(plan.dryRun, true);
  assert.equal(recipe.pins.bridge, "1.4.11");
  assert.ok(plan.refused.some((line) => /NVIDIA/.test(line)));
  assert.ok(plan.refused.some((line) => /#251/.test(line)));
});

test("binary download entry stays closed", () => {
  assert.throws(() => refuseBinaryDownload("nvngx_dlssnr.dll"), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal((err as { code?: string }).code, Failures.binaryForbidden("nvngx_dlssnr.dll").code);
    return true;
  });
});
