'use strict';
/**
 * conversations.js — 私信会话表（AI 客服数据层）
 *
 * 背景：outreach 从「一次性私信触达」升级为「可对话的客服会话」。
 *      原 state/outreach-contacted.json 只记录已联系用户名（黑名单语义），
 *      现升级为会话表：每个已联系用户可以挂接 Chat 房间信息、回复历史、
 *      人工介入标记与检查时间戳。
 *
 * 存储（权威文件）：
 *   - state/outreach-conversations.json（schemaVersion: 2）
 *     { schemaVersion, users: [username...], conversations: { username(lower): {
 *         username, roomId, threadStatus, replyHistory[], needsHuman,
 *         needsHumanReason?, lastCheckAt, createdAt, context{} } } }
 *   - 旧 state/outreach-contacted.json（schemaVersion: 1）首次读取时惰性迁移，
 *     之后不再写入旧文件。
 *
 * 兼容性：recordContactedUsers / contactedUserSet 保持与 discover/queue 既有
 *         语义一致（黑名单去重），只是底表换了；外部调用方无需改动。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const STATE_DIR = process.env.OUTREACH_STATE_DIR || path.resolve(__dirname, '..', '..', 'state');
const CONVERSATIONS_FILE = path.join(STATE_DIR, 'outreach-conversations.json');
const LEGACY_CONTACTED_FILE = path.join(STATE_DIR, 'outreach-contacted.json');

const THREAD_STATUS = {
  ACTIVE: 'active',
  NEEDS_HUMAN: 'needs_human',
  CLOSED: 'closed',
};

function idKey(username) {
  return String(username || '').trim().toLowerCase();
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function newConversation(username, { roomId = null, context = {} } = {}) {
  return {
    username: String(username),
    roomId: roomId || null,
    threadStatus: THREAD_STATUS.ACTIVE,
    replyHistory: [],
    needsHuman: false,
    needsHumanReason: null,
    lastCheckAt: null,
    createdAt: new Date().toISOString(),
    context: context || {},
  };
}

// ==================== 读写（惰性迁移） ====================

/**
 * 读取会话数据；若权威文件缺失，则从旧 contacted 文件迁移（只迁移一次）。
 * @returns {{schemaVersion: number, users: Array<string>, conversations: object}}
 */
function readData() {
  const data = readJsonSafe(CONVERSATIONS_FILE, null);
  if (
    data && data.schemaVersion === 2 &&
    Array.isArray(data.users) &&
    data.conversations && typeof data.conversations === 'object'
  ) {
    // 权威文件已存在：增量合并 legacy contacted 文件（旧版 sender 可能仍在追加）
    let changed = false;
    const legacy = readJsonSafe(LEGACY_CONTACTED_FILE, null);
    if (legacy && Array.isArray(legacy.users)) {
      for (const u of legacy.users.map(String)) {
        if (!u.trim()) continue;
        if (!data.users.includes(u)) {
          data.users.push(u);
          changed = true;
        }
        const key = idKey(u);
        if (key && !data.conversations[key]) {
          data.conversations[key] = newConversation(u);
          changed = true;
        }
      }
    }
    if (changed) writeJson(CONVERSATIONS_FILE, data);
    return data;
  }
  // 首次：优先旧 contacted，兼容半成品 data
  const legacy = readJsonSafe(LEGACY_CONTACTED_FILE, null);
  const users = Array.isArray(legacy && legacy.users)
    ? legacy.users.map(String)
    : Array.isArray(data && data.users) ? data.users.map(String) : [];
  const conversations = {};
  for (const u of users) {
    const key = idKey(u);
    if (key && !conversations[key]) conversations[key] = newConversation(u);
  }
  const migrated = { schemaVersion: 2, users, conversations };
  writeJson(CONVERSATIONS_FILE, migrated);
  return migrated;
}

function writeData(data) {
  writeJson(CONVERSATIONS_FILE, data);
}

// ==================== 查询与写入 ====================

/**
 * 已联系用户集合（大小写不敏感；供 discover 入队排除）。
 * @returns {Set<string>}
 */
function contactedUserSet() {
  const data = readData();
  return new Set(data.users.map((u) => String(u).toLowerCase()).filter(Boolean));
}

/**
 * 登记已联系用户（发送成功后调用；黑名单语义与旧版一致）。
 * @param {Array<string>} users
 * @returns {{added: number, total: number}}
 */
function recordContactedUsers(users) {
  const data = readData();
  let added = 0;
  for (const u of users || []) {
    const username = String(u);
    if (!username.trim()) continue;
    if (!data.users.includes(username)) {
      data.users.push(username);
      added += 1;
    }
    const key = idKey(username);
    if (!data.conversations[key]) data.conversations[key] = newConversation(username);
  }
  writeData(data);
  return { added, total: data.users.length };
}

/**
 * 确保会话存在；可补录 roomId 与上下文（首次发送/线程发现时调用）。
 * @param {string} username
 * @param {{roomId?: string|null, context?: object}} [opts]
 * @returns {object|null} 会话记录
 */
function ensureConversation(username, { roomId = null, context = {} } = {}) {
  const data = readData();
  const key = idKey(username);
  if (!key) return null;
  let conv = data.conversations[key];
  if (!conv) {
    conv = newConversation(username, { roomId, context });
    data.conversations[key] = conv;
    if (!data.users.includes(String(username))) data.users.push(String(username));
    writeData(data);
  } else {
    let changed = false;
    if (roomId && !conv.roomId) { conv.roomId = roomId; changed = true; }
    if (context && Object.keys(context).length && (!conv.context || !Object.keys(conv.context).length)) {
      conv.context = { ...context };
      changed = true;
    }
    if (changed) writeData(data);
  }
  return conv;
}

/**
 * 查找会话。
 * @param {string} username
 * @returns {object|null}
 */
function findConversation(username) {
  const data = readData();
  return data.conversations[idKey(username)] || null;
}

/**
 * 追加一条对话消息（发送或接收后调用）。
 * @param {string} username
 * @param {{from?: 'me'|'them', body?: string, ts?: string, source?: string}} [opts]
 * @returns {{ok: boolean, length?: number, error?: string}}
 */
function appendMessage(username, { from = 'them', body = '', ts = null, source = 'matrix' } = {}) {
  const data = readData();
  const conv = data.conversations[idKey(username)];
  if (!conv) return { ok: false, error: 'conversation_not_found' };
  if (!Array.isArray(conv.replyHistory)) conv.replyHistory = [];
  conv.replyHistory.push({ from: from === 'me' ? 'me' : 'them', body: String(body), ts: ts || new Date().toISOString(), source });
  conv.lastCheckAt = new Date().toISOString();
  writeData(data);
  return { ok: true, length: conv.replyHistory.length };
}

/**
 * 标记会话转入人工（敏感/不确定场景）。
 * @param {string} username
 * @param {string} reason
 * @param {{details?: string}} [opts]
 * @returns {{ok: boolean, error?: string}}
 */
function markNeedsHuman(username, reason, { details = '' } = {}) {
  const data = readData();
  const conv = data.conversations[idKey(username)];
  if (!conv) return { ok: false, error: 'conversation_not_found' };
  conv.needsHuman = true;
  conv.threadStatus = THREAD_STATUS.NEEDS_HUMAN;
  conv.needsHumanReason = String(reason);
  if (details) conv.needsHumanDetails = String(details);
  writeData(data);
  return { ok: true };
}

/**
 * 更新最后检查时间戳（增量轮询用）。
 * @param {string} username
 * @param {string|null} [ts]
 */
function touchCheckAt(username, ts = null) {
  const data = readData();
  const conv = data.conversations[idKey(username)];
  if (!conv) return { ok: false };
  conv.lastCheckAt = ts || new Date().toISOString();
  writeData(data);
  return { ok: true };
}

/**
 * 列出会话（可按人工介入/线程状态过滤）。
 * @param {{needsHuman?: boolean, threadStatus?: string}} [opts]
 * @returns {Array<object>}
 */
function listConversations({ needsHuman = null, threadStatus = null } = {}) {
  const data = readData();
  let list = Object.values(data.conversations);
  if (needsHuman != null) list = list.filter((c) => Boolean(c.needsHuman) === Boolean(needsHuman));
  if (threadStatus) list = list.filter((c) => c.threadStatus === threadStatus);
  return list.sort((a, b) => String(a.username).localeCompare(String(b.username)));
}

/**
 * 会话对应的 Chat 房间 id。
 * @param {string} username
 * @returns {string|null}
 */
function roomIdOf(username) {
  const conv = findConversation(username);
  return conv && conv.roomId ? conv.roomId : null;
}

/** 读取会话文件路径（测试/诊断用） */
function filePath() {
  return CONVERSATIONS_FILE;
}

// ==================== 模块导出 ====================

module.exports = {
  THREAD_STATUS,
  CONVERSATIONS_FILE,
  LEGACY_CONTACTED_FILE,
  readData,
  writeData,
  contactedUserSet,
  recordContactedUsers,
  ensureConversation,
  findConversation,
  appendMessage,
  markNeedsHuman,
  touchCheckAt,
  listConversations,
  roomIdOf,
  filePath,
};