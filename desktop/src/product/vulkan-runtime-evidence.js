'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { noLinks } = require('./launch-safety');
const { createVulkanRuntimeProfile } = require('./vulkan-runtime-profile');

const HEAD_BYTES = 4 * 1024, TAIL_BYTES = 32 * 1024, RECEIPT_BYTES = 128 * 1024;
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const localAbsolute = value => typeof value === 'string' && !value.includes('\0') && path.isAbsolute(value) &&
  (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(value));
const unknown = detail => ({ loaded: 'unknown', processed: 'unknown', detail });

function createVulkanRuntimeEvidence(options = {}) {
  if (!localAbsolute(options.userData)) throw Object.assign(new Error('Vulkan 日志证据需要绝对的用户数据路径。'), { code: 'VULKAN_EVIDENCE_BAD_CONFIG' });
  const userData = path.resolve(options.userData), open = options.overrides?.open || fsp.open;
  const profile = createVulkanRuntimeProfile({ userData });

  async function readBounded(file, startedAt, receipt = false) {
    let handle;
    try {
      await noLinks(file);
      const before = await fsp.lstat(file);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || receipt && before.size > RECEIPT_BYTES)
        return { error: 'unsafe' };
      if (!receipt && before.mtimeMs < startedAt) return { error: 'old' };
      handle = await open(file, 'r');
      const initial = await handle.stat();
      if (initial.dev !== before.dev || initial.ino !== before.ino || initial.size !== before.size || initial.mtimeMs !== before.mtimeMs)
        return { error: 'changed' };
      const headLength = Math.min(initial.size, receipt ? RECEIPT_BYTES : HEAD_BYTES);
      const tailStart = receipt ? initial.size : Math.max(headLength, initial.size - TAIL_BYTES);
      const read = async (start, length) => {
        const bytes = Buffer.alloc(length); let offset = 0;
        while (offset < length) {
          const result = await handle.read(bytes, offset, length - offset, start + offset);
          if (!result.bytesRead) return null;
          offset += result.bytesRead;
        }
        return bytes;
      };
      const head = await read(0, headLength), tail = await read(tailStart, initial.size - tailStart);
      if (!head || !tail) return { error: 'changed' };
      await noLinks(file);
      const [after, current] = await Promise.all([handle.stat(), fsp.lstat(file)]);
      if (after.dev !== current.dev || after.ino !== current.ino || after.size !== initial.size || after.mtimeMs !== initial.mtimeMs ||
          current.isSymbolicLink() || current.nlink > 1) return { error: 'changed' };
      if (tailStart === headLength) return { text: Buffer.concat([head, tail]).toString('utf8').replace(/^\uFEFF/, '') };
      // Do not manufacture a complete line by joining the two distant windows.
      const first = head.toString('utf8'), last = tail.toString('utf8');
      return { text: first.slice(0, first.lastIndexOf('\n') + 1) + '\n' + (last.includes('\n') ? last.slice(last.indexOf('\n') + 1) : '') };
    } catch (error) { return { error: error.code || 'read' }; }
    finally { if (handle) await handle.close().catch(() => {}); }
  }

  async function ownedProfile(basePath) {
    if (!localAbsolute(basePath)) return null;
    const root = path.join(userData, 'vulkan-runtime');
    if (!same(path.dirname(path.dirname(basePath)), root)) return null;
    await noLinks(basePath);
    const record = await readBounded(path.join(basePath, '.xiaofeng-vulkan-runtime.json'), 0, true);
    if (record.error) return null;
    let receipt; try { receipt = JSON.parse(record.text); } catch { return null; }
    if (receipt?.version !== 1 || receipt.product !== 'xiaofeng-vulkan-runtime-profile' || !localAbsolute(receipt.exe) ||
        !/^[a-f0-9]{64}$/.test(receipt.recipe?.fingerprint || '')) return null;
    const checked = profile.identifyReceipt({ receipt, basePath });
    const feederFiles = checked.recipe.files.map(row => row.target).filter(target =>
      same(path.dirname(path.resolve(basePath, target)), path.join(basePath, 'addons')) &&
      /^dlss5-feed(?:-[a-z0-9._-]+)?\.addon64$/i.test(path.basename(target)));
    return feederFiles.length ? feederFiles.map(target => path.resolve(basePath, target)) : null;
  }

  function reshadeLoaded(text, feederFiles) {
    let loading = false, initialized = false, failed = false;
    for (const line of text.split(/\r?\n/)) {
      if (/\|\s*INFO\s*\|\s*(?:Initializing crosire's ReShade|Registered add-on "DLSS 5 Feed\b)/.test(line)) initialized = true;
      const load = line.match(/\|\s*INFO\s*\|\s*Loading add-on from '([^'\r\n]+)'/);
      if (load && localAbsolute(load[1]) && feederFiles.some(file => same(file, load[1]))) loading = true;
      if (/\|\s*ERROR\s*\|/.test(line) && /(?:failed|unable|could not)\s+(?:to\s+)?(?:load|initialize)/i.test(line) &&
          feederFiles.some(file => line.toLowerCase().includes(path.basename(file).toLowerCase()))) failed = true;
    }
    return failed ? false : loading && initialized ? true : 'unknown';
  }

  function feederProcessed(text, pid) {
    let session = null, frame, reason;
    for (const line of text.split(/\r?\n/)) {
      const marker = line.match(/(?:^|\s)\[nr-vulkan-session\] pid=(\d+)\s*$/);
      if (marker) { session = Number(marker[1]); frame = undefined; reason = undefined; continue; }
      if (session !== pid) continue;
      const completion = line.match(/(?:^|\s)\[nr-vulkan-completion\] frame=(\d+) nr_completed=1 output_recorded=1\s*$/);
      if (completion && Number.isSafeInteger(Number(completion[1]))) frame = Number(completion[1]);
      const retained = line.match(/\[feed\] Vulkan project Core retained original:\s*(.+)/);
      if (retained) reason = retained[1].replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').slice(0, 180).trim();
    }
    if (session !== pid) return { value: 'unknown', detail: '缺少与本次 PID 匹配的 Feeder 会话证据。' };
    if (frame !== undefined) return { value: true, frame, detail: '本次已记录 NR 完成和输出指令；实际画面仍需核对。' };
    if (reason) return { value: false, detail: `本次保留原帧：${reason}；尚未确认 NR 完成。` };
    return { value: 'unknown', detail: '已识别本次 Feeder 会话，尚无 NR 完成证据。' };
  }

  async function readEvidence(input = {}) {
    const startedAt = typeof input.startedAt === 'number' ? input.startedAt : typeof input.startedAt === 'string' ? Date.parse(input.startedAt) : NaN;
    if (!Number.isFinite(startedAt) || startedAt <= 0 || !Number.isInteger(input.pid) || input.pid <= 0 || input.pid > 0xffffffff)
      return unknown('尚无可核对的本次启动时间与 PID。');
    let feederFiles;
    try { feederFiles = await ownedProfile(input.basePath); } catch { /* untrusted or unavailable profile */ }
    if (!feederFiles) return unknown('未确认受管理的 Vulkan profile，未采用其中的日志。');
    const [reshade, feeder] = await Promise.all([
      readBounded(path.join(input.basePath, 'ReShade.log'), startedAt),
      readBounded(path.join(input.basePath, 'addons', 'dlss5-feed.log'), startedAt)
    ]);
    const loaded = reshade.error ? 'unknown' : reshadeLoaded(reshade.text, feederFiles);
    const processed = feeder.error ? { value: 'unknown', detail: feeder.error === 'old' ? 'Feeder 日志早于本次启动，未采用旧结果。' : '本次 Feeder 日志缺失、被占用或正在变化，暂无法确认处理结果。' } : feederProcessed(feeder.text, input.pid);
    const detail = loaded === true ? `本次 ReShade 已记录加载 Feeder。${processed.detail}` : loaded === false ? `本次 ReShade 记录了 Feeder 加载失败。${processed.detail}` : processed.detail;
    return { loaded, processed: processed.value, detail, ...(processed.frame === undefined ? {} : { frame: processed.frame }) };
  }
  return Object.freeze({ readEvidence });
}

module.exports = { createVulkanRuntimeEvidence };
