'use strict';
/**
 * matrix-chat.js — Reddit 最新版 Chat（Matrix 协议）私信发送模块
 *
 * 背景：Reddit 新版已启用实验开关 web_bermuda_remove_pm_ui，传统私信 UI
 *       被移除，消息统一走 Chat。Chat 底层是 Matrix（客户端 rs-matrix-client，
 *       homeserver https://matrix.redditspace.com），因此可通过标准 Matrix
 *       Client-Server API 直接发送私信，比 DOM 点击稳定得多。
 *
 * 职责（对齐 docs/outreach-design.md §4.3 的发送器）：
 *   - 从已登录 profile 的 localStorage 读取 Matrix access token（chat:access-token）
 *   - Reddit 用户名 → Matrix user id（@t2_xxx:reddit.com，user_directory 搜索）
 *   - 创建 DM 房间（createRoom + is_direct）
 *   - 发送文本消息（send m.room.message）并返回 event_id
 *   - 可选：回读房间消息验证送达
 *
 * 模块结构：
 *   - 纯函数层（可单测）：parseAccessToken / buildCreateRoomBody / buildMessageBody /
 *     parseSearchResultUserId / parseCreateRoomId / parseSendResponse / matrixFetchError
 *   - 网络层（fetch 可注入 mock）：matrixRequest / resolveUserId / createDirectRoom /
 *     sendMatrixMessage / readRoomMessages / whoami
 *   - 浏览器层：readAccessTokenFromPage（从 Playwright page 读 token）
 *   - 高层：sendChatToUsername（一条完整发送）
 *
 * 安全：token 仅在内存中使用，不落盘、不进日志；审计只记录 roomId/eventId。
 */

'use strict';

const MATRIX_BASE = process.env.REDDIT_MATRIX_BASE || 'https://matrix.redditspace.com';
const MATRIX_TOKEN_KEY = 'chat:access-token';

// ==================== 纯函数层 ====================

/**
 * 解析 localStorage 原始值 → Matrix access token。
 * @param {string|null} raw localStorage.getItem('chat:access-token')
 * @returns {string|null}
 */
function parseAccessToken(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed.token === 'string' && parsed.token ? parsed.token : null;
  } catch {
    return null;
  }
}

/**
 * 构造 createRoom 请求体（直接私聊房间）。
 * @param {string} username Reddit 用户名（用于房间名，便于界面识别）
 * @param {string} userId Matrix user id（@t2_xxx:reddit.com）
 * @returns {object}
 */
function buildCreateRoomBody(username, userId) {
  return {
    invite: [userId],
    is_direct: true,
    preset: 'trusted_private_chat',
    name: String(username || '').slice(0, 80),
  };
}

/**
 * 构造消息体。
 * @param {string} text 私信正文
 * @returns {{msgtype: string, body: string}}
 */
function buildMessageBody(text) {
  return { msgtype: 'm.text', body: String(text || '') };
}

/**
 * 从 user_directory/search 响应解析目标 Matrix user id。
 * 严格取 display_name 与目标用户名精确匹配（大小写不敏感）的结果，
 * 避免发送对象张冠李戴；无精确匹配即返回 null（即使只有一个结果）。
 * @param {object|null} json 搜索响应
 * @param {string} username Reddit 用户名
 * @returns {string|null}
 */
function parseSearchResultUserId(json, username) {
  const results = json && Array.isArray(json.results) ? json.results : [];
  if (!results.length || !username) return null;
  const lower = String(username).toLowerCase();
  const exact = results.find((r) => String(r.display_name || '').toLowerCase() === lower);
  return exact && exact.user_id ? exact.user_id : null;
}

/**
 * 从 createRoom 响应解析 room_id。
 * @param {object|null} json
 * @returns {string|null}
 */
function parseCreateRoomId(json) {
  return (json && json.room_id) || null;
}

/**
 * 解析 send m.room.message 响应。
 * @param {object|null} json
 * @returns {{ok: boolean, eventId?: string, error?: string}}
 */
function parseSendResponse(json) {
  if (!json) return { ok: false, error: 'empty_response' };
  if (json.event_id) return { ok: true, eventId: json.event_id };
  if (json.errcode) return { ok: false, error: `${json.errcode}: ${String(json.error || '')}` };
  return { ok: false, error: 'unexpected_response' };
}

/**
 * 把 Matrix 错误响应转成紧凑错误串。
 * @param {number} status HTTP 状态
 * @param {object|null} json 响应体
 * @returns {string}
 */
function matrixFetchError(status, json) {
  const code = json && json.errcode ? json.errcode : `http_${status}`;
  const detail = json && json.error ? `: ${json.error}` : '';
  return `${code}${detail}`;
}

// ==================== 网络层（fetch 可注入） ====================

/**
 * 统一 Matrix 请求。
 * @param {string} token access token
 * @param {string} method
 * @param {string} pathName 以 / 开头的路径
 * @param {object|null} body
 * @param {{base?: string, fetchImpl?: Function}} [opts]
 * @returns {Promise<{status: number, ok: boolean, json: object|null}>}
 */
async function matrixRequest(token, method, pathName, body, { base = MATRIX_BASE, fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(`${base}${pathName}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await response.json(); } catch { /* 非 JSON 响应 */ }
  return { status: response.status, ok: response.ok, json };
}

/**
 * 用户名 → Matrix user id。
 * @returns {Promise<{ok: boolean, userId?: string, error?: string}>}
 */
async function resolveUserId(token, username, opts = {}) {
  const r = await matrixRequest(token, 'POST', '/_matrix/client/v3/user_directory/search', { search_term: username, limit: 5 }, opts);
  if (!r.ok) return { ok: false, error: `search_${matrixFetchError(r.status, r.json)}` };
  const userId = parseSearchResultUserId(r.json, username);
  if (!userId) return { ok: false, error: `user_not_found: ${username}` };
  return { ok: true, userId };
}

/**
 * 创建 DM 房间。
 * @returns {Promise<{ok: boolean, roomId?: string, error?: string}>}
 */
async function createDirectRoom(token, username, userId, opts = {}) {
  const r = await matrixRequest(token, 'POST', '/_matrix/client/v3/createRoom', buildCreateRoomBody(username, userId), opts);
  if (!r.ok) return { ok: false, error: `createRoom_${matrixFetchError(r.status, r.json)}` };
  const roomId = parseCreateRoomId(r.json);
  if (!roomId) return { ok: false, error: 'createRoom_missing_room_id' };
  return { ok: true, roomId };
}

/**
 * 向房间发送文本消息。
 * @returns {Promise<{ok: boolean, eventId?: string, error?: string}>}
 */
async function sendMatrixMessage(token, roomId, body, opts = {}) {
  const txn = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const r = await matrixRequest(token, 'PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`, buildMessageBody(body), opts);
  if (!r.ok) return { ok: false, error: `send_${matrixFetchError(r.status, r.json)}` };
  const parsed = parseSendResponse(r.json);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, eventId: parsed.eventId };
}

/**
 * 回读房间最近消息（验证送达）。
 * @returns {Promise<{ok: boolean, messages?: Array, error?: string}>}
 */
async function readRoomMessages(token, roomId, { limit = 3, ...opts } = {}) {
  const r = await matrixRequest(token, 'GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${limit}`, null, opts);
  if (!r.ok) return { ok: false, error: matrixFetchError(r.status, r.json) };
  const chunk = r.json && Array.isArray(r.json.chunk) ? r.json.chunk : [];
  const messages = [...chunk].reverse().map((ev) => ({
    type: ev.type,
    sender: ev.sender,
    body: ev.content ? ev.content.body : undefined,
  }));
  return { ok: true, messages };
}

/**
 * 校验 token 身份（调试/令牌有效性检查用）。
 * @returns {Promise<{ok: boolean, userId?: string, status?: number, json?: object|null}>}
 */
async function whoami(token, opts = {}) {
  const r = await matrixRequest(token, 'GET', '/_matrix/client/v3/account/whoami', null, opts);
  return { ok: r.ok, status: r.status, json: r.json, userId: r.json && r.json.user_id };
}

// ==================== 浏览器层 ====================

/**
 * 从已登录的 Playwright page 读取 Matrix access token（localStorage）。
 * @param {object} page Playwright page
 * @returns {Promise<{ok: boolean, token?: string, error?: string}>}
 */
async function readAccessTokenFromPage(page) {
  if (!page) return { ok: false, error: 'no_page' };
  try {
    const raw = await page.evaluate((key) => {
      try { return localStorage.getItem(key); } catch { return null; }
    }, MATRIX_TOKEN_KEY);
    const token = parseAccessToken(raw);
    return token ? { ok: true, token } : { ok: false, error: 'matrix_token_missing' };
  } catch (error) {
    return { ok: false, error: `token_read_failed: ${error && error.message || error}` };
  }
}

/**
 * 等待 Chat 客户端在页面上初始化出 token（预热后调用）。
 * @param {object} page
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<boolean>} token 是否就绪
 */
async function waitForToken(page, { timeoutMs = 60000 } = {}) {
  if (!page) return false;
  try {
    return await page.waitForFunction(
      (key) => { try { return Boolean(localStorage.getItem(key)); } catch { return false; } },
      MATRIX_TOKEN_KEY,
      { timeout: timeoutMs },
    ).then(() => true).catch(() => false);
  } catch {
    return false;
  }
}

// ==================== 高层：一条完整发送 ====================

/**
 * 一条完整发送：解析用户 → 建房间 → 发消息。
 * @param {string} token Matrix access token
 * @param {string} username Reddit 用户名
 * @param {string} body 私信正文
 * @param {object} [opts] 透传网络层选项（base/fetchImpl）
 * @returns {Promise<{ok: boolean, stage?: string, userId?: string, roomId?: string, eventId?: string, error?: string}>}
 */
async function sendChatToUsername(token, username, body, opts = {}) {
  const resolved = await resolveUserId(token, username, opts);
  if (!resolved.ok) return { ...resolved, stage: 'resolve' };
  const room = await createDirectRoom(token, username, resolved.userId, opts);
  if (!room.ok) return { ...room, stage: 'createRoom' };
  const sent = await sendMatrixMessage(token, room.roomId, body, opts);
  if (!sent.ok) return { ...sent, stage: 'send', roomId: room.roomId };
  return { ok: true, stage: 'done', userId: resolved.userId, roomId: room.roomId, eventId: sent.eventId };
}

// ==================== 模块导出 ====================

module.exports = {
  MATRIX_BASE,
  MATRIX_TOKEN_KEY,
  parseAccessToken,
  buildCreateRoomBody,
  buildMessageBody,
  parseSearchResultUserId,
  parseCreateRoomId,
  parseSendResponse,
  matrixFetchError,
  matrixRequest,
  resolveUserId,
  createDirectRoom,
  sendMatrixMessage,
  readRoomMessages,
  whoami,
  readAccessTokenFromPage,
  waitForToken,
  sendChatToUsername,
};