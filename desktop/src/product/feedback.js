'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { noLinks, inside } = require('./launch-safety');
const { DIRECTORY: FEEDER_DIRECTORY } = require('./feeder-runtime');

const MAX_LOG_BYTES = 256 * 1024;
const MAX_OPERATIONS = 80;
const LOG_EXCERPT_BYTES = 24 * 1024;

function trimText(value, max = MAX_LOG_BYTES) {
  const text = String(value || '').replace(/\u0000/g, '');
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  const bytes = Buffer.from(text, 'utf8');
  return `...[前面的内容已截断，保留最后 ${Math.round(max / 1024)} KB]...\n${bytes.subarray(-max).toString('utf8')}`;
}

async function readLogTail(file) {
  await noLinks(file);
  const handle = await fs.promises.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return '';
    const length = Math.min(stat.size, LOG_EXCERPT_BYTES), buffer = Buffer.alloc(length);
    if (stat.size <= length) {
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8').replace(/\u0000/g, '');
    }
    const headSize = 4096, tailSize = length - headSize;
    const head = await handle.read(buffer, 0, headSize, 0);
    const tail = await handle.read(buffer, headSize, tailSize, stat.size - tailSize);
    return buffer.subarray(0, head.bytesRead).toString('utf8').replace(/\u0000/g, '') +
      '\n...[省略中间日志；保留启动信息和最近错误，总计最多 24 KB]...\n' +
      buffer.subarray(headSize, headSize + tail.bytesRead).toString('utf8').replace(/\u0000/g, '');
  } finally { await handle.close(); }
}

function redactPath(value) {
  if (typeof value !== 'string') return value;
  const home = os.homedir();
  return value
    .replace(new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '%USERPROFILE%')
    .replace(/([A-Za-z]:[\\/]+Users[\\/])[^\\/]+/gi, '$1%USERNAME%');
}

function safeJson(value, includePaths = false) {
  if (typeof value === 'string') return includePaths ? value : redactPath(value);
  if (Array.isArray(value)) return value.map(item => safeJson(item, includePaths));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeJson(item, includePaths)]));
}

function createFeedbackCollector({ userData, productVersion = '0.0.0', resolveFeederLogDirectory = null }) {
  const feedbackDir = path.join(userData, 'feedback');
  const operationsFile = path.join(feedbackDir, 'operations.jsonl');

  async function record(entry) {
    try {
      await fs.promises.mkdir(feedbackDir, { recursive: true });
      const row = {
        time: new Date().toISOString(),
        ...safeJson(entry, false)
      };
      await fs.promises.appendFile(operationsFile, `${JSON.stringify(row)}\n`, 'utf8');
      const lines = (await fs.promises.readFile(operationsFile, 'utf8')).split(/\r?\n/).filter(Boolean);
      if (lines.length > MAX_OPERATIONS) {
        await fs.promises.writeFile(operationsFile, `${lines.slice(-MAX_OPERATIONS).join('\n')}\n`, 'utf8');
      }
    } catch {
      // A diagnostic logger must never turn a successful install into a failure.
    }
  }

  async function readOperations(gameId = null) {
    try {
      const lines = (await fs.promises.readFile(operationsFile, 'utf8')).split(/\r?\n/).filter(Boolean);
      const rows = lines.slice(-MAX_OPERATIONS).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      const related = gameId ? rows.filter(row => row.gameId === gameId) : [];
      return (related.length ? related : rows).slice(-30);
    } catch {
      return [];
    }
  }

  async function readLogs(gameDir, executableDir, managedLogDirs = [], feederLogDirectory = null) {
    const names = new Set([
      'ReShade.log',
      'nr-before-sr.log',
      'nr-before-sr.previous.log',
      'nr_before_sr.log',
      'dlss5.log', 'dlss5-feed.log'
    ]);
    const files = [];
    const external = managedLogDirs.filter(dir => typeof dir === 'string' && path.isAbsolute(dir) &&
      (inside(path.resolve(userData), path.resolve(dir)) || gameDir && path.resolve(dir).toLowerCase() === path.resolve(gameDir, '_storage_').toLowerCase())).slice(0, 2);
    // Only the collector's internal resolver may authorize Feeder logs. Even
    // then, independently enforce the fixed directory beside the selected EXE.
    const feeder = typeof feederLogDirectory === 'string' && path.isAbsolute(feederLogDirectory) &&
      typeof gameDir === 'string' && path.isAbsolute(gameDir) && typeof executableDir === 'string' && path.isAbsolute(executableDir) &&
      inside(gameDir, executableDir) && path.resolve(feederLogDirectory).toLowerCase() === path.resolve(executableDir, FEEDER_DIRECTORY, 'addons').toLowerCase()
      ? [feederLogDirectory] : [];
    for (const dir of [...feeder, ...external, executableDir, gameDir]) {
      if (!dir || !fs.existsSync(dir)) continue;
      let entries = [];
      try { await noLinks(dir); entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (files.length >= 4) return files;
        if (!entry.isFile() || !names.has(entry.name)) continue;
        const file = path.join(dir, entry.name);
        if (files.some(row => row.file.toLowerCase() === file.toLowerCase())) continue;
        try {
          files.push({ name: entry.name, file, text: await readLogTail(file) });
        } catch {}
      }
    }
    return files;
  }

  function formatOperations(rows, includePaths) {
    if (!rows.length) return '暂无管理器操作记录。';
    return rows.map(row => {
      const status = row.outcome || (row.ok ? '成功' : '失败');
      const code = row.errorCode ? ` [${row.errorCode}]` : '';
      const detail = row.errorMessage ? `：${row.errorMessage}` : '';
      return `${row.time || '-'} | ${row.action || '-'} | ${status}${code}${detail}`;
    }).join('\n');
  }

  function deploymentLine(diagnostic) {
    const api = diagnostic && diagnostic.deploymentApi;
    if (!api) return '已部署 API：未记录';
    if (String(api).toLowerCase() !== 'vulkan') return `已部署 API：${api}`;
    const state = String(diagnostic.deploymentState || '').toLowerCase();
    const readyState = ['ready', 'installed', 'deployed'].includes(state);
    const incompleteState = ['pending', 'prepared', 'incomplete', 'recovery-required', 'failed'].includes(state);
    const components = new Map((diagnostic.components || []).map(row => [row && row.key, row]));
    const layer = components.get('vulkan-layer');
    const activation = components.get('vulkan-activation');
    const ready = diagnostic.pending !== true && !incompleteState && (readyState || diagnostic.complete === true ||
      Boolean(layer && activation && layer.ok === true && activation.ok === true));
    return ready ? '已部署 API：vulkan' : '部署状态：Vulkan 准备未完成';
  }

  async function buildReport({ game, diagnostic = null, hardware = null, payload = null, settings = null, gameId = null, includePaths = false, managedLogDirs = [], installationAdoption = null }) {
    const chosen = game && game.chosen ? game.chosen : null;
    const executable = chosen && chosen.path ? chosen.path : null;
    const gameDir = game && game.dir ? game.dir : null;
    const executableDir = executable ? path.dirname(executable) : gameDir;
    let feederLogDirectory = null;
    try { if (typeof resolveFeederLogDirectory === 'function') feederLogDirectory = await resolveFeederLogDirectory(game); }
    catch { /* A missing or invalid receipt must not prevent the diagnostic TXT. */ }
    const [operations, logs] = await Promise.all([
      readOperations(gameId),
      readLogs(gameDir, executableDir, managedLogDirs, feederLogDirectory)
    ]);
    const payloadSummary = payload ? {
      selectedVersion: payload.selectedVersion || null,
      ready: Boolean(payload.ready),
      missing: payload.missing || [],
      invalid: payload.invalid || []
    } : null;
    const report = [
      'DLSS 5 AI 超分管理器 · 问题反馈日志',
      '请把这个 TXT 文件完整发给开发者；管理器不会自动上传。',
      `生成时间：${new Date().toISOString()}`,
      `管理器版本：${productVersion}`,
      `系统：${process.platform} ${process.arch} ${os.release()}`,
      '',
      '[游戏]',
      `名称：${game && game.name ? game.name : '未知'}`,
      `来源：${game && game.launcher ? game.launcher : '未知'}`,
      `游戏目录：${includePaths ? gameDir || '未知' : redactPath(gameDir || '未知')}`,
      `运行程序：${includePaths ? executable || '未知' : redactPath(executable || '未知')}`,
      `图形 API：${chosen && chosen.apiLabel ? chosen.apiLabel : '未知'}`,
      `API 选择：${game && game.apiOverride ? game.apiOverride : 'auto'}`,
      `API 证据：${chosen && chosen.apiResolution ? JSON.stringify(safeJson(chosen.apiResolution, includePaths)) : '未记录'}`,
      deploymentLine(diagnostic),
      `位数：${chosen && chosen.bitness ? chosen.bitness : '未知'}`,
      '',
      '[硬件与组件]',
      `显卡匹配：${hardware ? JSON.stringify(safeJson(hardware, includePaths)) : '未知'}`,
      `组件版本：${payloadSummary ? JSON.stringify(payloadSummary) : '未知'}`,
      `游戏设置：${settings ? JSON.stringify(safeJson(settings, includePaths)) : '未读取'}`,
      `旧安装接管：${installationAdoption ? JSON.stringify(safeJson(installationAdoption, includePaths)) : '未检查'}`,
      '',
      '[当前诊断]',
      diagnostic ? `完整：${diagnostic.complete ? '是' : '否'}\n${(diagnostic.components || []).map(row => `${row.label}：${row.detail || (row.ok ? '完整' : '异常')}`).join('\n')}` : '诊断未生成。',
      ...(diagnostic?.sourceNotice ? [`修复来源：${diagnostic.sourceNotice}`] : []),
      ...(diagnostic?.availableUpdate ? [`可用更新：${diagnostic.availableUpdate.from} → ${diagnostic.availableUpdate.to}（与已装文件完整性分开）`] : []),
      '',
      '[最近管理器操作]',
      formatOperations(operations, includePaths),
      '',
      '[相关运行日志]'
    ];
    if (!logs.length) report.push('未找到 ReShade.log 或 nr-before-sr.log。');
    for (const log of logs) report.push(`--- ${log.name} ---\n${includePaths ? log.text : redactPath(log.text)}`);
    return {
      text: `${report.join('\n')}\n`,
      suggestedName: `DLSS5-反馈-${String(game && game.name || '未知游戏').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 40)}-${new Date().toISOString().replace(/[.:]/g, '-')}.txt`
    };
  }

  return { record, buildReport, readOperations, operationsFile };
}

module.exports = { createFeedbackCollector, redactPath, trimText, safeJson };
