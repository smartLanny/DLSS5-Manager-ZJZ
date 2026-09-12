import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { ManagerError } from "../failures.js";

export const CONTEXT_BYTE_LIMIT = 1024 * 1024;
const invalid = (message: string): ManagerError => new ManagerError(
  "BRIDGE_CONTEXT_INVALID", message,
  "使用本机普通 UTF-8 JSON 文件；这只是 dry-run 输入，不是可信组件清单或安装授权。",
);

/** Explicit local input only. No URLs, downloads, DLL loads, or settings writes.
 * Size-bounded and read from one descriptor; parser errors never echo file data.
 * The fingerprint identifies the read input, not its authenticity.
 */
export function readBridgeContext(file: string): { value: unknown; sha256: string } {
  if (!file || file.includes("\0") || /^[a-z]+:\/\//i.test(file) || /^[\\/]{2}/.test(file))
    throw invalid("桥接上下文必须是本机文件，不读取 URL 或网络共享。");
  let fd: number | undefined;
  try {
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > CONTEXT_BYTE_LIMIT)
      throw invalid("上下文必须是非空、单链接的普通文件，且不超过 1 MiB。");
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      throw invalid("上下文文件在打开前发生变化，请重新生成。");
    const data = Buffer.alloc(CONTEXT_BYTE_LIMIT + 1);
    let count = 0;
    while (count < data.length) {
      const n = readSync(fd, data, count, data.length - count, null);
      if (n === 0) break;
      count += n;
    }
    const after = fstatSync(fd);
    if (count !== before.size || count > CONTEXT_BYTE_LIMIT || after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs)
      throw invalid("上下文文件在读取时发生变化或超过大小限制。");
    const bytes = data.subarray(0, count);
    let value: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
      value = JSON.parse(text) as unknown;
    } catch { throw invalid("上下文不是有效的 UTF-8 JSON；错误不会回显文件内容。"); }
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw invalid("上下文根节点必须是对象。");
    return { value, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error: unknown) {
    if (error instanceof ManagerError) throw error;
    throw invalid("无法安全读取桥接上下文，请检查文件类型和访问权限。");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function parseInstallArguments(args: string[]): { recipeId: string; contextFile?: string } {
  const recipeId = args[0];
  if (!recipeId || recipeId.startsWith("-")) throw invalid("请先指定安装配方 id。");
  if (args.length === 1) return { recipeId };
  if (args.length !== 3 || args[1] !== "--bridge-context" || !args[2] || args[2].startsWith("-"))
    throw invalid("安装选项仅支持一次 --bridge-context <本机 JSON 文件>；不忽略未知或重复选项。");
  return { recipeId, contextFile: args[2] };
}
