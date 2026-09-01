'use strict';
/**
 * replier.test.js — AI 客服回复器测试
 * 覆盖：上下文构建 / 单条处理（回复/人工/跳过/失败/dryRun/AI异常） / 主流程（注入 poll）
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'replier-test-'));
process.env.OUTREACH_STATE_DIR = TMP_DIR;
process.env.OUTREACH_AUDIT_DIR = path.join(TMP_DIR, 'logs');

const replier = require('./replier');
const ai = require('./ai-provider');

(async () => {

// ---- buildReplyContext ----
{
  const conv = {
    username: 'Bob',
    context: { sub: 'lawncare', postTitle: 'Sod help' },
    replyHistory: [
      { from: 'me', body: 'Hi', ts: '2026-09-01T01:00:00Z' },
      { from: 'them', body: 'hello', ts: '2026-09-01T01:01:00Z' },
    ],
  };
  const context = replier.buildReplyContext(conv, { message: '  how are you  ' });
  assert.strictEqual(context.username, 'Bob');
  assert.strictEqual(context.message, 'how are you', '消息去空白');
  assert.strictEqual(context.history.length, 2);
  assert.strictEqual(context.history[1].from, 'them');
  assert.strictEqual(context.userProfile.sub, 'lawncare');
}

// ---- handleReply：寒暄自动回复 ----
{
  const calls = { append: [], audit: [], sent: [] };
  const outcome = await replier.handleReply({
    reply: { username: 'Bob', roomId: '!r:reddit.com', message: 'hi!', conversation: { username: 'Bob', replyHistory: [], context: {} } },
    token: 'tok',
    provider: ai.createProvider({}),
    dryRun: false,
    sendMessage: async (t, room, text) => { calls.sent.push({ room, text }); return { ok: true, eventId: '$e1' }; },
    appendMessage: (u, e) => { calls.append.push({ u, e }); return { ok: true }; },
    markNeedsHuman: () => {},
    audit: (e) => { calls.audit.push(e); },
  });
  assert.strictEqual(outcome.action, 'replied');
  assert.strictEqual(calls.sent.length, 1, '发送一次');
  assert.strictEqual(calls.append.length, 2, '对方消息 + 我方回复各一条');
  assert.strictEqual(calls.append[0].e.from, 'them');
  assert.strictEqual(calls.append[1].e.from, 'me');
  assert.strictEqual(calls.audit[0].status, 'sent');
}

// ---- handleReply：购买意向转人工 ----
{
  const calls = { mh: [], sent: [], append: [] };
  const outcome = await replier.handleReply({
    reply: { username: 'Cindy', roomId: '!r2:reddit.com', message: 'how much?', conversation: { username: 'Cindy', replyHistory: [] } },
    token: 'tok',
    provider: ai.createProvider({}),
    sendMessage: async () => { calls.sent.push(1); return { ok: true }; },
    appendMessage: (u, e) => { calls.append.push(e); return { ok: true }; },
    markNeedsHuman: (u, r) => { calls.mh.push({ u, r }); return { ok: true }; },
    audit: () => {},
  });
  assert.strictEqual(outcome.action, 'needs_human');
  assert.strictEqual(calls.sent.length, 0, '不发送');
  assert.strictEqual(calls.mh.length, 1, '标记人工');
  assert.strictEqual(calls.append.length, 1, '仅记录对方消息');
}

// ---- handleReply：发送失败 → failed（对方消息已入库） ----
{
  const calls = { append: [], sent: [] };
  const outcome = await replier.handleReply({
    reply: { username: 'D', roomId: '!r3:reddit.com', message: 'hi', conversation: { username: 'D', replyHistory: [] } },
    token: 'tok',
    provider: ai.createProvider({}),
    sendMessage: async () => { calls.sent.push(1); return { ok: false, error: 'network' }; },
    appendMessage: (u, e) => { calls.append.push(e); return { ok: true }; },
    markNeedsHuman: () => {},
    audit: () => {},
  });
  assert.strictEqual(outcome.action, 'failed');
  assert.match(outcome.error, /network/);
  assert.strictEqual(calls.append.length, 1, '对方消息仍然入库（防重扫）');
}

// ---- handleReply：dryRun 不发送 ----
{
  const calls = { sent: [] };
  const outcome = await replier.handleReply({
    reply: { username: 'E', roomId: '!r4:reddit.com', message: 'hello!', conversation: { username: 'E', replyHistory: [] } },
    token: 'tok',
    provider: ai.createProvider({}),
    dryRun: true,
    sendMessage: async () => { calls.sent.push(1); return { ok: true }; },
    appendMessage: () => ({ ok: true }),
    markNeedsHuman: () => {},
    audit: () => {},
  });
  assert.strictEqual(outcome.action, 'replied_dry');
  assert.strictEqual(calls.sent.length, 0);
}

// ---- handleReply：AI 抛异常 → 保守转人工 ----
{
  const calls = { mh: [] };
  const outcome = await replier.handleReply({
    reply: { username: 'F', roomId: '!r5:reddit.com', message: 'hi', conversation: { username: 'F', replyHistory: [] } },
    token: 'tok',
    provider: { generateReply: async () => { throw new Error('api down'); } },
    sendMessage: async () => ({ ok: true }),
    appendMessage: () => ({ ok: true }),
    markNeedsHuman: (u, r) => { calls.mh.push(r); return { ok: true }; },
    audit: () => {},
  });
  assert.strictEqual(outcome.action, 'needs_human');
  assert.match(calls.mh[0], /ai_error/);
}

// ---- runReplier：注入 poll ----
{
  const replies = [
    { username: 'G1', roomId: '!r:reddit.com', message: 'hello', conversation: { username: 'G1', replyHistory: [], context: {} } },
    { username: 'G2', roomId: '!r2:reddit.com', message: 'how much is shipping?', conversation: { username: 'G2', replyHistory: [], context: {} } },
  ];
  const fakePoll = async () => ({ ok: true, replies, threadCount: 2, me: '@t2_me:reddit.com' });
  const fakeSend = async () => ({ ok: true, eventId: '$g' });
  const result = await replier.runReplier('tok', { provider: { type: 'mock' }, maxReplies: 10 }, { poll: fakePoll, send: fakeSend, emit: () => {} });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.summary.detected, 2);
  assert.strictEqual(result.summary.replied, 1, '寒暄自动回复');
  assert.strictEqual(result.summary.needs_human, 1, '购买意向转人工');
  assert.strictEqual(result.summary.failed, 0);
}

// ---- runReplier：poll 失败 ----
{
  const fakePoll = async () => ({ ok: false, error: 'sync_M_FORBIDDEN' });
  const result = await replier.runReplier('tok', { provider: { type: 'mock' } }, { poll: fakePoll });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'poll_failed');
}

// ---- parseReplierConfig ----
{
  assert.throws(() => replier.parseReplierConfig(null), /配置/);
  assert.throws(() => replier.parseReplierConfig({}), /target/);
  const cfg = replier.parseReplierConfig({ target: { type: 'serial', value: '34' }, provider: { type: 'mock' }, maxReplies: 5, dryRun: true });
  assert.strictEqual(cfg.target.value, '34');
  assert.strictEqual(cfg.provider.type, 'mock');
  assert.strictEqual(cfg.dryRun, true);
  assert.throws(() => replier.parseReplierConfig({ target: { type: 'serial', value: '34' }, provider: { type: 'weird' } }), /未知/);
}

fs.rmSync(TMP_DIR, { recursive: true, force: true });
console.log('replier tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});