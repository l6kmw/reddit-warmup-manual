/**
 * adsPowerApi.js — AdsPower 本地 API 封装
 *
 * 通过 HTTP 调 AdsPower 本地服务 (默认 127.0.0.1:50325):
 *   - listProfiles()      列出所有环境
 *   - startProfile(id)    启动环境, 返回 debug_port
 *   - stopProfile(id)     关闭环境
 *   - getDebugPort(id)    查询已启动环境的 CDP 端口
 *
 * 核心原则: 绝不自己 launch 浏览器, 只拿 debug_port 给
 * playwright connectOverCDP 用, 保证指纹/代理/缓存全部保留。
 *
 * 限流处理: AdsPower 本地 API 对短时间内的并发/连续请求会返回
 * code -1 (限流)。因此所有请求通过一个全局队列串行发出, 并保持
 * 最小间隔, 对 -1 再做退避重试。多机器并发时, API 调用排队,
 * 但浏览器连接与页面操作仍然并行, 不受影响。
 */
const BASE_URL = 'http://127.0.0.1:50325';

// 全局请求串行化: 同一时刻只有一个请求在途, 且两次请求间隔 >= MIN_INTERVAL_MS
const MIN_INTERVAL_MS = 400;
const RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_BACKOFF_BASE = 500;
const REQUEST_TIMEOUT_MS = 10000;
let requestTail = Promise.resolve();
let lastRequestAt = 0;

/** 在全局队列末尾追加一个请求, 保证串行 + 最小间隔 */
function enqueueRequest(perform) {
  const run = requestTail.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    return perform();
  });
  // 队列不因单个请求失败而中断, 但把错误传给当前调用方
  requestTail = run.then(() => {}, () => {});
  return run;
}

/** 简单封装 fetch, 统一 JSON + 错误处理 */
async function rawRequest(path, method = 'GET') {
  const options = {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(method === 'POST' ? { method: 'POST' } : {}),
  };
  const res = await fetch(`${BASE_URL}${path}`, options);
  if (!res.ok) {
    const error = new Error(`AdsPower API ${path} 请求失败: HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

function isTemporaryError(error) {
  return error?.status === 408 || error?.status === 429 || error?.status >= 500 ||
    ['AbortError', 'TimeoutError'].includes(error?.name) ||
    ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error?.code) ||
    error instanceof TypeError;
}

/**
 * 带上限指数退避的 API 请求。code -1、网络错误、429 与 5xx 视为临时错误；
 * 每一次实际 HTTP 调用仍经过同一个全局串行队列。
 */
async function apiRequest(path, { method = 'GET', retries = RATE_LIMIT_RETRIES } = {}) {
  let lastError;
  for (let tryIndex = 0; tryIndex <= retries; tryIndex += 1) {
    try {
      const json = await enqueueRequest(() => rawRequest(path, method));
      if (json.code === -1) {
        const error = new Error(`AdsPower API ${path} 暂时不可用 (code: -1)`);
        error.temporary = true;
        throw error;
      }
      if (json.code !== 0) {
        throw new Error(`AdsPower API ${path} 失败 (code: ${json.code ?? 'unknown'})`);
      }
      return json;
    } catch (error) {
      lastError = error;
      const retryable = error.temporary || isTemporaryError(error);
      if (!retryable || tryIndex >= retries) throw error;
      const backoff = Math.min(RATE_LIMIT_BACKOFF_BASE * 2 ** tryIndex, 8000);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
  throw lastError;
}

/** 校验 AdsPower API 返回的 code 字段 (不再回显响应数据, 避免泄露环境细节) */
function assertOk(json, action) {
  if (json.code !== 0) {
    throw new Error(`${action}失败 (AdsPower code: ${json.code ?? 'unknown'})`);
  }
  return json.data;
}

/**
 * 列出全部指纹浏览器 profiles。AdsPower API 默认只返回一页，因此持续翻页，
 * 并可按 groupName 做精确筛选（分组名由 API 的 group_name 字段提供）。
 * @param {object} options
 * @param {string} [options.groupName] AdsPower 分组名（精确匹配）
 * @param {number} [options.pageSize=100] 每页数量
 * @returns {Promise<Array<{id: string, name: string, groupName: string, status: string}>>}
 */
async function listProfiles({ groupName, pageSize = 100 } = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('pageSize 必须是大于 0 的整数');
  const users = [];
  for (let page = 1; ; page += 1) {
    const json = await apiRequest(`/api/v1/user/list?page=${page}&page_size=${pageSize}`);
    const data = assertOk(json, '列出 profiles');
    const pageUsers = data?.list ?? [];
    users.push(...pageUsers);

    const total = Number(data?.total ?? data?.total_count);
    if (pageUsers.length < pageSize || (Number.isFinite(total) && users.length >= total)) break;
  }
  return users
    .map((u) => ({
      id: u.user_id,
      name: u.name,
      groupName: u.group_name ?? '',
      serial: Number(u.serial_number) || null, // AdsPower 客户端显示的编号
      status: u.status,
    }))
    .filter((profile) => groupName === undefined || profile.groupName === groupName);
}

/**
 * 启动指定环境, 返回 CDP debug 端口
 * @param {string} profileId AdsPower 环境 user_id
 * @param {boolean} openTabs 启动时是否打开上次的标签页
 * @returns {Promise<number>} debug_port
 */
async function startProfile(profileId, { openTabs = false } = {}) {
  const json = await apiRequest(
    `/api/v1/browser/start?user_id=${encodeURIComponent(profileId)}&open_tabs=${openTabs ? 1 : 0}`
  );
  const data = assertOk(json, `启动环境 ${profileId}`);
  const port = data?.debug_port;
  if (!port) {
    throw new Error(`profile ${profileId} 已启动但未返回 CDP endpoint`);
  }
  return port;
}

/**
 * 关闭指定环境
 * @param {string} profileId AdsPower 环境 user_id
 */
async function stopProfile(profileId) {
  // AdsPower 的 /browser/stop 是 GET 接口, 不是 POST
  const json = await apiRequest(`/api/v1/browser/stop?user_id=${encodeURIComponent(profileId)}`);
  assertOk(json, `关闭环境 ${profileId}`);
}

/**
 * 查询环境当前是否在运行 / 拿到 debug port (不启动)
 * 返回 null 表示未运行
 */
async function getDebugPort(profileId) {
  const json = await apiRequest(
    `/api/v1/browser/active?user_id=${encodeURIComponent(profileId)}`
  );
  const data = assertOk(json, `查询环境 ${profileId} 状态`);
  // 未启动时 data 为 null
  return data?.debug_port ?? null;
}

module.exports = {
  BASE_URL,
  listProfiles,
  startProfile,
  stopProfile,
  getDebugPort,
};
