'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { noLinks } = require('./launch-safety');
const { DIRECTORY } = require('./feeder-runtime');

// Bounded reading of this tool's own callback logs; never scan game log trees.
async function readWindow(file, startedAt, open = fs.open) {
  let handle;
  try {
    await noLinks(file); const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || before.mtimeMs < startedAt) return null;
    handle = await open(file, 'r'); const initial = await handle.stat();
    if (initial.size !== before.size || initial.mtimeMs !== before.mtimeMs || initial.ino !== before.ino) return null;
    const length = Math.min(initial.size, 48 * 1024), start = initial.size - length, bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) { const got = await handle.read(bytes, offset, length - offset, start + offset); if (!got.bytesRead) return null; offset += got.bytesRead; }
    const text = bytes.toString('utf8'); let result = text;
    // Keep the current session marker from the beginning without joining parts
    // of two distant log lines into a fictitious completed record.
    if (start) {
      const first = Buffer.alloc(Math.min(initial.size, 4096)); let read = 0;
      while (read < first.length) { const got = await handle.read(first, read, first.length - read, read); if (!got.bytesRead) return null; read += got.bytesRead; }
      const head = first.toString('utf8');
      result = head.slice(0, head.lastIndexOf('\n') + 1) + '\n' + text.slice(text.indexOf('\n') + 1);
    }
    await noLinks(file);
    const current = await fs.lstat(file), after = await handle.stat();
    if (!current.isFile() || current.isSymbolicLink() || current.nlink > 1 || current.ino !== before.ino ||
        current.size !== initial.size || current.mtimeMs !== initial.mtimeMs || after.size !== initial.size || after.mtimeMs !== initial.mtimeMs) return null;
    return result;
  } catch { return null; }
  finally { if (handle) await handle.close(); }
}
async function readFeederEvidence({ exeDir, lastLaunch }) {
  const startedAt = Date.parse(lastLaunch?.startedAt || ''), pid = lastLaunch?.pid;
  const unknown = { loaded: 'unknown', processed: 'unknown', detail: '尚无可核对的本次 Feeder 启动与完成记录。' };
  if (!path.isAbsolute(exeDir || '') || !Number.isFinite(startedAt) || !Number.isInteger(pid) || pid <= 0) return unknown;
  const [reshade, feeder] = await Promise.all([readWindow(path.join(exeDir, 'ReShade.log'), startedAt),
    readWindow(path.join(exeDir, DIRECTORY, 'addons', 'dlss5-feed.log'), startedAt)]);
  let session = null, complete = null, retained = null;
  for (const line of (feeder || '').split(/\r?\n/)) {
    const marker = line.match(/\[nr-feeder-dx12-session\] pid=(\d+)\s*$/);
    if (marker) { session = Number(marker[1]); complete = null; retained = null; continue; }
    if (session !== pid) continue;
    const recorded = line.match(/\[nr-feeder-dx12-completion\] frame=(\d+) nr_completed=1 output_recorded=1 provenance=Synthetic\s*$/);
    if (recorded && Number.isSafeInteger(Number(recorded[1])) && Number(recorded[1]) > 0) complete = Number(recorded[1]);
    const decline = line.match(/\[nr-feeder-dx12-retained\] reason=([^\r\n]{1,240})/);
    if (decline) { retained = decline[1].replace(/[\x00-\x1f\x7f]/g, ' '); complete = null; }
  }
  const loaded = session === pid ? true : reshade && /failed[^\r\n]*dlss5-feed-dx12-sdr\.addon64/i.test(reshade) ? false : 'unknown';
  if (session !== pid) return { ...unknown, loaded };
  if (complete !== null) return { loaded, processed: true, frame: complete, detail: '本次 NR 已完成并录制输出回填；真实画面仍需核对。' };
  if (retained) return { loaded, processed: false, detail: `本次保留原帧：${retained}` };
  return { loaded, processed: 'unknown', detail: '本次 Feeder 已加载，尚无 NR 完成记录。' };
}
async function readLegacyFeederEvidence({ layout, lastLaunch, hostRequired = false }) {
  const startedAt = Date.parse(lastLaunch?.startedAt || ''), pid = lastLaunch?.pid;
  const unknown = { loaded: 'unknown', processed: 'unknown', runtimeVerified: false,
    detail: '尚无可核对的本次 Feeder 启动与完成记录。' };
  if (!path.isAbsolute(layout?.addonDirectory || '') || !Number.isFinite(startedAt) || !Number.isInteger(pid) || pid <= 0) return unknown;
  const log = await readWindow(path.join(layout.addonDirectory, 'dlss5-feed.log'), startedAt);
  let session = null, frame = null, retained = null;
  for (const line of (log || '').split(/\r?\n/)) {
    const marker = line.match(/\[nr-feeder-session\] pid=(\d+) source=0151-external-v1\s*$/);
    if (marker) { session = Number(marker[1]); frame = null; retained = null; continue; }
    if (session !== pid) continue;
    const complete = hostRequired
      ? line.match(/\[nr-feeder-client-completion\] frame=(\d+) output_ready=1 nr_completed=1\s*$/)
      : line.match(/\[nr-feeder-completion\] frame=(\d+) epoch=\d+ nr_completed=1 output_recorded=1 provenance=Synthetic\s*$/);
    if (complete && Number.isSafeInteger(Number(complete[1])) && Number(complete[1]) > 0) { frame = Number(complete[1]); retained = null; }
    const decline = line.match(/\[nr-feeder(?:-client)?-retained\]\s*([^\r\n]{1,240})/);
    if (decline) { retained = decline[1].replace(/[\x00-\x1f\x7f]/g, ' '); frame = null; }
  }
  if (session !== pid) return unknown;
  if (frame !== null) return { ...unknown, loaded: true, processed: true, frame,
    detail: hostRequired ? '本次宿主完成 NR，游戏收到该帧完成回执；真实画面仍需核对。' : '本次 NR 已完成并录制输出回填；真实画面仍需核对。' };
  if (retained) return { ...unknown, loaded: true, processed: false, detail: `本次保留原帧：${retained}` };
  return { ...unknown, loaded: true, detail: '本次 Feeder 已加载，尚无 NR 完成记录。' };
}
module.exports = { readFeederEvidence, readLegacyFeederEvidence, readWindow, ...require('./legacy-runtime-evidence') };
