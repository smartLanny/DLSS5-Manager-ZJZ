import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

test("external build output is allowed locally but tracked payloads still fail", t => {
  const root = mkdtempSync(join(tmpdir(), "manager-source-guard-"));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "desktop/dist-external"), { recursive: true });
  const script = join(root, "scripts/assert-no-payloads.mjs");
  copyFileSync(fileURLToPath(new URL("../../scripts/assert-no-payloads.mjs", import.meta.url)), script);
  writeFileSync(join(root, "desktop/dist-external/fixture.exe"), "inert test fixture");
  execFileSync("git", ["init", "--quiet", root], { windowsHide: true });
  const run = () => spawnSync(process.execPath, [script], { encoding: "utf8", windowsHide: true });
  assert.equal(run().status, 0);
  execFileSync("git", ["-C", root, "add", "-f", "desktop/dist-external/fixture.exe"], { windowsHide: true });
  const blocked = run();
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /tracked-payload-in-generated-output/);
});
