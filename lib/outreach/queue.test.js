'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// 隔离测试：把队列状态文件重定向到独立临时目录
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'outreach-queue-test-'));
process.env.OUTREACH_STATE_DIR = TMP_DIR;

const {
  STATUS,
  renderDraft,
  validateTemplate,
  buildQueueItem,
  selectEnqueueable,
  listQueue,
  queueStats,
  dailySentCount,
  enqueueCandidates,
  markStatus,
} = require('./queue');

// ---- renderDraft ----
const draft = renderDraft('Hi {username}, saw your comment on {post_title} in {sub}: "{comment_snippet}"', {
  username: 'Alice_88',
  postTitle: 'SaaS pricing help',
  commentSnippet: 'We use Stripe and it works (a+b) well.',
  sub: 'SaaS',
});
assert.strictEqual(
  draft,
  'Hi Alice_88, saw your comment on SaaS pricing help in SaaS: "We use Stripe and it works (a+b) well."',
  '占位符全部替换，含正则特殊字符 (a+b) 不被误解析',
);
assert.strictEqual(renderDraft('x', null), 'x', 'candidate 为空不崩溃');
assert.strictEqual(renderDraft('u={username}', {}), 'u=', '缺字段替换为空字符串');

// ---- validateTemplate ----
assert.deepStrictEqual(validateTemplate('Hi {username}'), [], '合法模板');
assert.ok(validateTemplate('').length, '空模板报错');
assert.ok(validateTemplate('no placeholder').length, '缺 {username} 报错');

// ---- buildQueueItem ----
const item = buildQueueItem(
  { username: 'Bob', postId: 'p1', postTitle: 'T', postUrl: 'U', commentSnippet: 'C', reason: 'commented_on_target_post', commentScore: 5 },
  { template: 'Hi {username}', sub: 'r/Test' },
);
assert.strictEqual(item.username, 'Bob');
assert.strictEqual(item.status, STATUS.PENDING);
assert.strictEqual(item.draft, 'Hi Bob');
assert.strictEqual(item.sub, 'r/Test');
assert.strictEqual(item.sentAt, null);
assert.ok(item.id.startsWith('o-'));

// ---- selectEnqueueable ----
const candidates = [
  { username: 'Alice' },
  { username: 'Alice' }, // 队列内重复
  { username: 'Bob' },
  { username: 'ContactedGuy' }, // 黑名单
  { username: '  ' }, // 空名
  { username: 'Carol' },
];
const selected = selectEnqueueable(candidates.slice(), {
  existingUsernames: new Set(['bob']),
  contacted: new Set(['contactedguy']),
});
assert.deepStrictEqual(selected.items.map((c) => c.username), ['Alice', 'Carol'], '去重后剩余 Alice/Carol');
assert.deepStrictEqual(
  selected.rejected.map((r) => r.reason),
  ['already_in_queue', 'already_in_queue', 'already_contacted', 'empty_username'],
  'Bob 已在队列/Alice 重复/ContactedGuy 黑名单/空名被拒',
);

// ---- enqueueCandidates（集成：真实文件在临时目录） ----
const first = enqueueCandidates([{ username: 'Alice' }, { username: 'Bob' }], { template: 'Hi {username}' });
assert.strictEqual(first.added, 2, '首次入队 2 条');
assert.deepStrictEqual(first.rejected, [], '无拒绝');

const second = enqueueCandidates([{ username: 'Bob' }, { username: 'Carol' }], { template: 'Hi {username}' });
assert.strictEqual(second.added, 1, 'Bob 重复被拒，Carol 新增');
assert.deepStrictEqual(second.rejected, [{ username: 'Bob', reason: 'already_in_queue' }]);

// ---- blacklist：已联系用户入队被拒（模拟 contacted 文件） ----
fs.writeFileSync(path.join(TMP_DIR, 'outreach-contacted.json'), JSON.stringify({ users: ['dave'] }), 'utf8');
const third = enqueueCandidates([{ username: 'Dave' }, { username: 'Eve' }], { template: 'Hi {username}' });
assert.strictEqual(third.added, 1, 'Dave 在黑名单被拒');
assert.deepStrictEqual(third.rejected, [{ username: 'Dave', reason: 'already_contacted' }]);

// ---- listQueue / queueStats ----
assert.strictEqual(listQueue().length, 4, 'Alice/Bob/Carol/Eve 共 4 条');
assert.strictEqual(listQueue({ status: STATUS.PENDING }).length, 4);
assert.strictEqual(listQueue({ query: 'alice' }).length, 1, '按用户名搜索');

const stats = queueStats();
assert.strictEqual(stats.total, 4);
assert.strictEqual(stats[STATUS.PENDING], 4);

// ---- markStatus + 迁移校验 ----
const all = listQueue();
const [aId, bId] = [all[0].id, all[1].id];
const marked = markStatus([aId], STATUS.SENT);
assert.strictEqual(marked.updated.length, 1);
assert.strictEqual(listQueue({ status: STATUS.SENT }).length, 1);

// pending → skipped 合法
markStatus([bId], STATUS.SKIPPED, { reason: 'rule_skip' });
assert.strictEqual(listQueue({ status: STATUS.SKIPPED }).length, 1);

// sent → failed 非法
const invalid = markStatus([aId], STATUS.FAILED);
assert.strictEqual(invalid.updated.length, 0, 'sent 不能迁移到 failed');
assert.strictEqual(invalid.invalid.length, 1);
assert.strictEqual(invalid.invalid[0].from, STATUS.SENT);
assert.strictEqual(invalid.invalid[0].to, STATUS.FAILED);

// failed → pending 合法（重新排队）
const cId = listQueue({ status: STATUS.PENDING })[0].id;
markStatus([cId], STATUS.FAILED, { error: 'network' });
assert.strictEqual(listQueue({ status: STATUS.FAILED }).length, 1);
const requeued = markStatus([cId], STATUS.PENDING);
assert.strictEqual(requeued.updated.length, 1, 'failed 可重新排队');

// ---- dailySentCount ----
const sentItems = listQueue({ status: STATUS.SENT });
const sentAt = sentItems[0].sentAt;
assert.strictEqual(dailySentCount(), 1, '今日已发送 1 条');
assert.strictEqual(dailySentCount(new Date(Date.now() - 86400000).toISOString()), 0, '昨天为 0');
assert.strictEqual(dailySentCount(sentAt), 1, '按发送日统计');

console.log('queue tests passed');