'use strict';
/**
 * requeue.test.js — 队列恢复工具测试
 * 覆盖：
 *   - buildRequeuePlan：状态过滤 / 原因过滤 / sub 过滤 / username 过滤 / 状态机约束
 *   - requeue：dry-run 不落盘；apply 真正恢复；非法迁移被拒绝
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 必须在 require queue/requeue 之前设置，保证 STATE_DIR 指向临时目录
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'requeue-test-'));
process.env.OUTREACH_STATE_DIR = TMP_DIR;

const queueModule = require('./queue');
const { buildRequeuePlan, requeue } = require('./requeue');

/** 构造一条队列记录 */
function makeItem(overrides) {
  return {
    id: `o-test-${overrides.username || 'x'}`,
    username: overrides.username || 'user',
    postTitle: 'test post',
    postUrl: 'https://www.reddit.com/r/x/comments/1a/',
    commentSnippet: 'hi',
    reason: 'commented_on_target_post',
    commentScore: 1,
    status: overrides.status || 'pending',
    draft: 'Hi {username}',
    sub: overrides.sub || 'lawncare',
    createdAt: '2026-08-31T00:00:00.000Z',
    queuedAt: null,
    sentAt: null,
    sendResult: overrides.sendResult || null,
    skipReason: overrides.skipReason || null,
  };
}

/** 在临时 STATE_DIR 里写入一个测试队列文件 */
function writeTestQueue(items) {
  fs.writeFileSync(queueModule.QUEUE_FILE, JSON.stringify({ schemaVersion: 1, items }, null, 2) + '\n', 'utf8');
}

// ---- buildRequeuePlan ----

{
  const skippedByLimit = makeItem({ username: 'a', status: 'skipped', skipReason: 'daily_limit_reached' });
  const skippedByRule = makeItem({ username: 'b', status: 'skipped', skipReason: 'blacklist' });
  const failedItem = makeItem({ username: 'c', status: 'failed', sendResult: { error: 'net' } });
  const sentItem = makeItem({ username: 'd', status: 'sent', sentAt: '2026-08-31T00:00:00.000Z' });
  const pendingItem = makeItem({ username: 'e', status: 'pending' });

  const plan = buildRequeuePlan([skippedByLimit, skippedByRule, failedItem, sentItem, pendingItem]);
  assert.strictEqual(plan.toRequeue.length, 3, 'skipped+failed 可恢复，sent/pending 不计入');
  assert.deepStrictEqual(plan.toRequeue.map((i) => i.username), ['a', 'b', 'c']);
  assert.strictEqual(plan.notEligible.length, 0, 'skipped/failed 均可迁移到 pending');
  assert.strictEqual(plan.filteredOut.length, 0);
}

{
  // 目标状态但状态机不允许迁移 → notEligible
  const weird = makeItem({ username: 'z', status: 'weird' });
  const plan = buildRequeuePlan([weird], { statuses: ['weird'] });
  assert.strictEqual(plan.notEligible.length, 1, '未知状态不允许迁移');
}

{
  // 只恢复指定状态
  const failedItem = makeItem({ username: 'f', status: 'failed', sendResult: { error: 'x' } });
  const skippedItem = makeItem({ username: 'g', status: 'skipped', skipReason: 'daily_limit_reached' });
  const plan = buildRequeuePlan([failedItem, skippedItem], { statuses: ['failed'] });
  assert.deepStrictEqual(plan.toRequeue.map((i) => i.username), ['f']);
}

{
  // 按 skipReason 过滤
  const a = makeItem({ username: 'h', status: 'skipped', skipReason: 'daily_limit_reached' });
  const b = makeItem({ username: 'i', status: 'skipped', skipReason: 'other' });
  const plan = buildRequeuePlan([a, b], { reasons: ['daily_limit_reached'] });
  assert.deepStrictEqual(plan.toRequeue.map((i) => i.username), ['h']);
  assert.strictEqual(plan.filteredOut.length, 1);
}

{
  // 按 sub / username 过滤（大小写不敏感）
  const a = makeItem({ username: 'JohnDoe', status: 'skipped', skipReason: 'daily_limit_reached', sub: 'LawnCare' });
  const b = makeItem({ username: 'Jane', status: 'skipped', skipReason: 'daily_limit_reached', sub: 'gardening' });
  const bySub = buildRequeuePlan([a, b], { subs: ['lawncare'] });
  assert.deepStrictEqual(bySub.toRequeue.map((i) => i.username), ['JohnDoe']);
  const byUser = buildRequeuePlan([a, b], { usernames: ['jane'] });
  assert.deepStrictEqual(byUser.toRequeue.map((i) => i.username), ['Jane']);
}

// ---- requeue ----

{
  writeTestQueue([
    makeItem({ username: 'r1', status: 'skipped', skipReason: 'daily_limit_reached' }),
    makeItem({ username: 'r2', status: 'failed', sendResult: { error: 'sel' } }),
    makeItem({ username: 'r3', status: 'sent', sentAt: '2026-08-31T00:00:00.000Z' }),
  ]);

  // dry-run：状态不变
  const dry = requeue({});
  assert.strictEqual(dry.applied, false);
  const afterDry = JSON.parse(fs.readFileSync(queueModule.QUEUE_FILE, 'utf8'));
  assert.deepStrictEqual(
    afterDry.items.map((i) => i.status),
    ['skipped', 'failed', 'sent'],
    'dry-run 不落盘'
  );

  // apply：skipped+failed → pending；sent 保持
  const applied = requeue({ apply: true });
  assert.strictEqual(applied.applied, true);
  assert.strictEqual(applied.updated.length, 2);
  assert.strictEqual(applied.invalid.length, 0, 'sent 不再传入 ids，不产生 invalid');
  const afterApply = JSON.parse(fs.readFileSync(queueModule.QUEUE_FILE, 'utf8'));
  assert.deepStrictEqual(
    afterApply.items.map((i) => i.status),
    ['pending', 'pending', 'sent'],
    'skipped/failed 恢复为 pending，sent 不受影响'
  );
  assert.strictEqual(afterApply.items[0].skipReason, null, '恢复后清除 skipReason');
}

// ---- 清理 ----
fs.rmSync(TMP_DIR, { recursive: true, force: true });
console.log('requeue tests passed');