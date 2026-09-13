import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, linkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CONTEXT_BYTE_LIMIT, parseInstallArguments, readBridgeContext } from "../src/recipes/bridge-context.js";

function fixture(run: (file: string, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "bridge-context-"));
  try { run(join(dir, "context.json"), dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
test("reads an explicit context without changing the file", () => fixture(file => {
  const bytes = Buffer.from('{"enabled":false}'); writeFileSync(file, bytes);
  const result = readBridgeContext(file);
  assert.deepEqual(result.value, { enabled: false });
  assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(readFileSync(file), bytes);
}));
test("accepts a UTF8 BOM, preserving the byte fingerprint", () => fixture(file => {
  writeFileSync(file, '\uFEFF{"enabled":false}'); assert.deepEqual(readBridgeContext(file).value, { enabled: false });
}));
for (const content of ["", "[]", "null", "42", '"text"', '{"secret":super-private-not-json}'])
  test(`rejects invalid JSON shape ${content.length}`, () => fixture(file => {
    writeFileSync(file, content);
    assert.throws(() => readBridgeContext(file), error => {
      assert.ok(error instanceof Error); assert.ok(!error.message.includes("super-private")); return true;
    });
  }));
test("rejects invalid UTF8", () => fixture(file => {
  writeFileSync(file, Buffer.from([123, 34, 255, 34, 58, 49, 125])); assert.throws(() => readBridgeContext(file), /UTF-8/);
}));
test("bounds file size before allocating a buffer", () => fixture(file => {
  writeFileSync(file, Buffer.alloc(CONTEXT_BYTE_LIMIT + 1, 32)); assert.throws(() => readBridgeContext(file), /1 MiB/);
}));
test("does not read directories, symlinks or hard links", () => fixture((file, dir) => {
  writeFileSync(file, '{}'); assert.throws(() => readBridgeContext(dir));
  const hard = join(dir, "hard.json"); linkSync(file, hard); assert.throws(() => readBridgeContext(hard));
  rmSync(hard);
  // Junction creation on Windows does not require symlink privilege.
  const link = join(dir, "link"); symlinkSync(dir, link, "junction"); assert.throws(() => readBridgeContext(link));
}));
for (const path of ["https://example.invalid/context.json", "//server/context.json", "\\\\server\\context.json", "bad\0path"])
  test("refuses URL/UNC/NUL without fetching", () => assert.throws(() => readBridgeContext(path)));
test("legacy install remains one argument", () => assert.deepEqual(parseInstallArguments(["bg3"]), { recipeId: "bg3" }));
test("explicit context is preserved", () => assert.deepEqual(parseInstallArguments(["bg3", "--bridge-context", "folder with spaces/c.json"]),
  { recipeId: "bg3", contextFile: "folder with spaces/c.json" }));
for (const args of [[], ["--bridge-context"], ["bg3", "--bridge-context"], ["bg3", "--typo", "file"],
  ["bg3", "--bridge-context", "--other"], ["bg3", "--bridge-context", "one", "--bridge-context", "two"]])
  test(`rejects incomplete/duplicate/unknown arguments ${JSON.stringify(args)}`, () => assert.throws(() => parseInstallArguments(args)));
