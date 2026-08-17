'use strict';

/**
 * 轻量结构化日志：
 * - 内存环形缓冲供控制台增量读取
 * - JSON Lines 持久化供故障排查和离线分析
 * - 日志等级、来源、事件名与 runId 形成稳定检索维度
 */

const fs = require('fs');
const path = require('path');

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const SENSITIVE_KEY = /pass(word)?|token|secret|cookie|authorization|proxy/i;

function normalizeLevel(level) {
  return Object.prototype.hasOwnProperty.call(LEVELS, level) ? level : 'info';
}

function redact(value, depth = 0) {
  if (depth > 6) return '[MAX_DEPTH]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(item, depth + 1);
  }
  return out;
}

function safeFileStamp(date) {
  return date.toISOString().slice(0, 10);
}

function createLogger(options = {}) {
  const capacity = Number.isInteger(options.capacity) && options.capacity > 0 ? options.capacity : 2000;
  let directory = options.directory ? path.resolve(options.directory) : null;
  const service = options.service || 'app';
  const minLevel = normalizeLevel(options.minLevel || 'info');
  const buffer = [];
  let sequence = 0;

  if (directory) {
    try {
      fs.mkdirSync(directory, { recursive: true });
    } catch (error) {
      process.stderr.write(`[logger] directory unavailable, using memory only: ${error.message}\n`);
      directory = null;
    }
  }

  function persist(entry) {
    if (!directory) return;
    try {
      const file = path.join(directory, `${service}-${safeFileStamp(new Date(entry.t))}.jsonl`);
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      // 持久化失败不能拖垮任务；stderr 仍给进程管理器留下诊断线索。
      process.stderr.write(`[logger] persist failed: ${error.message}\n`);
    }
  }

  function log(level, message, context = {}) {
    const normalized = normalizeLevel(level);
    if (LEVELS[normalized] < LEVELS[minLevel]) return null;
    const cleanContext = redact(context);
    const entry = {
      ...cleanContext,
      n: sequence++,
      t: new Date().toISOString(),
      level: normalized,
      source: cleanContext.source || service,
      event: cleanContext.event || null,
      runId: cleanContext.runId || null,
      line: String(message).replace(/\r?\n$/, ''),
    };
    buffer.push(entry);
    if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity);
    persist(entry);
    return entry;
  }

  function tail(options = {}) {
    const since = Number.isFinite(Number(options.since)) ? Math.max(0, Number(options.since)) : 0;
    const level = options.level && LEVELS[options.level] != null ? options.level : null;
    return buffer.filter((entry) => entry.n >= since && (!level || LEVELS[entry.level] >= LEVELS[level]));
  }

  return {
    debug: (message, context) => log('debug', message, context),
    info: (message, context) => log('info', message, context),
    warn: (message, context) => log('warn', message, context),
    error: (message, context) => log('error', message, context),
    log,
    tail,
    get sequence() { return sequence; },
  };
}

/** 将任意 stream chunk 还原为完整文本行。 */
function createLineBuffer(onLine) {
  let pending = '';

  return {
    push(chunk) {
      pending += String(chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) onLine(line);
    },
    flush() {
      if (!pending) return;
      const line = pending;
      pending = '';
      onLine(line);
    },
  };
}

module.exports = { createLogger, createLineBuffer, redact, LEVELS };
