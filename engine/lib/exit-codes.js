'use strict';
/**
 * exit-codes.js — 统一退出码语义（对应优化计划 P0-7）
 *
 * 语义约定（注意与常见 0/1/2 约定不同，本仓库"安全拒绝"是常态而非错误）：
 *   OK=0        成功，含预期内的策略性跳过（如频率已达上限、档位拒绝已报告）
 *   BLOCKED=1   业务/资格拒绝：档位不足、shadowban 命中、ai-tone 拦截、质量门拒绝
 *               —— 不可在本状态下重试，需人工介入或等条件变化
 *   ENV_ERROR=2 环境/系统错误：AdsPower 未启动、playwright 缺失、网络超时、依赖损坏
 *               —— 可重试（指数退避）
 *
 * 设计要点：
 *   - 所有脚本通过 exitWith() 统一出口，禁止散落 process.exit
 *   - --json 模式下进程退出码与 JSON 输出的 meta.exit_code 恒一致
 *   - 帮助函数不抛异常，直接设置退出码并打印消息
 */
'use strict';

const OK = 0;          // 成功（含策略性跳过）
const BLOCKED = 1;     // 业务/资格拒绝（安全门控）
const ENV_ERROR = 2;   // 环境/系统错误（可重试）

/**
 * 统一出口：设置退出码并打印消息（消息走 stderr，不污染 stdout 的 JSON 主体）
 * @param {number} code 退出码（OK/BLOCKED/ENV_ERROR）
 * @param {string} message 人读消息（打印到 stderr）
 * @param {object} [opts]
 * @param {boolean} [opts.json] 是否 JSON 模式（为 true 时额外在 stdout 输出 {meta:{exit_code}}）
 * @param {Error|string} [opts.error] 原始错误（打印到 stderr）
 * @returns {number} 返回 code，便于调用方 return
 */
function exitWith(code, message, opts = {}) {
  const msg = message || '';
  if (msg) process.stderr.write(`${msg}\n`);
  if (opts.error) {
    const errMsg = opts.error instanceof Error ? opts.error.message : String(opts.error);
    if (errMsg && errMsg !== msg) process.stderr.write(`原因: ${errMsg}\n`);
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify({ meta: { exit_code: code } }) + '\n');
  }
  process.exitCode = code;
  return code;
}

/** 语义说明（供 --help / 文档引用） */
const EXIT_CODE_DOC = {
  0: '成功（含预期内的策略性跳过，如频率已达上限、档位拒绝已报告）',
  1: '业务/资格拒绝（档位不足、shadowban 命中、AI 痕迹拦截、质量门拒绝）— 不可在本状态重试',
  2: '环境/系统错误（AdsPower 未启动、playwright 缺失、网络超时）— 可重试',
};

module.exports = { OK, BLOCKED, ENV_ERROR, exitWith, EXIT_CODE_DOC };
