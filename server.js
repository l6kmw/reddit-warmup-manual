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
const SKILLS_ROOT = path.resolve(ROOT, '..', 'reddit-warmup-skills', 'reddit-warmup');
const { parseConfig } = require(path.join(ROOT, 'lib', 'config'));
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
    const { SUB_POOL } = require(path.join(SKILLS_ROOT, 'scripts', 'warmup'));
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
