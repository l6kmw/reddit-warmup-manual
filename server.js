#!/usr/bin/env node
'use strict';
/**
 * server.js — 手动控制版 Reddit 养号 HTTP 服务入口
 *
 * 启动方式：
 *   node server.js [--port 8787]   # 或环境变量 PORT=8787
 *
 * 打开 http://127.0.0.1:8787 即见 HTML 控制台。
 *
 * API：
 *   GET  /                → 内置控制台页面
 *   GET  /api/status      → 当前任务状态 + 最近日志
 *   GET  /api/logs?since= → 增量日志（since 为已读行号）
 *   GET  /api/subs        → 可用板块池（SUB_POOL）
 *   POST /api/run         → 启动养号任务（JSON body 为配置，见 lib/runner.js parseConfigFile）
 *   POST /api/stop        → 停止当前任务（SIGTERM → 优雅关闭 profile）
 *
 * 任务通过子进程 node lib/runner.js --config <tmp.json> 执行，
 * 配置写入临时文件避免 shell 转义问题；日志实时进入内存环形缓冲。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const RUNNER = path.join(ROOT, 'lib', 'runner.js');
const ENGINE_ROOT = path.join(ROOT, 'engine');
const { parseConfig, strList } = require(path.join(ROOT, 'lib', 'config'));
const { fetchRuleSnapshots } = require(path.join(ROOT, 'lib', 'runner'));
const { createLogger, createLineBuffer, parseStructuredLogLine } = require(path.join(ROOT, 'lib', 'logger'));

// ---- 配置 ----
function parsePort(argv) {
  const idx = argv.indexOf('--port');
  if (idx >= 0 && argv[idx + 1]) {
    const p = Number(argv[idx + 1]);
    if (Number.isInteger(p) && p > 0 && p < 65536) return p;
  }
  const env = Number(process.env.PORT);
  if (Number.isInteger(env) && env > 0 && env < 65536) return env;
  return 8787;
}
const PORT = parsePort(process.argv.slice(2));

// ---- 结构化日志：内存增量读取 + logs/server-YYYY-MM-DD.jsonl 持久化 ----
const logger = createLogger({
  service: 'server',
  directory: path.join(ROOT, 'logs'),
  capacity: 2000,
  minLevel: process.env.LOG_LEVEL || 'info',
});
function appendLog(line, context = {}) {
  return logger.log(context.level || 'info', line, context);
}
function tailLogs(since = 0, level = null) {
  return logger.tail({ since, level });
}

// ---- 任务状态 ----
let job = null; // { child, startedAt, config, stopped, exitCode, stoppedBy }
let lastRun = null; // 最近一次任务摘要（用于页面回显）

function setJob(next) {
  job = next;
}

function statusPayload() {
  return {
    running: Boolean(job),
    startedAt: job?.startedAt || null,
    runId: job?.runId || null,
    config: job?.config || null,
    stopped: job?.stopped || false,
    exitCode: job?.exitCode ?? null,
    stoppedBy: job?.stoppedBy || null,
    lastRun,
  };
}

// ---- 读取板块池 ----
function loadSubPool() {
  try {
    const { SUB_POOL } = require(path.join(ENGINE_ROOT, 'scripts', 'warmup'));
    return Array.isArray(SUB_POOL) ? SUB_POOL : [];
  } catch {
    return [];
  }
}

// ---- 静态文件 ----
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendFile(res, filePath) {
  const abs = path.join(PUBLIC_DIR, filePath);
  if (!abs.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  fs.readFile(abs, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---- body 解析 ----
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error('body 过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, code, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

// ---- 启动任务 ----
async function startJob(config) {
  if (job) {
    return { ok: false, code: 409, error: '已有任务在运行，请先停止' };
  }
  // 服务端先校验：明显错误直接 400，不 spawn 子进程
  let normalized;
  try {
    normalized = parseConfig(config);
  } catch (error) {
    return { ok: false, code: 400, error: error.message };
  }
  // 配置写入临时文件
  const tmpFile = path.join(os.tmpdir(), `reddit-warmup-manual-${Date.now()}-${process.pid}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(normalized, null, 2), 'utf8');

  const child = spawn(process.execPath, [RUNNER, '--config', tmpFile], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const startedAt = new Date();
  const runId = `${startedAt.toISOString().replace(/\D/g, '').slice(0, 14)}-${child.pid}`;
  setJob({ child, startedAt, runId, config: normalized, stopped: false, exitCode: null, stoppedBy: null, tmpFile });

  appendLog(`[server] 任务已启动 ${startedAt.toLocaleString('zh-CN')} (pid ${child.pid})`, { event: 'job.started', runId, pid: child.pid });
  appendLog('[server] 配置已校验', { event: 'job.configured', runId, config: normalized });

  const stdoutLines = createLineBuffer((line) => {
    if (line.trim()) appendLog(line, { source: 'runner', event: line.startsWith('@@STATUS@@') ? 'runner.status' : 'runner.output', runId });
  });
  const stderrLines = createLineBuffer((line) => {
    if (!line.trim()) return;
    const parsed = parseStructuredLogLine(line, 'error');
    appendLog(`[stderr] ${line}`, {
      level: parsed.level,
      source: 'runner',
      event: parsed.event || 'runner.stderr',
      runId,
      stream: 'stderr',
    });
  });
  child.stdout.on('data', (chunk) => stdoutLines.push(chunk));
  child.stderr.on('data', (chunk) => stderrLines.push(chunk));
  child.on('error', (error) => {
    appendLog(`[server] 子进程启动失败: ${error.message}`, { level: 'error', event: 'job.spawn_error', runId, error: { message: error.message, code: error.code } });
  });
  child.on('close', (code, signal) => {
    stdoutLines.flush();
    stderrLines.flush();
    const exitCode = code == null ? 'signal' : code;
    lastRun = { runId, finishedAt: new Date().toISOString(), exitCode, signal: signal || null, config: job?.config || config, stoppedBy: job?.stoppedBy || null };
    appendLog(`[server] 任务结束，退出码 ${exitCode}`, { level: exitCode === 0 ? 'info' : 'warn', event: 'job.finished', runId, exitCode, signal: signal || null });
    if (job?.tmpFile) {
      try { fs.unlinkSync(job.tmpFile); } catch { /* ignore */ }
    }
    setJob(null);
  });
  return { ok: true, startedAt, pid: child.pid };
}

// ---- 停止任务 ----
function stopJob() {
  if (!job || job.stopped) return { ok: false, error: '当前没有运行中的任务' };
  job.stopped = true;
  job.stoppedBy = 'user';
  appendLog('[server] 收到停止请求，发送 SIGTERM...', { level: 'warn', event: 'job.stop_requested', runId: job.runId, pid: job.child.pid });
  try {
    job.child.kill('SIGTERM');
  } catch {
    // 进程已退出则忽略
  }
  return { ok: true };
}

// ==================== 私信触达（Outreach）模块 ====================
// 独立于养号 job 的 outreach job（discover / send 二选一运行），
// 前后端通过 /api/outreach/* 交互；子进程 Stdout 协议与 runner 一致。

const OUTREACH_DISCOVER = path.join(ROOT, 'lib', 'outreach', 'discover.js');
const OUTREACH_SENDER = path.join(ROOT, 'lib', 'outreach', 'sender.js');
const OUTREACH_REPLIER = path.join(ROOT, 'lib', 'outreach', 'replier.js');
const OUTREACH_QUEUE = path.join(ROOT, 'lib', 'outreach', 'queue.js');
const { parseOutreachConfig, SUB_KEYWORD_PRESETS } = require(path.join(ROOT, 'lib', 'config'));
const {
  readQueue, listQueue, queueStats, dailySentCount, enqueueCandidates, STATUS,
} = require(OUTREACH_QUEUE);

let outreachJob = null; // { kind, child, startedAt, config, stopped, exitCode, stoppedBy }

function outreachStatusPayload() {
  return {
    running: Boolean(outreachJob),
    kind: outreachJob?.kind || null,
    startedAt: outreachJob?.startedAt || null,
    stopped: outreachJob?.stopped || false,
    exitCode: outreachJob?.exitCode ?? null,
    stoppedBy: outreachJob?.stoppedBy || null,
    queue: queueStats(),
    dailySent: dailySentCount(),
  };
}

function writeTmpConfig(config) {
  const tmpFile = path.join(os.tmpdir(), `reddit-outreach-${Date.now()}-${process.pid}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2), 'utf8');
  return tmpFile;
}

function stopOutreachJob() {
  if (!outreachJob || outreachJob.stopped) return { ok: false, error: '当前没有运行中的 outreach 任务' };
  outreachJob.stopped = true;
  outreachJob.stoppedBy = 'user';
  appendLog('[server] 收到 outreach 停止请求，发送 SIGTERM...', { level: 'warn', event: 'outreach.stop_requested', kind: outreachJob.kind, pid: outreachJob.child.pid });
  try { outreachJob.child.kill('SIGTERM'); } catch { /* ignore */ }
  return { ok: true };
}

// ==================== 后台客服回复调度（replier 定时轮询） ====================

const DEFAULT_REPLY_INTERVAL_MS = 10 * 60 * 1000; // 默认 10 分钟
let replyJob = null; // { config, intervalMs, timer, running, nextRunAt, startedAt, stopped, runCount, lastResult, lastError }

function replyStatusPayload() {
  return {
    enabled: Boolean(replyJob && !replyJob.stopped),
    running: Boolean(replyJob && replyJob.running),
    intervalMs: replyJob?.intervalMs || null,
    startedAt: replyJob?.startedAt || null,
    stopped: Boolean(replyJob?.stopped),
    nextRunAt: replyJob?.nextRunAt || null,
    runCount: replyJob?.runCount || 0,
    lastResult: replyJob?.lastResult || null,
    lastError: replyJob?.lastError || null,
  };
}

/** 立即跑一轮 replier 子进程（复用 startOutreach 槽位；被手动任务占用则跳过） */
function runReplyRound(config) {
  if (!replyJob || replyJob.stopped) return;
  if (outreachJob) {
    appendLog('[server] 有手动 outreach 任务在运行，客服回复本轮跳过', { level: 'info', event: 'reply.tick_skipped' });
    replyJob.nextRunAt = Date.now() + (replyJob.intervalMs || DEFAULT_REPLY_INTERVAL_MS);
    return;
  }
  const started = startOutreach('replier', config);
  if (!started.ok) {
    appendLog(`[server] 客服回复子进程启动失败: ${started.error}`, { level: 'warn', event: 'reply.spawn_fail' });
    replyJob.nextRunAt = Date.now() + (replyJob.intervalMs || DEFAULT_REPLY_INTERVAL_MS);
    return;
  }
  replyJob.running = true;
  appendLog(`[server] 客服回复第 ${replyJob.runCount + 1} 轮开始 (pid ${started.pid})`, { event: 'reply.round_started', runCount: replyJob.runCount + 1, pid: started.pid });
}

/**
 * 启动后台客服回复任务（定时轮询）。
 * @param {object} config replier 配置（target/provider/maxReplies/dryRun）
 * @param {number} intervalMs 轮询间隔（>=60000）
 * @returns {{ok: boolean, error?: string, status?: object}}
 */
function startReplyJob(config, intervalMs) {
  if (replyJob && !replyJob.stopped) return { ok: false, code: 409, error: '客服回复任务已在运行，请先停止' };
  if (!config || !config.target || !config.target.type || !config.target.value) return { ok: false, error: '缺少 target' };
  const interval = Number(intervalMs || DEFAULT_REPLY_INTERVAL_MS);
  if (!Number.isFinite(interval) || interval < 60000) return { ok: false, error: 'intervalMs 必须 >= 60000' };

  const timer = setInterval(() => {
    if (!replyJob || replyJob.stopped) { clearInterval(timer); return; }
    runReplyRound(replyJob.config);
  }, interval);
  if (timer.unref) timer.unref();

  replyJob = { config, intervalMs: interval, timer, running: false, nextRunAt: Date.now() + interval, startedAt: new Date(), stopped: false, runCount: 0, lastResult: null, lastError: null };
  appendLog(`[server] 客服回复后台任务已启动（间隔 ${Math.round(interval / 1000)}s）`, { event: 'reply.started', intervalMs: interval, target: config.target });
  runReplyRound(config);
  return { ok: true, status: replyStatusPayload() };
}

/** 停止后台客服回复任务 */
function stopReplyJob() {
  if (!replyJob) return { ok: false, error: '客服回复任务未启动' };
  replyJob.stopped = true;
  if (replyJob.timer) clearInterval(replyJob.timer);
  if (replyJob.running) {
    appendLog('[server] 收到客服回复停止请求，发送 SIGTERM...', { level: 'warn', event: 'reply.stop_requested' });
    try { outreachJob?.child?.kill('SIGTERM'); } catch { /* ignore */ }
  } else {
    replyJob = null;
  }
  appendLog('[server] 客服回复后台任务已停止', { event: 'reply.stopped' });
  return { ok: true };
}

/**
 * 启动 outreach 子进程（discover / sender / replier），接入现有日志体系。
 * discover 子进程结尾写一行 JSON 结果到 stdout，此处捕获用于入队/回显。
 */
function startOutreach(kind, config) {
  if (outreachJob) return { ok: false, code: 409, error: '已有 outreach 任务在运行，请先停止' };
  if (job) return { ok: false, code: 409, error: '养号任务运行中，不能同时启动 outreach（互斥锁语义）' };
  const script = kind === 'discover' ? OUTREACH_DISCOVER : kind === 'replier' ? OUTREACH_REPLIER : OUTREACH_SENDER;
  const tmpFile = writeTmpConfig(config);

  const child = spawn(process.execPath, [script, '--config', tmpFile], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const startedAt = new Date();
  const runId = `${startedAt.toISOString().replace(/\D/g, '').slice(0, 14)}-${child.pid}`;
  outreachJob = { kind, child, startedAt, runId, config, stopped: false, exitCode: null, stoppedBy: null, tmpFile };

  appendLog(`[server] outreach ${kind} 任务已启动 ${startedAt.toLocaleString('zh-CN')} (pid ${child.pid})`, { event: 'outreach.started', kind, runId, pid: child.pid });

  // discover：捕获 stdout 里的 JSON 结果行（@@OUTREACH_JSON@@ + JSON），用于入队
  const stdoutLines = createLineBuffer((line) => {
    if (!line.trim()) return;
    if (line.startsWith('@@OUTREACH_JSON@@')) {
      try {
        const payload = JSON.parse(line.slice('@@OUTREACH_JSON@@'.length));
        outreachJob.lastResult = payload;
        if (payload && payload.ok && Array.isArray(payload.candidates)) {
          const enqueued = enqueueCandidates(payload.candidates, {
            template: config.template || '',
            sub: config.sub || '',
          });
          outreachJob.enqueueSummary = enqueued;
          appendLog(`[server] discover 完成，入队 ${enqueued.added} 条候选，拒绝 ${enqueued.rejected.length} 条`, {
            event: 'outreach.discover_enqueued', runId, added: enqueued.added, rejected: enqueued.rejected.length,
          });
        }
      } catch (error) {
        appendLog(`[server] outreach JSON 结果解析失败: ${error.message}`, { level: 'warn', event: 'outreach.result_parse_error', runId });
      }
      return;
    }
    appendLog(line, { source: 'outreach', event: line.startsWith('@@STATUS@@') ? 'outreach.status' : 'outreach.output', runId });
  });
  const stderrLines = createLineBuffer((line) => {
    if (!line.trim()) return;
    const parsed = parseStructuredLogLine(line, 'error');
    appendLog(`[outreach stderr] ${line}`, { level: parsed.level, source: 'outreach', event: parsed.event || 'outreach.stderr', runId, stream: 'stderr' });
  });
  child.stdout.on('data', (chunk) => stdoutLines.push(chunk));
  child.stderr.on('data', (chunk) => stderrLines.push(chunk));
  child.on('error', (error) => {
    appendLog(`[server] outreach 子进程启动失败: ${error.message}`, { level: 'error', event: 'outreach.spawn_error', runId, error: { message: error.message, code: error.code } });
  });
  child.on('close', (code, signal) => {
    stdoutLines.flush();
    stderrLines.flush();
    const exitCode = code == null ? 'signal' : code;
    outreachJob.exitCode = exitCode;
    const lastResult = outreachJob?.lastResult || null;
    appendLog(`[server] outreach ${kind} 结束，退出码 ${exitCode}`, { level: exitCode === 0 ? 'info' : 'warn', event: 'outreach.finished', kind, runId, exitCode, signal: signal || null });
    if (outreachJob?.tmpFile) {
      try { fs.unlinkSync(outreachJob.tmpFile); } catch { /* ignore */ }
    }
    outreachJob = null;
    // 后台客服回复调度：一轮结束，更新状态并排定下一轮
    if (kind === 'replier' && replyJob) {
      replyJob.running = false;
      replyJob.runCount += 1;
      replyJob.lastResult = lastResult;
      replyJob.lastError = exitCode === 0 ? null : `exit_${exitCode}`;
      replyJob.nextRunAt = Date.now() + (replyJob.intervalMs || DEFAULT_REPLY_INTERVAL_MS);
      appendLog(`[server] 客服回复第 ${replyJob.runCount} 轮完成（exit ${exitCode}）`, { level: exitCode === 0 ? 'info' : 'warn', event: 'reply.round_finished', runCount: replyJob.runCount, exitCode });
    }
  });
  return { ok: true, startedAt, pid: child.pid, runId };
}

// ---- 审计报告读取 ----
function readOutreachReport(dateStr) {
  const date = dateStr || new Date().toISOString().slice(0, 10);
  const file = path.join(ROOT, 'logs', `outreach-${date}.jsonl`);
  if (!fs.existsSync(file)) return { date, entries: [] };
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* 跳过损坏行 */ }
  }
  return { date, entries };
}

// ---- 路由 ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'GET' && pathname === '/') {
      return sendFile(res, 'index.html');
    }
    if (req.method === 'GET' && (pathname.startsWith('/public/') || pathname.startsWith('/assets/'))) {
      return sendFile(res, pathname.replace(/^\//, ''));
    }
    if (req.method === 'GET' && pathname === '/api/status') {
      return json(res, 200, statusPayload());
    }
    if (req.method === 'GET' && pathname === '/api/logs') {
      const since = Number(url.searchParams.get('since') || 0);
      const level = url.searchParams.get('level');
      const logs = tailLogs(since, level);
      return json(res, 200, { since: logger.sequence, logs });
    }
    if (req.method === 'GET' && pathname === '/api/subs') {
      return json(res, 200, { subs: loadSubPool(), mode: ['specified', 'random'] });
    }
    if (req.method === 'GET' && pathname === '/api/outreach/presets') {
      return json(res, 200, { presets: SUB_KEYWORD_PRESETS });
    }
    if (req.method === 'GET' && pathname === '/api/outreach/status') {
      return json(res, 200, outreachStatusPayload());
    }
    if (req.method === 'GET' && pathname === '/api/outreach/queue') {
      const status = url.searchParams.get('status') || null;
      const items = listQueue({ status: status === 'all' || !status ? null : status, limit: 500 });
      return json(res, 200, { items, stats: queueStats(), dailySent: dailySentCount() });
    }
    if (req.method === 'GET' && pathname === '/api/outreach/report') {
      return json(res, 200, readOutreachReport(url.searchParams.get('date') || undefined));
    }
    if (req.method === 'POST' && pathname === '/api/outreach/discover') {
      const body = await readBody(req);
      let config;
      try {
        config = parseOutreachConfig(body);
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
      const result = startOutreach('discover', config);
      if (!result.ok) return json(res, result.code || 400, result);
      return json(res, 200, result);
    }
    if (req.method === 'POST' && pathname === '/api/outreach/send') {
      const body = await readBody(req);
      let config;
      try {
        config = parseOutreachConfig(body);
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
      // 发送前置检查：队列里必须有 pending
      const pendingCount = listQueue({ status: STATUS.PENDING }).length;
      if (pendingCount === 0) {
        return json(res, 400, { error: '队列中没有待发送（pending）候选，请先运行 discover' });
      }
      const result = startOutreach('sender', config);
      if (!result.ok) return json(res, result.code || 400, result);
      return json(res, 200, result);
    }
    if (req.method === 'POST' && pathname === '/api/outreach/stop') {
      return json(res, 200, stopOutreachJob());
    }
    // 客服回复：后台定时任务 start/stop/status
    if (req.method === 'GET' && pathname === '/api/outreach/reply/status') {
      return json(res, 200, replyStatusPayload());
    }
    if (req.method === 'POST' && pathname === '/api/outreach/reply/start') {
      const body = await readBody(req);
      const result = startReplyJob(body.config, Number(body.intervalMs));
      if (!result.ok) return json(res, result.code || 400, result);
      return json(res, 200, result);
    }
    if (req.method === 'POST' && pathname === '/api/outreach/reply/stop') {
      return json(res, 200, stopReplyJob());
    }
    if (req.method === 'POST' && pathname === '/api/rules') {
      if (job) return json(res, 409, { error: '养号任务运行中，不能同时读取规则' });
      const body = await readBody(req);
      if (!['serial', 'profiles', 'group'].includes(body.target?.type) || !body.target?.value) {
        return json(res, 400, { error: '请填写有效目标账号' });
      }
      const subs = [...new Set(strList(body.subs))];
      if (!subs.length) return json(res, 400, { error: '请填写社区' });
      return json(res, 200, await fetchRuleSnapshots(body.target, subs));
    }
    if (req.method === 'POST' && pathname === '/api/run') {
      const config = await readBody(req);
      const result = await startJob(config);
      if (!result.ok) return json(res, result.code || 400, result);
      return json(res, 200, result);
    }
    if (req.method === 'POST' && pathname === '/api/stop') {
      return json(res, 200, stopJob());
    }
    if (req.method === 'GET' && pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    json(res, 404, { error: `Not Found: ${req.method} ${pathname}` });
  } catch (error) {
    appendLog(`[server] 请求处理失败: ${error.message}`, { level: 'error', event: 'http.request_error', method: req.method, pathname, error: { message: error.message } });
    json(res, 400, { error: error.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  appendLog(`[server] 手动控制版已启动: http://127.0.0.1:${PORT}`, { event: 'server.started', port: PORT });
  console.log(`手动控制版 Reddit 养号已启动 → http://127.0.0.1:${PORT}`);
  console.log('按 Ctrl+C 退出服务（运行中的养号任务会收到 SIGTERM 优雅关闭）。');
});

// 服务退出时清理子进程
function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在退出服务...`);
  if (job && !job.stopped) {
    appendLog(`[server] 服务退出，停止任务 (pid ${job.child.pid})`, { level: 'warn', event: 'server.shutdown_job', runId: job.runId, signal, pid: job.child.pid });
    try { job.child.kill('SIGTERM'); } catch { /* ignore */ }
  }
  setTimeout(() => process.exit(0), 1500).unref();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
