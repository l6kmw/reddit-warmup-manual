'use strict';

const assert = require('assert');
const {
  normalizeKeywords,
  titleMatchesKeywords,
  filterPostsByKeywords,
  flattenComments,
  filterCommentsByRecency,
  isExcludedAuthor,
  dedupeAuthors,
  buildCandidates,
} = require('./discover');

// ---- normalizeKeywords ----
assert.deepStrictEqual(normalizeKeywords([' Founder ', 'SAAS', '', null, 42]), ['founder', 'saas', '42']);
assert.deepStrictEqual(normalizeKeywords([]), []);
assert.deepStrictEqual(normalizeKeywords(undefined), []);

// ---- titleMatchesKeywords ----
assert.strictEqual(titleMatchesKeywords('My SaaS startup journey', ['saas']), true);
assert.strictEqual(titleMatchesKeywords('My SaaS startup journey', ['founder']), false);
assert.strictEqual(titleMatchesKeywords('SaaS BUSINESS', ['saas']), true, '大小写不敏感');
assert.strictEqual(titleMatchesKeywords('Anything', []), true, '空关键词=全部命中');
assert.strictEqual(titleMatchesKeywords('', ['x']), false);

// ---- filterPostsByKeywords ----
const posts = [
  { id: 'p1', title: 'SaaS pricing question', stickied: false },
  { id: 'p2', title: 'Daily life in the city', stickied: false },
  { id: 'p3', title: 'Startup founder AMA', stickied: true },
  { id: 'p4', title: 'Startup legal advice', stickied: false },
];
const seen = new Set(['p4']);
const filtered = filterPostsByKeywords(posts, ['startup', 'saas'], seen);
assert.deepStrictEqual(filtered.matched.map((p) => p.id), ['p1']);
assert.deepStrictEqual(
  filtered.skipped.map(({ id, reason }) => ({ id, reason })),
  [
    { id: 'p2', reason: 'keyword_miss' },
    { id: 'p3', reason: 'stickied' },
    { id: 'p4', reason: 'already_processed' },
  ],
);

// ---- flattenComments ----
const tree = [
  { author: 'alice', body: 'top', score: 3, createdUtc: 1000, replies: [
    { author: 'bob', body: 'nested', score: 1, createdUtc: 1001, replies: [
      { author: 'carol', body: 'deep', score: 0, createdUtc: 1002, replies: [] },
    ] },
  ] },
  { author: 'dave', body: 'sibling', score: 2, createdUtc: 1003, replies: '' },
];
const flat = flattenComments(tree);
assert.deepStrictEqual(flat.map((c) => c.author), ['alice', 'bob', 'carol', 'dave']);
assert.deepStrictEqual(flat.map((c) => c.depth), [0, 1, 2, 0]);
assert.strictEqual(flat[2].body, 'deep');

// ---- filterCommentsByRecency ----
const now = Date.now() / 1000;
const comments = [
  { author: 'alice', score: 5, createdUtc: now - 3600 },      // 1h 前，ok
  { author: 'bob', score: 0, createdUtc: now - 3600 },        // 分数不足
  { author: 'carol', score: 5, createdUtc: now - 72 * 3600 }, // 超出 48h
  { author: '[deleted]', score: 5, createdUtc: now - 3600 },  // deleted
  { author: 'dave', score: 5, createdUtc: now - 3600 },       // ok
  { author: '', score: 5, createdUtc: now - 3600 },           // 空作者
];
assert.deepStrictEqual(
  filterCommentsByRecency(comments, { commentHours: 48, minScore: 1 }).map((c) => c.author),
  ['alice', 'dave'],
);

// ---- isExcludedAuthor ----
assert.strictEqual(isExcludedAuthor('normal_user'), false);
assert.strictEqual(isExcludedAuthor('PostAuthor', { op: ['postauthor'] }), true, '帖主本人排除');
assert.strictEqual(isExcludedAuthor('mod_user', { mods: ['mod_user'] }), true, '版主排除');
assert.strictEqual(isExcludedAuthor('AutoModerator'), true, 'AutoModerator 默认排除');
assert.strictEqual(isExcludedAuthor('some_bot'), true, 'bot 后缀排除');
assert.strictEqual(isExcludedAuthor('bot_123'), true, 'bot 前缀排除');
assert.strictEqual(isExcludedAuthor('my_mod'), true, 'mod 后缀排除');
assert.strictEqual(isExcludedAuthor('ContactedUser', { contacted: new Set(['contacteduser']) }), true, '已联系排除（大小写不敏感）');
assert.strictEqual(isExcludedAuthor('extra', { excludeNames: ['Extra'] }), true, '额外名单排除');
assert.strictEqual(isExcludedAuthor(''), true, '空名排除');
assert.strictEqual(isExcludedAuthor('[deleted]'), true, 'deleted 排除');

// ---- dedupeAuthors ----
const dupes = [
  { author: 'alice', body: '1' },
  { author: 'ALICE', body: '2' },
  { author: 'bob', body: '3' },
  { author: 'alice', body: '4' },
];
assert.deepStrictEqual(dedupeAuthors(dupes).map((c) => c.body), ['1', '3'], '大小写不敏感去重，保留首次');

// ---- buildCandidates（核心：全量评论者进候选） ----
const postA = { id: 'pA', title: 'SaaS founder tips', author: 'op_alice', permalink: '/r/test/comments/pA/' };
const postB = { id: 'pB', title: 'Startup hiring', author: 'op_bob', permalink: '/r/test/comments/pB/' };
const commentsByPost = {
  pA: [
    { author: 'user1', body: 'Great point about SaaS', score: 5, createdUtc: Date.now() / 1000, replies: [] },
    { author: 'op_alice', body: 'Thanks!', score: 2, createdUtc: Date.now() / 1000, replies: [] },           // OP 排除
    { author: 'bot_account', body: 'spam', score: 1, createdUtc: Date.now() / 1000, replies: [] },           // 机器人排除
    { author: 'user1', body: 'Second comment, same person', score: 1, createdUtc: Date.now() / 1000, replies: [] }, // 同帖同作者去重
  ],
  pB: [
    { author: 'user1', body: 'comment in other post', score: 3, createdUtc: Date.now() / 1000, replies: [] }, // 跨帖去重
    { author: 'user2', body: 'We are hiring too', score: 4, createdUtc: Date.now() / 1000, replies: [] },
  ],
};
const built = buildCandidates([postA, postB], commentsByPost, { contacted: new Set(['user3']) });
assert.strictEqual(built.candidates.length, 2, '全量评论者进候选：user1 跨帖只留一次 + user2');
assert.deepStrictEqual(built.candidates.map((c) => c.username), ['user1', 'user2']);
const u1 = built.candidates[0];
assert.strictEqual(u1.postId, 'pA', '保留首个帖子上下文');
assert.strictEqual(u1.postUrl, 'https://www.reddit.com/r/test/comments/pA/');
assert.strictEqual(u1.commentSnippet, 'Great point about SaaS');
assert.strictEqual(u1.reason, 'commented_on_target_post');
assert.strictEqual(built.excludedCount, 4, 'OP/机器人/同帖重复/跨帖重复共 4 个排除');

// ---- buildCandidates：评论内容不过滤（无关键词相关性要求） ----
const unrelated = buildCandidates(
  [{ id: 'pC', title: 'Unrelated title but matched keyword', author: 'op', permalink: '/r/test/comments/pC/' }],
  { pC: [{ author: 'user9', body: 'totally unrelated comment content', score: 9, createdUtc: Date.now() / 1000, replies: [] }] },
);
assert.strictEqual(unrelated.candidates.length, 1, '评论内容不设关键词过滤，全量进候选');

console.log('discover tests passed');