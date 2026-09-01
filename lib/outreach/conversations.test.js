'use strict';
/**
 * conversations.test.js — 会话表（AI 客服数据层）测试
 * 覆盖：旧 contacted 惰性迁移 / 黑名单语义 / 会话生命周期 / 过滤查询
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 隔离测试目录（必须在 require 之前设置）
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'conversations-test-'));
process.env.OUTREACH_STATE_DIR = TMP_DIR;

const conv = require('./conversations');

// ---- 惰性迁移：旧 contacted.json → 会话表 ----
{
  fs.writeFileSync(path.join(TMP_DIR, 'outreach-contacted.json'), JSON.stringify({
    schemaVersion: 1,
    users: ['AlphaUser', 'Beta_User'],
  }), 'utf8');

  const data = conv.readData();
  assert.strictEqual(data.schemaVersion, 2);
  assert.deepStrictEqual(data.users, ['AlphaUser', 'Beta_User']);
  assert.ok(data.conversations['alphauser'], '迁移生成小写 key 会话');
  assert.ok(data.conversations['beta_user']);
  assert.strictEqual(data.conversations['alphauser'].username, 'AlphaUser');
  assert.strictEqual(data.conversations['alphauser'].threadStatus, 'active');
  assert.deepStrictEqual(data.conversations['alphauser'].replyHistory, []);
  assert.ok(fs.existsSync(conv.CONVERSATIONS_FILE), '迁移后写入权威文件');
  assert.ok(fs.existsSync(conv.LEGACY_CONTACTED_FILE), '旧文件保留');
}

// ---- 黑名单语义 ----
{
  assert.ok(conv.contactedUserSet().has('alphauser'), '大小写不敏感（集合内统一小写）');
  assert.ok(conv.contactedUserSet().has('beta_user'));
  assert.ok([...conv.contactedUserSet()].every((k) => k === k.toLowerCase()), '集合元素均为小写');
  assert.strictEqual(conv.contactedUserSet().size, 2);

  const r = conv.recordContactedUsers(['GammaUser', 'AlphaUser', '']);
  assert.strictEqual(r.added, 1, '新用户 +1，重复与空串不计');
  assert.strictEqual(r.total, 3);
  assert.ok(conv.findConversation('gammauser'), '登记即建会话');
}

// ---- 会话生命周期 ----
{
  const c = conv.ensureConversation('DeltaUser', { roomId: '!roomD:reddit.com', context: { sub: 'lawncare', postTitle: 'Sod help' } });
  assert.strictEqual(c.roomId, '!roomD:reddit.com');
  assert.strictEqual(c.context.postTitle, 'Sod help');
  assert.strictEqual(conv.roomIdOf('DeltaUser'), '!roomD:reddit.com');

  // 补录 roomId（之前只有用户名）
  conv.ensureConversation('AlphaUser', { roomId: '!roomA:reddit.com' });
  assert.strictEqual(conv.findConversation('AlphaUser').roomId, '!roomA:reddit.com');

  // 追加消息
  const app = conv.appendMessage('DeltaUser', { from: 'them', body: 'how are you', ts: '2026-09-01T00:00:00.000Z' });
  assert.strictEqual(app.ok, true);
  const app2 = conv.appendMessage('DeltaUser', { from: 'me', body: 'I am good, thanks!', source: 'matrix' });
  assert.strictEqual(app2.ok, true);
  const d = conv.findConversation('DeltaUser');
  assert.strictEqual(d.replyHistory.length, 2);
  assert.strictEqual(d.replyHistory[0].from, 'them');
  assert.strictEqual(d.replyHistory[1].from, 'me');
  assert.ok(d.lastCheckAt, 'lastCheckAt 被更新');

  // 转人工
  const mh = conv.markNeedsHuman('DeltaUser', 'price_question', { details: 'asked how much' });
  assert.strictEqual(mh.ok, true);
  const after = conv.findConversation('DeltaUser');
  assert.strictEqual(after.needsHuman, true);
  assert.strictEqual(after.threadStatus, 'needs_human');
  assert.strictEqual(after.needsHumanReason, 'price_question');
}

// ---- 查询过滤 / 不存在处理 ----
{
  assert.strictEqual(conv.findConversation('NoSuchUser'), null);
  assert.strictEqual(conv.roomIdOf('NoSuchUser'), null);
  assert.strictEqual(conv.appendMessage('NoSuchUser', { body: 'x' }).ok, false);
  assert.strictEqual(conv.markNeedsHuman('NoSuchUser', 'x').ok, false);
  assert.strictEqual(conv.touchCheckAt('NoSuchUser').ok, false);

  const needsHuman = conv.listConversations({ needsHuman: true });
  assert.ok(needsHuman.some((c) => c.username === 'DeltaUser'));
  const active = conv.listConversations({ threadStatus: 'active' });
  assert.ok(!active.some((c) => c.username === 'DeltaUser'));
}

// ---- 清理 ----
fs.rmSync(TMP_DIR, { recursive: true, force: true });
console.log('conversations tests passed');