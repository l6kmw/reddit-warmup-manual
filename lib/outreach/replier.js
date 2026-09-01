'use strict';
/**
 * replier.js — AI 客服回复器主流程
 *
 * 流程（对应 plan：「收信轮询 → AI 回复 → 自动发送 → 审计」）：
 *   1. poll: inbox.pollNewReplies —— 对全部会话做增量检测，挑出对方新回复
 *   2. handle: 对每条新回复
 *      a. 追加对方消息到会话历史（先记，保证幂等不重扫）
 *      b. 构建 AI 上下文 → provider.generateReply → 决策
 *      c. reply：经 Matrix 往已有 room 发送（无 24h 房间限额）→ 追加自己的回复
 *         needs_human：markNeedsHuman（转人工，不自动回）
 *         skip：仅审计
 *      d. 每步写审计（logs/outreach-YYYY-MM-DD.jsonl，event=outreach.reply*）
 *   3. 互斥：复用 outreach.lock，与发送/养号互斥
 *
 * 设计要点：
 *   - dryRun 模式生成不发送（先观察效果）
 *   - AI 生成异常 → 保守转人工（绝不让异常静默漏掉客户消息）
 *   - 发送失败：对方消息已入库（不重扫骚扰），审计 failed 待人工复查
 */

'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const aiProvider = require('./ai-provider');
const inbox = require('./inbox');
const conversations = require('./conversations');
const matrixChat = require('./matrix-chat');
const kb = require('./kb'); // 知识库：LLM provider 按消息检索注入
const sender = require('./sender'); // 复用 appendAudit / acquireLock / releaseLock / LOCK_FILE

const MAX_HISTORY_LIMIT = 12;
const RAG_API_URL = String(process.env.RAG_API_URL || '').replace(/\/+$/, '');

/** Go RAG API 向量检索；服务不可用时返回 null，由调用方回退 JSON 关键词检索。 */
async function searchRag(query) {
  if (!RAG_API_URL || typeof globalThis.fetch !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${RAG_API_URL}/api/kb/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit: 3 }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.json();
    return Array.isArray(data.items) ? data.items : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ==================== 纯函数 ====================

/**
 * 构建 AI 生成上下文：对方最新消息 + 最近历史 + 用户来源画像。
 * @param {object} conversation 会话记录（username/context/replyHistory）
 * @param {{message: string, ts?: string|null}} reply 新回复
 * @param {{historyLimit?: number}} [opts]
 * @returns {{username: string, message: string, history: Array, userProfile: object}}
 */
function buildReplyContext(conversation, reply, { historyLimit = MAX_HISTORY_LIMIT } = {}) {
  const history = (Array.isArray(conversation && conversation.replyHistory) ? conversation.replyHistory : [])
    .slice(-historyLimit)
    .map((h) => ({ from: h.from, body: h.body, ts: h.ts }));
  return {
    username: (conversation && conversation.username) || '',
    message: String((reply && reply.message) || '').trim(),
    history,
    userProfile: (conversation && conversation.context) || {},
  };
}

/** 生成结果归类（供 runReplier 汇总） */
function outcomeCounter(outcome, counts) {
  const key = outcome && outcome.action;
  if (key && Object.prototype.hasOwnProperty.call(counts, key)) counts[key] += 1;
}

// ==================== 单条处理（依赖注入，便于测试） ====================

/**
 * 处理一条新回复。
 * @param {object} ctx
 * @param {object} ctx.reply inbox reply（username/roomId/message/ts/conversation）
 * @param {string} ctx.token Matrix token
 * @param {object} ctx.provider AI provider
 * @param {Function} ctx.sendMessage (token, roomId, text) => {ok, eventId?, error?}
 * @param {Function} ctx.appendMessage (username, {from, body, ts, source}) => 结果
 * @param {Function} ctx.markNeedsHuman (username, reason, opts)
 * @param {Function} ctx.audit (entry)
 * @param {boolean} [ctx.dryRun] 生成不发送
 * @param {Function} [ctx.emit] 状态事件
 * @returns {Promise<{action: string, username: string, category?: string, reason?: string, text?: string, eventId?: string, error?: string}>}
 */
async function handleReply(ctx) {
  const {
    reply, token, provider,
    sendMessage, appendMessage, markNeedsHuman, audit,
    dryRun = false, emit = () => {},
  } = ctx;
  const username = reply.username;
  const aiCtx = buildReplyContext(reply.conversation, reply);

  let decision;
  try {
    decision = await provider.generateReply(aiCtx);
  } catch (error) {
    decision = { decision: 'needs_human', category: 'other', reason: `ai_error: ${error && error.message || error}`, text: null };
  }

  // 先落对方消息（幂等：处理/发送失败也不重扫）
  appendMessage(username, { from: 'them', body: reply.message, ts: reply.ts || null, source: 'matrix' });
  const base = { ts: new Date().toISOString(), event: 'outreach.reply', id: username, username, roomId: reply.roomId, message: reply.message, decision: decision.decision, category: decision.category || null, reason: decision.reason || null };

  if (decision.decision === 'reply' && decision.text) {
    if (dryRun) {
      audit({ ...base, status: 'dry_run', text: decision.text });
      emit('outreach.reply', { username, action: 'replied_dry', text: decision.text });
      return { action: 'replied_dry', username, category: decision.category, text: decision.text };
    }
    const sent = await sendMessage(token, reply.roomId, decision.text);
    if (sent && sent.ok) {
      appendMessage(username, { from: 'me', body: decision.text, source: 'matrix' });
      audit({ ...base, status: 'sent', eventId: sent.eventId, text: decision.text });
      emit('outreach.reply', { username, action: 'replied', eventId: sent.eventId, text: decision.text });
      return { action: 'replied', username, category: decision.category, eventId: sent.eventId, text: decision.text };
    }
    audit({ ...base, status: 'send_failed', text: decision.text, error: sent && sent.error });
    emit('outreach.reply', { username, action: 'failed', error: sent && sent.error });
    return { action: 'failed', username, category: decision.category, error: sent && sent.error, text: decision.text };
  }

  if (decision.decision === 'needs_human') {
    markNeedsHuman(username, decision.reason || 'manual_review');
    audit({ ...base, status: 'needs_human' });
    emit('outreach.reply', { username, action: 'needs_human', reason: decision.reason });
    return { action: 'needs_human', username, category: decision.category, reason: decision.reason };
  }

  audit({ ...base, status: 'skipped' });
  emit('outreach.reply', { username, action: 'skipped', reason: decision.reason });
  return { action: 'skipped', username, category: decision.category, reason: decision.reason };
}

// ==================== 主流程 ====================

/**
 * 执行一轮客服回复。
 * @param {string} token Matrix token
 * @param {object} cfg { provider:{type, config}, maxReplies?, dryRun?, lockTimeoutMs? }
 * @param {{emit?: Function, poll?: Function, send?: Function}} [deps] 测试注入
 * @returns {Promise<{ok: boolean, summary: object, reason?: string, error?: string, failures?: Array}>}
 */
async function runReplier(token, cfg, { emit = () => {}, poll = inbox.pollNewReplies, send = null } = {}) {
  const provider = aiProvider.createProvider({ type: (cfg && cfg.provider && cfg.provider.type) || 'mock', config: (cfg && cfg.provider && cfg.provider.config) || {} });
  const dryRun = Boolean(cfg && cfg.dryRun);
  const maxReplies = Number((cfg && cfg.maxReplies) || 10);

  const lock = await sender.acquireLock({ timeoutMs: Number((cfg && cfg.lockTimeoutMs) || 0) });
  if (!lock.ok) {
    return { ok: false, reason: lock.reason || 'lock_not_acquired', holder: lock.holder, summary: emptySummary(dryRun) };
  }
  const sendMessage = send || ((t, roomId, text) => matrixChat.sendMatrixMessage(t, roomId, text));

  const counts = emptySummary(dryRun);
  const failures = [];
  try {
    const scan = await poll(token, {});
    if (!scan.ok) {
      return { ok: false, reason: 'poll_failed', error: scan.error, summary: counts, me: scan.me || null };
    }
    counts.detected = scan.replies.length;
    const limited = scan.replies.slice(0, maxReplies);
    for (const reply of limited) {
      // 知识库检索注入：LLM provider 用对方消息命中条目，避免编造业务信息
      if (typeof provider.setKnowledge === 'function') {
        const ragHits = await searchRag(reply.message);
        const hits = ragHits && ragHits.length ? ragHits : kb.search(reply.message, { topK: 3 });
        provider.setKnowledge(kb.itemsToPromptText(hits));
      }
      const outcome = await handleReply({
        reply, token, provider, dryRun,
        sendMessage,
        appendMessage: (u, e) => conversations.appendMessage(u, e),
        markNeedsHuman: (u, r, o) => conversations.markNeedsHuman(u, r, o),
        audit: (entry) => sender.appendAudit({ ...entry, id: undefined, event: entry.event }),
        emit,
      });
      outcomeCounter(outcome, counts);
      if (outcome.action === 'failed') failures.push({ username: outcome.username, error: outcome.error });
    }
  } finally {
    sender.releaseLock({ lockFile: sender.LOCK_FILE });
  }

  counts.ok = counts.failed === 0 && counts.needs_human >= 0; // 人工介入不算失败
  return {
    ok: counts.failed === 0,
    day: new Date().toISOString().slice(0, 10),
    summary: counts,
    failures,
  };
}

function emptySummary(dryRun) {
  return { detected: 0, replied: 0, replied_dry: 0, needs_human: 0, skipped: 0, failed: 0, dryRun: Boolean(dryRun) };
}

/** 解析 replier 配置（CLI） */
function parseReplierConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('配置必须是 JSON 对象');
  if (!config.target || !config.target.type || !config.target.value) throw new Error('缺少 target');
  if (!['serial', 'profiles', 'group'].includes(config.target.type)) throw new Error('target.type 必须是 serial / profiles / group');
  const providerType = String((config.provider && config.provider.type) || 'mock').toLowerCase();
  if (!['mock'].includes(providerType) && !['openai', 'deepseek'].includes(providerType)) {
    throw new Error('未知 provider.type');
  }
  return {
    target: { type: config.target.type, value: String(config.target.value).trim() },
    provider: { type: providerType, config: (config.provider && config.provider.config) || {} },
    maxReplies: Number(config.maxReplies || 10),
    dryRun: Boolean(config.dryRun),
    lockTimeoutMs: Number(config.lockTimeoutMs || 0),
  };
}

// ==================== CLI 入口 ====================

function parseArgs(argv) {
  const options = { config: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config') options.config = argv[i + 1];
  }
  return options;
}

function emitStatus(payload) {
  console.log(`@@STATUS@@${JSON.stringify(payload)}`);
}

function emitJson(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function targetQuery(target) {
  if (target.type === 'serial') return { serialNumbers: String(target.value).split(',').map((s) => s.trim()).filter(Boolean) };
  if (target.type === 'profiles') return { profileIds: String(target.value).split(',').map((s) => s.trim()).filter(Boolean) };
  return { groupName: String(target.value).trim() };
}

async function main() {
  const { config: configPath } = parseArgs(process.argv.slice(2));
  if (!configPath) {
    console.error('用法: node lib/outreach/replier.js --config <config.json>');
    process.exit(2);
  }
  let cfg;
  try {
    cfg = parseReplierConfig(JSON.parse(require('fs').readFileSync(configPath, 'utf8')));
  } catch (error) {
    console.error(`[replier] 配置无效: ${error.message}`);
    process.exit(2);
  }

  const { loadAdsModules } = require(path.join(ROOT, 'engine', 'lib', 'resolve-ads'));
  const { machineManager } = loadAdsModules();
  const { MachineManager } = machineManager;
  const manager = new MachineManager({ concurrency: 1, stopStartedProfiles: true });
  try {
    const profiles = await manager.resolveProfiles(targetQuery(cfg.target));
    if (!profiles.length) throw new Error('没有匹配的 AdsPower profile');
    const machine = await manager.connectMachine(profiles[0].id);
    const page = await manager.getMainPage(machine);
    // 打开 Chat 页确保 matrix token 就绪
    await page.goto('https://www.reddit.com/chat/', { waitUntil: 'domcontentloaded', timeout: 120000 });
    const tokenReady = await matrixChat.waitForToken(page, { timeoutMs: 60000 });
    if (!tokenReady) throw new Error('Matrix Chat token 未就绪');
    const token = await matrixChat.readAccessTokenFromPage(page);
    if (!token.ok) throw new Error('读取 Matrix token 失败');

    const result = await runReplier(token.token, cfg, { emit: emitStatus });
    emitJson({ ...result, profile: { serial: profiles[0].serial, id: profiles[0].id, name: profiles[0].name } });
  } finally {
    await manager.closeAll().catch(() => {});
  }
}

// ==================== 模块导出 ====================

if (require.main === module) {
  main().catch((error) => {
    console.error(`[replier] 失败: ${error && error.message || error}`);
    emitJson({ ok: false, error: error && error.message || error });
    process.exitCode = 1;
  });
}

module.exports = {
  MAX_HISTORY_LIMIT,
  searchRag,
  buildReplyContext,
  handleReply,
  runReplier,
  parseReplierConfig,
};