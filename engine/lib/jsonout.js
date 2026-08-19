'use strict';
/**
 * jsonout.js — 统一 JSON 输出协议（对应优化计划 P1-1 / 原则一）
 *
 * 所有脚本 --json 输出统一 schema：
 *   {
 *     "results": { ok, ...业务数据 },
 *     "meta": {
 *       "schema_version": "json-out/v1",
 *       "script": "...",
 *       "version": "1.0.0",
 *       "ts": ISO,
 *       "duration_ms": 123,
 *       "exit_code": 0,
 *       "args": { ...脱敏后的参数 }
 *     }
 *   }
 *
 * 约束：
 *   1. JSON 只走 stdout；人类可读日志走 stderr（cmd | jq 永远干净）
 *   2. meta.args 只记录非敏感参数，敏感键（password/token/secret/cookie）强制脱敏为 ***
 *   3. results.ok 与 meta.exit_code 语义一致（0=成功/1=业务拒绝/2=环境错误）
 */
'use strict';

const SENSITIVE_KEYS = /password|passwd|token|secret|cookie|credential|api[_-]?key|auth/i;

/** 递归脱敏：替换敏感键的值为 *** */
function redact(value, key = '') {
  if (Array.isArray(value)) return value.map((v) => redact(v, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '***' : redact(v, k);
    }
    return out;
  }
  return value;
}

/**
 * 输出统一 JSON 到 stdout
 * @param {object} options
 * @param {object} options.results 业务结果（含 ok 布尔）
 * @param {string} options.script 脚本名
 * @param {number} options.exitCode 退出码（0/1/2）
 * @param {object} [options.args] 原始参数（将脱敏后写入 meta.args）
 * @param {number} [options.startedAt] 开始时间戳（算 duration_ms）
 * @param {string} [options.version] 版本号
 */
function emitJSON({ results, script, exitCode, args, startedAt, version = '1.0.0' }) {
  const payload = {
    results,
    meta: {
      schema_version: 'json-out/v1',
      script,
      version,
      ts: new Date().toISOString(),
      duration_ms: startedAt ? Date.now() - startedAt : null,
      exit_code: exitCode,
      args: args ? redact(args) : {},
    },
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

module.exports = { emitJSON, redact, SENSITIVE_KEYS };
