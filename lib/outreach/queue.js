'use strict';
/**
 * queue.js — 私信触达：候选队列 + 状态机 + 去重 + 模板渲染
 *
 * 职责（对应 docs/outreach-design.md §4.2）：
 *   - 状态文件：state/outreach-queue.json（原子写）
 *   - 记录结构：
 *     {id, username, postId, postTitle, postUrl, commentSnippet, reason,
 *      commentScore, status, draft, sub, createdAt, queuedAt, sentAt, sendResult, skipReason}
 *   - 状态机：pending → sent / failed / skipped（全自动，无 approve 环节）
 *   - 入队去重：队列内 username 去重 + state/outreach-contacted.json 黑名单去重
 *   - 草稿模板渲染：{username} {post_title} {comment_snippet} {sub}
 *
 * 纯函数为主（可单测）；文件读写集中在 readQueue/writeQueue。
 * 发送成功后的「已联系」持久化由 sender.js 调用 lib/outreach/discover.js
 * 的 recordContactedUsers 完成，queue.js 不直接写黑名单。
 */

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const STATE_DIR = process.env.OUTREACH_STATE_DIR || path.join(__dirname, '..', '..', 'state');
const QUEUE_FILE = path.join(STATE_DIR, 'outreach-queue.json');

// ---- 状态机（常量导出方便测试与前端展示） ----
const STATUS = {
  PENDING: 'pending',
  SENT: 'sent',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
  SKIPPED: 'skipped',
};

/** 合法状态迁移表：key=当前状态，value=允许迁移到的新状态集合 */
const TRANSITIONS = {
  [STATUS.PENDING]: [STATUS.SENT, STATUS.FAILED, STATUS.UNKNOWN, STATUS.SKIPPED],
  [STATUS.SENT]: [],
  [STATUS.FAILED]: [STATUS.PENDING, STATUS.SKIPPED], // 人工介入后可重新排队
  [STATUS.UNKNOWN]: [STATUS.PENDING, STATUS.SKIPPED], // 发送结果不确定，人工确认后再处理
  [STATUS.SKIPPED]: [STATUS.PENDING],
};

// ---- 文件读写（与 runner.js / discover.js 一致的原子写） ----

function readQueueFile() {
  try {
    return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  } catch {
    return { schemaVersion: 1, items: [] };
  }
}

function writeQueueFile(queue) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${QUEUE_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(queue, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, QUEUE_FILE);
}

function makeId() {
  return `o-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

/** 当日日期前缀（YYYY-MM-DD），与 sentAt ISO 字符串前缀对齐 */
function dayPrefix(iso) {
  return String(iso || '').slice(0, 10);
}

// ---- 纯函数：模板渲染 ----

/**
 * 渲染私信草稿：用候选字段替换模板占位符。
 * 使用 split/join 而非正则，避免占位符值中的正则特殊字符（如评论里的 . * ( )）。
 * @param {string} template 模板，支持 {username}/{post_title}/{comment_snippet}/{sub}
 * @param {object} candidate 候选对象（含 username/postTitle/commentSnippet/sub 等）
 * @returns {string}
 */
function renderDraft(template, candidate) {
  const source = candidate || {};
  const replacements = {
    '{username}': source.username,
    '{post_title}': source.postTitle,
    '{comment_snippet}': source.commentSnippet,
    '{sub}': source.sub,
  };
  let out = String(template == null ? '' : template);
  for (const [key, value] of Object.entries(replacements)) {
    out = out.split(key).join(String(value == null ? '' : value));
  }
  return out;
}

/**
 * 校验模板：模板缺失会直接导致全队列草稿为空，属配置错误。
 * @param {string} template
 * @returns {Array<string>} 错误信息列表（空=通过）
 */
function validateTemplate(template) {
  const errors = [];
  const t = String(template || '');
  if (!t.trim()) {
    errors.push('模板不能为空');
    return errors;
  }
  // 必须包含 username 锚点，否则无法知道发给谁
  if (!t.includes('{username}')) errors.push('模板必须包含 {username}');
  return errors;
}

// ---- 纯函数：入队筛选 ----

/**
 * 从 discover 候选构建入队记录（不落盘，纯函数；落盘由 enqueueCandidates 完成）。
 * @param {object} candidate discover.js buildCandidates 输出单条
 * @param {object} [opts]
 * @param {string} [opts.template] 草稿模板
 * @param {string} [opts.sub] 社区名（渲染 {sub}）
 * @returns {object} 队列记录
 */
function buildQueueItem(candidate, { template = '', sub = '' } = {}) {
  const c = candidate || {};
  const username = String(c.username || '').trim();
  const draft = renderDraft(template, { ...c, sub });
  return {
    id: makeId(),
    username,
    postId: String(c.postId || ''),
    postTitle: String(c.postTitle || ''),
    postUrl: String(c.postUrl || ''),
    commentSnippet: String(c.commentSnippet || '') ,
    reason: String(c.reason || 'commented_on_target_post'),
    commentScore: typeof c.commentScore === 'number' ? c.commentScore : null,
    status: STATUS.PENDING,
    draft,
    sub: String(sub || ''),
    createdAt: nowIso(),
    queuedAt: nowIso(),
    sentAt: null,
    sendResult: null,
    skipReason: null,
  };
}

/**
 * 纯函数：把候选过滤为「可入队」列表（队列内去重 + 黑名单去重）。
 * @param {Array<object>} candidates discover 候选
 * @param {{existingUsernames?: Set<string>, contacted?: Set<string>}} [opts]
 * @returns {{items: Array, rejected: Array<{username, reason}>}}
 */
function selectEnqueueable(candidates, { existingUsernames = new Set(), contacted = new Set() } = {}) {
  const items = [];
  const rejected = [];
  const seen = new Set(existingUsernames);
  for (const candidate of candidates || []) {
    const username = String(candidate && candidate.username || '').trim();
    const key = username.toLowerCase();
    if (!key) {
      rejected.push({ username, reason: 'empty_username' });
      continue;
    }
    if (seen.has(key)) {
      rejected.push({ username, reason: 'already_in_queue' });
      continue;
    }
    if (contacted instanceof Set && contacted.has(key)) {
      rejected.push({ username, reason: 'already_contacted' });
      continue;
    }
    seen.add(key);
    items.push(candidate);
  }
  return { items, rejected };
}

// ---- 队列操作（读写 state，供 server/runner 调用） ----

/** 读取整个队列 */
function readQueue() {
  return readQueueFile();
}

/** 覆盖写入整个队列（原子） */
function writeQueue(queue) {
  writeQueueFile(queue);
}

/** 按状态/关键词读取队列（只读快照） */
function listQueue({ status = null, limit = Infinity, query = '' } = {}) {
  let items = readQueueFile().items || [];
  if (status) items = items.filter((i) => i.status === status);
  if (query) {
    const q = query.toLowerCase();
    items = items.filter((i) =>
      String(i.username).toLowerCase().includes(q) ||
      String(i.postTitle).toLowerCase().includes(q) ||
      String(i.draft).toLowerCase().includes(q));
  }
  if (Number.isFinite(limit) && limit > 0) items = items.slice(0, limit);
  return items;
}

/** 统计各类状态数量 */
function queueStats() {
  const items = readQueueFile().items || [];
  const stats = { total: items.length, [STATUS.PENDING]: 0, [STATUS.SENT]: 0, [STATUS.FAILED]: 0, [STATUS.UNKNOWN]: 0, [STATUS.SKIPPED]: 0 };
  for (const item of items) {
    if (Object.prototype.hasOwnProperty.call(stats, item.status)) stats[item.status] += 1;
  }
  return stats;
}

/**
 * 当日已发送条数（按 sentAt 的 YYYY-MM-DD 前缀统计）。
 * @param {string} [date=nowIso()] ISO 字符串或 Date
 * @returns {number}
 */
function dailySentCount(date = nowIso()) {
  const prefix = `${dayPrefix(String(date instanceof Date ? date.toISOString() : date))}`;
  return (readQueueFile().items || []).filter((i) => i.status === STATUS.SENT && dayPrefix(i.sentAt) === prefix).length;
}

/**
 * 把候选批量入队（自动去重 + 渲染草稿 + 落盘）。
 * @param {Array<object>} candidates discover 候选
 * @param {{template?: string, sub?: string}} [opts]
 * @returns {{added: number, rejected: Array<{username, reason}>, stats: object}}
 */
function enqueueCandidates(candidates, { template = '', sub = '' } = {}) {
  const queue = readQueueFile();
  const existingUsernames = new Set((queue.items || []).map((i) => String(i.username).toLowerCase()));

  // 黑名单：从 contacted 文件读（大小写不敏感）
  let contacted = new Set();
  try {
    const data = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'outreach-contacted.json'), 'utf8'));
    contacted = new Set((data.users || []).map((u) => String(u).toLowerCase()));
  } catch {
    contacted = new Set(); // 文件不存在视为空黑名单
  }

  const { items, rejected } = selectEnqueueable(candidates, { existingUsernames, contacted });
  const records = items.map((c) => buildQueueItem(c, { template, sub }));
  queue.items = [...(queue.items || []), ...records];
  writeQueueFile(queue);
  return { added: records.length, rejected, stats: queueStats() };
}

/**
 * 批量更新状态（带迁移校验）。
 * @param {Array<string>} ids 记录 id 列表
 * @param {string} toStatus 目标状态
 * @param {{error?: string, reason?: string, sendResult?: object}} [extra]
 * @returns {{updated: Array<string>, invalid: Array<{id, from, to}>, stats: object}}
 */
function markStatus(ids, toStatus, extra = {}) {
  const queue = readQueueFile();
  const updated = [];
  const invalid = [];
  const byId = new Map((queue.items || []).map((i) => [i.id, i]));
  for (const id of ids || []) {
    const item = byId.get(id);
    if (!item) continue;
    const allowed = TRANSITIONS[item.status] || [];
    if (!allowed.includes(toStatus)) {
      invalid.push({ id, from: item.status, to: toStatus });
      continue;
    }
    item.status = toStatus;
    if (toStatus === STATUS.SENT) {
      item.sentAt = nowIso();
      item.sendResult = extra.sendResult || null;
      item.skipReason = null;
    } else if (toStatus === STATUS.PENDING) {
      // 恢复待发送：清除旧的失败/跳过痕迹，避免状态机残留误导诊断
      item.sentAt = null;
      item.sendResult = null;
      item.skipReason = null;
    } else if (toStatus === STATUS.FAILED) {
      item.sendResult = { error: String(extra.error || 'unknown_error') };
    } else if (toStatus === STATUS.SKIPPED) {
      item.skipReason = String(extra.reason || 'skipped');
    }
    updated.push(id);
  }
  if (updated.length) writeQueueFile(queue);
  return { updated, invalid, stats: queueStats() };
}

// ==================== 模块导出 ====================

module.exports = {
  STATUS,
  TRANSITIONS,
  QUEUE_FILE,
  renderDraft,
  validateTemplate,
  buildQueueItem,
  selectEnqueueable,
  readQueue,
  writeQueue,
  listQueue,
  queueStats,
  dailySentCount,
  enqueueCandidates,
  markStatus,
};