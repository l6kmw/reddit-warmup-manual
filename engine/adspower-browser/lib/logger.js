const SENSITIVE_KEY = /(?:pass(?:word)?|secret|token|api[_-]?key|authorization|cookie|proxy)/i;
const CREDENTIAL_URL = /\b((?:https?|socks(?:4a?|5h?)?|proxy):\/\/)([^\s/@:]+):([^\s/@]+)@/gi;
const BEARER_TOKEN = /\b(Bearer)\s+[^\s,;"']+/gi;
const SENSITIVE_PAIR = /([?&;,]\s*(?:authorization|token|api[_-]?key|password|secret)\s*=\s*)[^\s&#;,]+|\b((?:authorization|token|api[_-]?key|password|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi;

function redactText(value) {
  return value
    .replace(CREDENTIAL_URL, '$1[REDACTED]:[REDACTED]@')
    .replace(BEARER_TOKEN, '$1 [REDACTED]')
    .replace(SENSITIVE_PAIR, (match, queryPrefix, pairPrefix) =>
      `${queryPrefix || pairPrefix}[REDACTED]`);
}

function redact(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message) };
  }
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)])
    );
  }
  return value;
}

function createLogger({ level = 'info', output = process.stderr } = {}) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40, silent: Infinity };
  if (!(level in levels)) throw new Error(`未知日志级别: ${level}`);

  function write(logLevel, event, fields = {}) {
    if (levels[logLevel] < levels[level]) return;
    const record = redact({
      time: new Date().toISOString(),
      level: logLevel,
      event,
      ...fields,
    });
    // 结构化日志默认走 stderr（而非 console.info→stdout）：
    // stdout 保留给 --json 协议输出，保证 `script --json | jq` 管道干净
    // （见 jsonout.js 协议约束）。自定义 output 仍可用 {info, warn, error} 覆盖。
    const line = JSON.stringify(record) + '\n';
    if (typeof output.write === 'function') {
      output.write(line);
    } else if (typeof output[logLevel] === 'function') {
      output[logLevel](JSON.stringify(record));
    } else {
      process.stderr.write(line);
    }
  }

  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}

const logger = createLogger();

module.exports = { createLogger, logger, redact };
