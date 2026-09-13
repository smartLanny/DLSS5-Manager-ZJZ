'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { inside, noLinks } = require('../src/product/launch-safety');

const DESTINATION = path.resolve(__dirname, '../resources/vulkan-runtime');
const HASH = /^[a-f0-9]{64}$/i, ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const PE_EXTENSIONS = new Set(['.dll', '.exe', '.asi', '.addon', '.addon64']);
const MAX_FILE = 512 * 1024 * 1024, MAX_TOTAL = 2 * 1024 * 1024 * 1024;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function fail(code, message, details) { throw Object.assign(new Error(message), { code, details }); }
function requireEvidence(condition, message, details) { if (!condition) fail('VULKAN_RUNTIME_ACCEPTANCE_FAILED', message, details); }
function absolute(value) {
  return typeof value === 'string' && !value.includes('\0') && path.isAbsolute(value) &&
    (process.platform !== 'win32' || /^[a-z]:[\\/][^:]*$/i.test(value));
}
function relative(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || path.isAbsolute(value) || /[\0<>:"|?*]/.test(value)) return null;
  const parts = value.split(/[\\/]/);
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return null;
  return parts.join('/');
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function metadata(value, name, required = true) {
  if (value === undefined && !required) return undefined;
  if ((!value || typeof value !== 'string') && (!value || typeof value !== 'object' || Array.isArray(value)))
    fail('VULKAN_RUNTIME_PLAN_INVALID', `${name} 必须包含明确的来源或许可说明。`);
  const serialized = JSON.stringify(value);
  if (!serialized || serialized.length > 16 * 1024 || value === '' || typeof value === 'object' && !Object.keys(value).length)
    fail('VULKAN_RUNTIME_PLAN_INVALID', `${name} 为空或超出大小限制。`);
  return JSON.parse(serialized);
}
async function regular(file, max = MAX_FILE) {
  if (!absolute(file)) fail('VULKAN_RUNTIME_SOURCE_INVALID', '来源必须是本地绝对路径。');
  await noLinks(file);
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > max)
    fail('VULKAN_RUNTIME_SOURCE_INVALID', '来源不是安全且大小有限的普通文件。', { file: path.basename(file) });
  return stat;
}
async function hashFile(file) {
  await regular(file);
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  await noLinks(file);
  return hash.digest('hex');
}
async function readSmall(file, max = 2 * 1024 * 1024) {
  await regular(file, max); return fsp.readFile(file);
}
function json(bytes, name) {
  try { return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { fail('VULKAN_RUNTIME_PLAN_INVALID', `${name} 不是有效 JSON。`); }
}
async function assertX64(file, target) {
  const handle = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(64), first = await handle.read(head, 0, head.length, 0);
    const mz = first.bytesRead >= 2 && head.readUInt16LE(0) === 0x5a4d;
    if (!mz && !PE_EXTENSIONS.has(path.extname(target).toLowerCase()) && !PE_EXTENSIONS.has(path.extname(file).toLowerCase())) return;
    if (!mz || first.bytesRead !== 64) fail('VULKAN_RUNTIME_ARCH', '运行二进制缺少有效的 x64 PE 头。', { file: target });
    const offset = head.readUInt32LE(0x3c), pe = Buffer.alloc(26);
    if (offset < 64 || offset > 1024 * 1024 || (await handle.read(pe, 0, pe.length, offset)).bytesRead !== pe.length ||
        pe.readUInt32LE(0) !== 0x00004550 || pe.readUInt16LE(4) !== 0x8664 || pe.readUInt16LE(24) !== 0x20b)
      fail('VULKAN_RUNTIME_ARCH', '运行二进制必须是 AMD64 PE32+，不能混入 x86/ARM64。', { file: target });
  } finally { await handle.close(); }
}
function validatePlan(plan) {
  if (!plan || plan.version !== 1 || !ID.test(plan.id || '') || !ID.test(plan.coreVersion || '') ||
      !/^[a-f0-9]{7,64}$/i.test(plan.sourceRevision || '') || plan.architecture !== 64 ||
      !Array.isArray(plan.files) || plan.files.length < 1 || plan.files.length > 64)
    fail('VULKAN_RUNTIME_PLAN_INVALID', '运行包计划的身份、架构或文件数量无效。');
  const sources = new Set(), targets = new Set();
  const files = plan.files.map(row => {
    const target = relative(row?.target);
    if (!row || !absolute(row.source) || !target || !HASH.test(row.sha256 || '') || typeof row.mutable !== 'boolean' ||
        ['recipe.json', '.xiaofeng-vulkan-runtime.json'].includes(target.toLowerCase()))
      fail('VULKAN_RUNTIME_PLAN_INVALID', '运行包计划包含无效来源、目标路径、摘要或保留名称。');
    const sourceKey = path.resolve(row.source).toLowerCase(), targetKey = target.toLowerCase();
    if (sources.has(sourceKey) || targets.has(targetKey) || [...targets].some(existing => existing.startsWith(targetKey + '/') || targetKey.startsWith(existing + '/')))
      fail('VULKAN_RUNTIME_PLAN_INVALID', '运行包计划包含重复来源、目标或目录/文件冲突。', { file: target });
    sources.add(sourceKey); targets.add(targetKey);
    if (row.mutable && PE_EXTENSIONS.has(path.extname(target).toLowerCase())) fail('VULKAN_RUNTIME_PLAN_INVALID', '运行二进制不能标记为可变配置。', { file: target });
    return { source: path.resolve(row.source), target, sha256: row.sha256.toLowerCase(), mutable: row.mutable,
      license: metadata(row.license, '文件许可'), provenance: metadata(row.provenance, '文件来源'),
      ...(row.identity === undefined ? {} : { identity: metadata(row.identity, '文件身份') }) };
  });
  const status = plan.acceptance?.status || 'pending';
  if (!['pending', 'processed'].includes(status) || plan.acceptance?.hardwareFamily && plan.acceptance.hardwareFamily !== 'RTX50')
    fail('VULKAN_RUNTIME_PLAN_INVALID', 'Vulkan 运行包只能明确标记 pending 或经证据核验的 RTX50 processed。');
  return { version: 1, id: plan.id, coreVersion: plan.coreVersion, sourceRevision: plan.sourceRevision.toLowerCase(), architecture: 64,
    files, acceptance: { ...plan.acceptance, status, hardwareFamily: 'RTX50' } };
}
function oneStep(result, name) {
  const rows = result.steps?.filter(row => row?.step === name) || [];
  requireEvidence(rows.length === 1, `实测记录必须有唯一的 ${name} 步骤。`); return rows[0];
}
function rendererEvidence(text) {
  const fields = new Map(); const depths = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('depth_frame=')) { depths.push(Object.fromEntries([...line.matchAll(/([a-z_]+)=([^\s]+)/g)].map(match => [match[1], match[2]]))); continue; }
    const match = line.match(/^([a-z_]+)=(.*)$/);
    if (match) { requireEvidence(!fields.has(match[1]), 'renderer report 包含重复字段。'); fields.set(match[1], match[2]); }
  }
  const frames = Number(fields.get('frames'));
  requireEvidence(Number.isInteger(frames) && frames >= 600 && frames <= 36000 && Number(fields.get('requested_frames')) === frames &&
    fields.get('exit') === 'clean' && (fields.get('realdepth_motion_verified') === '1' || fields.get('depth_motion_verified') === '1') &&
    Number(fields.get('draw_calls')) >= frames && Number(fields.get('depth_readbacks')) >= 2 &&
    fields.get('addon_loaded') === '1' && Number(fields.get('addon_vulkan_devices')) >= 1 && Number(fields.get('addon_presents')) >= frames &&
    /^NVIDIA\b.*\bRTX\s*50\d{2}\b/i.test(fields.get('gpu') || ''), 'renderer 必须证实至少 600 帧、真实深度运动、RTX50 和干净完成。');
  requireEvidence(depths.length >= 2 && depths.every(row => Number(row.invalid) === 0 && Number(row.near_pixels) > 0 && Number(row.middle_pixels) > 0 &&
    Number(row.far_pixels) > 0 && Number(row.depth_min) < Number(row.depth_max) && /^[a-f0-9]{16}$/i.test(row.depth_hash || '')) &&
    new Set(depths.map(row => row.depth_hash)).size >= 2, 'renderer 的真实 GPU 深度读回必须有效且随场景变化。');
  return { frames, gpu: fields.get('gpu'), depthDirection: fields.get('depth_direction') || 'unknown' };
}
function validateLogs(feeder, core, pid, frames) {
  requireEvidence(!/###\s*CRASH RECORDED\s*###/i.test(feeder), 'Feeder 记录了真实崩溃，不能标记 processed。');
  const hazardous = /quarantin(?:ed|ing)|lifecycle[^\r\n]*uncertain|queue[^\r\n]*(?:mismatch|did not match|invalidated)|command-list replay detected/i;
  requireEvidence(!hazardous.test(core) && !hazardous.test(feeder), 'Core/Feeder 记录了不确定生命周期、隔离或队列归属冲突。');
  requireEvidence(core.trim().length > 0 && /(?:NR-after-SR evaluate succeeded|Feature\s*18[^\r\n]*(?:evaluate|completed)[^\r\n]*(?:success|succeeded))/i.test(core), 'Core 日志没有实际 NR evaluate 成功记录。');
  let session = null; const completions = [], stages = [], identities = new Map();
  for (const line of feeder.split(/\r?\n/)) {
    const marker = line.match(/\[nr-vulkan-session\] pid=(\d+)\s*$/);
    if (marker) { session = Number(marker[1]); requireEvidence(session === pid, 'Feeder 日志包含另一进程的会话。'); continue; }
    if (!/\[nr-vulkan-completion\]|\[feed\] vk (?:stages|identity) frame=/.test(line)) continue;
    requireEvidence(session === pid, 'Feeder 完成或帧证据没有位于本次 PID 会话内。');
    const completion = line.match(/\[nr-vulkan-completion\] frame=(\d+) nr_completed=1 output_recorded=1\s*$/);
    if (completion) { completions.push(Number(completion[1])); continue; }
    if (line.includes('[nr-vulkan-completion]')) requireEvidence(false, 'Feeder 完成行不是完整的 NR 完成与输出记录。');
    if (line.includes('[feed] vk identity frame=')) {
      const row = Object.fromEntries([...line.matchAll(/([a-z_]+)=([^\s]+)/g)].map(match => [match[1], match[2]]));
      const frame = Number(row.frame);
      requireEvidence(Number.isSafeInteger(frame) && frame >= 1 && frame <= frames && ['0', '1'].includes(row.copied), 'Feeder identity 帧编号或 copied 状态无效。');
      if (row.copied === '1') {
        requireEvidence(row.stable === '1' && row.ordered === '1' && Number(row.waits) >= 1 && Number(row.in) === frame && Number(row.out) === frame,
          'NR copied 帧缺少稳定身份、同帧时间线或队列等待。', { frame });
        requireEvidence(!identities.has(frame), '同一 NR copied 帧出现重复 identity。', { frame }); identities.set(frame, row);
      }
      continue;
    }
    const stage = line.match(/\[feed\] vk stages frame=(\d+) valid=([01]) route=(buffer|image) F=(swapchain|effect-target) A=([a-f0-9]{16}) B=([a-f0-9]{16}) C=([a-f0-9]{16}) D=([a-f0-9]{16}) E=([a-f0-9]{16}) F=([a-f0-9]{16}) uniform=([01]{6}) bpp=(\d+)\/(\d+)/i);
    requireEvidence(Boolean(stage), 'Vulkan 六阶段探针行格式无效。');
    if (stage[2] === '0') continue;
    requireEvidence(stage[5] === stage[6] && stage[6] === stage[7] && stage[8] === stage[9] && stage[9] === stage[10] && stage[12] === stage[13],
      'Vulkan 六阶段探针显示输入或输出传输不一致。', { frame: Number(stage[1]) });
    if (stage[11] === '000000') stages.push({ frame: Number(stage[1]), changed: stage[5] !== stage[8], target: stage[4], route: stage[3] });
  }
  requireEvidence(session === pid && completions.length >= 1 && completions.every(frame => identities.has(frame)), '缺少与本次 PID、copied identity 一致的 NR 完成标记。');
  requireEvidence(stages.length >= 2 && new Set(stages.map(row => row.frame)).size === stages.length && stages.every(row => identities.has(row.frame)) && stages.some(row => row.changed),
    '至少需要两帧有效、非均匀且同帧复制的 A=B=C/D=E=F，其中一帧 A 与 D 必须不同。');
  return { completedFrames: completions, sampledFrames: stages, copiedIdentityFrames: identities.size };
}
function registryRows(snapshot) {
  requireEvidence(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) && Array.isArray(snapshot.hkcu) && Array.isArray(snapshot.hklm),
    '注册表快照必须分别提供 hkcu 与 hklm，单个空数组不是双作用域证据。');
  return Object.fromEntries(['hkcu', 'hklm'].map(key => {
    requireEvidence(snapshot[key].length <= 8192 && snapshot[key].every(row => row && typeof row === 'object' && !Array.isArray(row)), '注册表快照行无效。');
    return [key, snapshot[key].map(row => JSON.stringify(canonical(row))).sort()];
  }));
}
function checkInputs(files, rows, differences) {
  requireEvidence(Array.isArray(rows) && rows.length > 0 && rows.length <= 256, '缺少实测启动时全部 profile 文件的输入摘要。');
  const inputs = new Map();
  for (const row of rows) {
    requireEvidence(row && HASH.test(row.sha256 || ''), '实测输入摘要无效。');
    let target = relative(row.target);
    if (!target && typeof row.file === 'string') {
      const file = relative(row.file); requireEvidence(Boolean(file), '实测输入文件路径无效。');
      if (file.startsWith('game/')) continue;
      requireEvidence(file.startsWith('profile/'), '实测输入必须明确属于 profile/ 或 game/。'); target = relative(file.slice(8));
    }
    requireEvidence(Boolean(target) && !inputs.has(target.toLowerCase()), '实测 profile 输入重复或路径无效。');
    inputs.set(target.toLowerCase(), row.sha256.toLowerCase());
  }
  requireEvidence(differences === undefined || Array.isArray(differences) && differences.length <= 64, '配置差异清单无效。');
  const declared = new Map();
  for (const row of differences || []) {
    const target = relative(row?.target);
    requireEvidence(target && HASH.test(row.runSha256 || '') && HASH.test(row.packageSha256 || '') && typeof row.reason === 'string' && row.reason.trim().length > 0 && row.reason.length <= 1000 && !declared.has(target.toLowerCase()), '配置差异必须逐项给出两边摘要和明确原因。');
    declared.set(target.toLowerCase(), { target, runSha256: row.runSha256.toLowerCase(), packageSha256: row.packageSha256.toLowerCase(), reason: row.reason });
  }
  for (const file of files) {
    const key = file.target.toLowerCase(), runHash = inputs.get(key), difference = declared.get(key);
    requireEvidence(runHash, '运行包文件缺少对应的启动输入摘要。', { file: file.target });
    if (runHash !== file.sha256) {
      requireEvidence(file.mutable && difference && difference.runSha256 === runHash && difference.packageSha256 === file.sha256,
        '不可变文件与实测输入不同，或可变配置差异未明确声明。', { file: file.target });
      declared.delete(key);
    } else requireEvidence(!difference, '配置差异声明与实际相同摘要矛盾。', { file: file.target });
  }
  requireEvidence(declared.size === 0, '配置差异包含未打包文件或未匹配的声明。');
  return (differences || []).map(row => ({ ...row, target: relative(row.target) }));
}
async function acceptanceFor(plan) {
  if (plan.acceptance.status !== 'processed') return { status: 'pending', hardwareFamily: 'RTX50',
    reason: typeof plan.acceptance.reason === 'string' ? plan.acceptance.reason.slice(0, 1000) : '尚未取得完整的 600 帧实际处理验收。', scope: 'controlled-renderer', realGameVerified: false };
  const records = {}, references = {};
  const required = ['runResult', 'rendererReport', 'feederLog', 'coreLog', 'registryBefore', 'registryAfter'];
  for (const name of [...required, ...(plan.acceptance.evidence?.inputs ? ['inputs'] : [])]) {
    const ref = plan.acceptance.evidence?.[name];
    requireEvidence(ref && absolute(ref.path) && HASH.test(ref.sha256 || ''), `processed 缺少 ${name} 的本地路径及固定摘要。`);
    const bytes = await readSmall(ref.path, name.endsWith('Log') ? 16 * 1024 * 1024 : 2 * 1024 * 1024);
    requireEvidence(sha256(bytes) === ref.sha256.toLowerCase(), '实测证据文件摘要不匹配。', { evidence: name });
    records[name] = bytes; references[name] = { file: path.basename(ref.path), sha256: ref.sha256.toLowerCase(), bytes: bytes.length };
  }
  const result = json(records.runResult, '实测结果'), startedAt = Date.parse(result.startedAt);
  requireEvidence(Number.isFinite(startedAt) && startedAt > 0 && Array.isArray(result.steps), '实测启动时间或步骤无效。');
  const launch = oneStep(result, 'launch'), renderer = oneStep(result, 'renderer'), processExit = oneStep(result, 'process-exit');
  requireEvidence(Number.isInteger(launch.pid) && launch.pid > 0 && launch.elevated === false, '实测启动必须证实普通权限与具体 PID。');
  requireEvidence(processExit.pid === launch.pid && processExit.observed === true && processExit.exitCode === 0,
    '必须由本次进程句柄证实正常退出码，renderer 的 exit=clean 不能替代。');
  requireEvidence(typeof renderer.text === 'string' && records.rendererReport.equals(Buffer.from(renderer.text, 'utf8')), '独立 renderer report 与运行结果中的报告字节不同。');
  for (const name of ['rendererReport', 'feederLog', 'coreLog']) {
    const stat = await regular(plan.acceptance.evidence[name].path);
    requireEvidence(stat.mtimeMs >= startedAt, '证据日志早于本次实测启动。', { evidence: name });
  }
  const rendererInfo = rendererEvidence(renderer.text);
  const logInfo = validateLogs(records.feederLog.toString('utf8'), records.coreLog.toString('utf8'), launch.pid, rendererInfo.frames);
  const before = registryRows(json(records.registryBefore, '注册表前快照')), after = registryRows(json(records.registryAfter, '注册表后快照'));
  requireEvidence(JSON.stringify(before) === JSON.stringify(after), 'HKCU/HKLM Vulkan layer 注册表前后不一致。');
  const inputRecord = records.inputs ? json(records.inputs, '启动输入摘要') : result.inputs;
  const configDifferences = checkInputs(plan.files, Array.isArray(inputRecord) ? inputRecord : inputRecord?.files, plan.acceptance.configDifferences);
  return { status: 'processed', hardwareFamily: 'RTX50', scope: 'controlled-renderer', realGameVerified: false,
    pid: launch.pid, startedAt: result.startedAt, frames: rendererInfo.frames, gpu: rendererInfo.gpu, depthDirection: rendererInfo.depthDirection,
    evidence: references, configDifferences, ...logInfo,
    note: '受控 Vulkan renderer 的 NR 处理与同帧传输证据；不代表具体游戏、HDR 或视觉质量已验收。' };
}
async function checkDestination(destination) {
  await noLinks(destination);
  try {
    const stat = await fsp.lstat(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await fsp.readdir(destination)).length)
      fail('VULKAN_RUNTIME_DEST_NOT_EMPTY', '输出目录必须不存在或为空；不会覆盖现有运行包。');
    return stat;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function prepare(planFile, destination = DESTINATION, options = {}) {
  if (!absolute(planFile)) fail('VULKAN_RUNTIME_PLAN_INVALID', 'build-plan.json 必须使用绝对路径。');
  const planBytes = await readSmall(planFile), plan = validatePlan(json(planBytes, '运行包计划'));
  destination = path.resolve(destination);
  if (!absolute(destination) || same(destination, path.dirname(destination))) fail('VULKAN_RUNTIME_DEST_INVALID', '输出目录必须是本地绝对子目录。');
  const originalOutput = await checkDestination(destination);
  let total = 0;
  for (const file of plan.files) {
    const stat = await regular(file.source); total += stat.size;
    if (total > MAX_TOTAL) fail('VULKAN_RUNTIME_PLAN_INVALID', '运行包总大小超出限制。');
    if (await hashFile(file.source) !== file.sha256) fail('VULKAN_RUNTIME_SOURCE_HASH', '来源文件摘要漂移，未重新盖章。', { file: file.target });
    await assertX64(file.source, file.target);
    if (path.posix.basename(file.target).toLowerCase() === 'dlss5-feed.cfg') {
      const config = (await readSmall(file.source)).toString('utf8');
      const trace = [...config.matchAll(/^\s*vk_trace\s*=\s*([^\r\n#;]*)/gmi)];
      if (trace.length !== 1 || trace[0][1].trim() !== '0') fail('VULKAN_RUNTIME_CONFIG_INVALID', '生产默认 dlss5-feed.cfg 必须明确 vk_trace=0；实测 trace=1 差异应单独声明。');
    }
  }
  const acceptance = await acceptanceFor(plan);
  const recipe = { version: 1, id: plan.id, coreVersion: plan.coreVersion, sourceRevision: plan.sourceRevision, architecture: 64,
    buildPlanSha256: sha256(planBytes), acceptance,
    files: plan.files.map(({ source, ...file }) => ({ source: file.target, ...file })) };
  const parent = path.dirname(destination), stage = path.join(parent, `.${path.basename(destination)}.staging-${crypto.randomUUID()}`);
  await noLinks(parent); await fsp.mkdir(parent, { recursive: true }); await fsp.mkdir(stage);
  let published = false;
  try {
    for (const file of plan.files) {
      const target = path.resolve(stage, file.target);
      if (!inside(stage, target)) fail('VULKAN_RUNTIME_PLAN_INVALID', '输出文件路径越界。');
      await noLinks(file.source); await fsp.mkdir(path.dirname(target), { recursive: true }); await noLinks(target);
      await (options.copyFile || fsp.copyFile)(file.source, target, fs.constants.COPYFILE_EXCL);
      if (await hashFile(target) !== file.sha256) fail('VULKAN_RUNTIME_SOURCE_HASH', '复制期间来源改变，候选包未发布。', { file: file.target });
      await assertX64(target, file.target);
    }
    const handle = await fsp.open(path.join(stage, 'recipe.json'), 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(recipe, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
    const current = await checkDestination(destination);
    if (current && (!originalOutput || current.dev !== originalOutput.dev || current.ino !== originalOutput.ino))
      fail('VULKAN_RUNTIME_DEST_CHANGED', '发布前出现另一输出目录，未覆盖。');
    if (current) await fsp.rmdir(destination); // checked empty; concurrent new files make this fail
    await noLinks(destination); await fsp.rename(stage, destination); published = true;
    return { destination, files: plan.files.length, bytes: total, acceptance: acceptance.status, recipe };
  } finally {
    if (!published && inside(parent, stage) && path.basename(stage).startsWith(`.${path.basename(destination)}.staging-`)) {
      await noLinks(stage); await fsp.rm(stage, { recursive: true, force: true });
    }
  }
}

if (require.main === module) {
  if (process.argv.length !== 3 && process.argv.length !== 4) {
    console.error('Usage: node scripts/prepare-vulkan-runtime.js <absolute-build-plan.json> [destination]'); process.exitCode = 1;
  } else prepare(path.resolve(process.argv[2]), process.argv[3] || DESTINATION).then(result => console.log(JSON.stringify(result, null, 2)), error => {
    console.error(JSON.stringify({ code: error.code || 'VULKAN_RUNTIME_PREPARE_FAILED', message: error.message, details: error.details })); process.exitCode = 1;
  });
}

module.exports = { DESTINATION, prepare, validatePlan, acceptanceFor, validateLogs, rendererEvidence, checkInputs, sha256 };
