'use strict';
/**
 * inbox.js — 客服收信轮询器（增量检测新回复）
 *
 * 职责：把「Matrix sync 的线程最新消息」与「会话表 replyHistory 最后一条
 *       消息」做增量比对，挑出对方发来的新消息（待 AI 回复）。
 *
 * 幂等性说明：
 *   - 检测基于 replyHistory 的最后时间戳，而非 lastCheckAt：一条新消息
 *     在进入 replyHistory 之前，永远会被判为“新”，因此 AI 回复/入库失败后
 *     重扫不会漏掉；处理成功（appendMessage）后自然转入已处理。
 *   - lastCheckAt 仅用于状态展示与审计（“上次扫描到什么时候”）。
 *
 * 模块结构：
 *   - 纯函数：findNewReplies（可单测）
 *   - 网络层：pollNewReplies（连接 Matrix 后调用）
 */

'use strict';

const matrixChat = require('./matrix-chat');
const conversations = require('./conversations');

/**
 * 纯函数：线程列表 × 会话表 → 待回复的新消息（对方发送、时间比历史更新）。
 * @param {Array<object>} threads discoverThreads 输出（含 roomId/lastMessage）
 * @param {Array<object>} convList 会话表列表（含 username/roomId/replyHistory）
 * @param {{me?: string|null}} [opts] me=当前账号 Matrix userId（过滤自己发的）
 * @returns {Array<{username: string, roomId: string, message: string, ts: string|null, sender: string|null, conversation: object}>}
 */
function findNewReplies(threads, convList, { me = null } = {}) {
  const byRoom = new Map();
  for (const c of convList || []) {
    if (c && c.roomId) byRoom.set(c.roomId, c);
  }
  const replies = [];
  for (const t of threads || []) {
    const lm = t && t.lastMessage;
    if (!lm || !lm.body) continue;
    if (me && lm.sender === me) continue; // 自己发出的不视为新回复
    const conversation = byRoom.get(t.roomId);
    if (!conversation) continue; // 无会话表记录的房间跳过（非 outreach 联系人）
    const history = Array.isArray(conversation.replyHistory) ? conversation.replyHistory : [];
    const lastTs = history.length ? history[history.length - 1].ts : null;
    const isNew = !lastTs || !lm.ts || lm.ts > lastTs;
    if (isNew) {
      replies.push({
        username: conversation.username,
        roomId: t.roomId,
        message: lm.body,
        ts: lm.ts,
        sender: lm.sender,
        conversation,
      });
    }
  }
  return replies;
}

/**
 * 网络层：拉取线程并返回新回复列表（不写 replyHistory，只推进 lastCheckAt）。
 * @param {string} token Matrix access token
 * @param {{me?: string|null, fetchImpl?: Function, base?: string}} [opts]
 * @returns {Promise<{ok: boolean, replies?: Array, threadCount?: number, error?: string, me?: string|null}>}
 */
async function pollNewReplies(token, { me = null, ...opts } = {}) {
  const found = await matrixChat.discoverThreads(token, opts);
  if (!found.ok) return { ok: false, error: found.error };
  let self = me;
  if (!self) {
    const w = await matrixChat.whoami(token, opts);
    self = w.ok ? w.userId : null;
  }
  const convList = conversations.listConversations();
  const replies = findNewReplies(found.threads, convList, { me: self });
  // 推进 lastCheckAt（仅状态展示；幂等判定以 replyHistory 为准）
  const scanTs = new Date().toISOString();
  for (const c of convList) conversations.touchCheckAt(c.username, scanTs);
  return { ok: true, replies, threadCount: found.threads.length, me: self };
}

// ==================== 模块导出 ====================

module.exports = {
  findNewReplies,
  pollNewReplies,
};