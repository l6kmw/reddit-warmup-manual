'use strict';
/**
 * discover.js — 私信触达：帖子发现 + 评论收集 + 评论者候选生成
 *
 * 职责（对应 docs/outreach-design.md §4.1）：
 *   1. 通过 AdsPower 已登录 Profile 访问 Reddit 的 .json 端点，
 *      拉取指定社区最近帖子（new 排序，limit=maxPosts）
 *   2. 标题命中 keywords（大小写不敏感）的帖子进入候选；
 *      排除置顶帖与已处理过的帖子（postId 去重）
 *   3. 对每个候选帖拉评论树，扁平化后按时间窗/分数过滤，
 *      每帖最多 maxCommentsPerPost 条
 *   4. 私信对象 = 目标帖子的所有评论者（不做评论内容相关性过滤），
 *      仅做硬排除：帖主本人、版主、机器人、已联系用户、额外排除名单
 *   5. 跨帖按作者全局去重，输出候选列表
 *
 * 模块结构：
 *   - 纯函数层（可单测，无浏览器依赖）：
 *     normalizeKeywords / titleMatchesKeywords / filterPostsByKeywords /
 *     flattenComments / filterCommentsByRecency / isExcludedAuthor /
 *     dedupeAuthors / buildCandidates
 *   - 浏览器层：fetchSubredditPosts / fetchPostComments / runDiscover
 *   - CLI 入口：node lib/outreach/discover.js --config <json>
 *     （结果 JSON 独占 stdout，过程日志走 stderr，与 engine/jsonout 协议一致）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ENGINE_ROOT = path.join(ROOT, 'engine');
const STATE_DIR = path.join(ROOT, 'state');

const PROCESSED_POSTS_FILE = path.join(STATE_DIR, 'outreach-processed.json');
const CONTACTED_FILE = path.join(STATE_DIR, 'outreach-contacted.json');

const DEFAULT_BOTS = ['automoderator'];
// 机器人用户名启发式：_bot/_mod/automoderator/auto_ 前缀/bot_ 前缀/结尾 bot 或 mod
const BOT_NAME_PATTERN = /(_bot|_mod|automoderator|^auto_|^bot_|bot$|mod$)/i;

// ==================== 纯函数层（可单测） ====================

/** 规范化关键词列表（去空、小写） */
function normalizeKeywords(keywords) {
  return (Array.isArray(keywords) ? keywords : [])
    .filter((v) => v != null)
    .map((k) => String(k).trim().toLowerCase())
    .filter(Boolean);
}

/** 标题是否命中任一关键词（大小写不敏感） */
function titleMatchesKeywords(title, keywords) {
  const t = String(title || '').toLowerCase();
  const kws = normalizeKeywords(keywords);
  if (!kws.length) return true;
  return kws.some((k) => t.includes(k));
}

/**
 * 按标题关键词 + 已处理去重过滤帖子。
 * @param {Array<object>} posts 来自 fetchSubredditPosts 的帖子列表
 * @param {Array<string>} keywords 关键词
 * @param {Set<string>} [seenPostIds] 已处理过的 postId（跳过）
 * @returns {{matched: Array, skipped: Array<{id, reason}>}}
 */
function filterPostsByKeywords(posts, keywords, seenPostIds = new Set()) {
  const kws = normalizeKeywords(keywords);
  const matched = [];
  const skipped = [];
  for (const post of posts || []) {
    const id = String(post.id || '');
    if (!id) {
      skipped.push({ id: null, reason: 'missing_id' });
      continue;
    }
    if (seenPostIds.has(id)) {
      skipped.push({ id, reason: 'already_processed' });
      continue;
    }
    if (post.stickied) {
      skipped.push({ id, reason: 'stickied' });
      continue;
    }
    if (!titleMatchesKeywords(post.title, kws)) {
      skipped.push({ id, reason: 'keyword_miss' });
      continue;
    }
    matched.push(post);
  }
  return { matched, skipped };
}

/**
 * 扁平化评论树（递归展开 replies）。
 * 兼容 replies 为对象（Listing）或空字符串（无回复）两种情况。
 * @param {Array<object>} children 评论树根 children
 * @returns {Array<{author, body, score, createdUtc, depth}>}
 */
function flattenComments(children) {
  const out = [];
  const walk = (items, depth) => {
    for (const item of items || []) {
      if (!item || typeof item !== 'object') continue;
      const replies = Array.isArray(item.replies) ? item.replies : [];
      out.push({
        author: String(item.author || '').trim(),
        body: String(item.body || ''),
        score: typeof item.score === 'number' ? item.score : null,
        createdUtc: typeof item.createdUtc === 'number' ? item.createdUtc : null,
        depth,
      });
      walk(replies, depth + 1);
    }
  };
  walk(children, 0);
  return out;
}

/**
 * 按时间窗与分数过滤评论（时间窗使用 createdUtc：Unix 秒）。
 * @param {Array<object>} comments flattenComments 输出
 * @param {{commentHours?: number, minScore?: number}} [opts]
 * @returns {Array<object>} 过滤后的评论（保持原顺序）
 */
function filterCommentsByRecency(comments, { commentHours = 48, minScore = 1 } = {}) {
  const cutoff = Date.now() / 1000 - commentHours * 3600;
  return (comments || []).filter((c) => {
    if (!c.author || c.author === '[deleted]') return false;
    if (typeof c.createdUtc === 'number' && c.createdUtc < cutoff) return false;
    if (typeof c.score === 'number' && c.score < minScore) return false;
    return true;
  });
}

/**
 * 硬排除判定：帖主本人 / 版主 / 机器人 / 已联系 / 额外名单。
 * @param {string} name 评论者用户名
 * @param {{op?: Array<string>, mods?: Array<string>, bots?: Array<string>,
 *          contacted?: Set<string>, excludeNames?: Array<string>}} [opts]
 * @returns {boolean} true=应排除
 */
function isExcludedAuthor(name, { op = [], mods = [], bots = DEFAULT_BOTS, contacted = new Set(), excludeNames = [] } = {}) {
  const n = String(name || '').trim().toLowerCase();
  if (!n || n === '[deleted]') return true;
  if (contacted instanceof Set && contacted.has(n)) return true;
  const blocklist = new Set([...op, ...mods, ...bots, ...excludeNames].map((s) => String(s).trim().toLowerCase()).filter(Boolean));
  if (blocklist.has(n)) return true;
  return BOT_NAME_PATTERN.test(n);
}

/**
 * 跨作者去重（大小写不敏感），保持首次出现顺序。
 * @param {Array<object>} comments
 * @returns {Array<object>} 每条评论保留首次出现的作者
 */
function dedupeAuthors(comments) {
  const seen = new Set();
  const out = [];
  for (const c of comments || []) {
    const key = String(c.author || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * 核心候选构建：帖子 × 评论 → 候选列表。
 * 私信对象 = 目标帖子的所有评论者（只做硬排除，不做评论内容相关性过滤）。
 *
 * @param {Array<object>} posts 已通过标题关键词过滤的帖子
 * @param {Record<string, Array<object>>} commentsByPost postId → 评论树 children
 * @param {object} [opts]
 * @param {number} [opts.commentHours=48] 评论时间窗（小时）
 * @param {number} [opts.minScore=1] 评论最低分数
 * @param {number} [opts.maxCommentsPerPost=50] 每帖最多参与构建的评论数
 * @param {Array<string>} [opts.mods=[]] 版主名单（排除）
 * @param {Array<string>} [opts.bots=DEFAULT_BOTS] 机器人名单（排除）
 * @param {Set<string>} [opts.contacted=new Set()] 已联系用户集合（排除）
 * @param {Array<string>} [opts.excludeNames=[]] 额外排除名单
 * @returns {{candidates: Array<object>, excludedCount: number}}
 */
function buildCandidates(posts, commentsByPost, {
  commentHours = 48,
  minScore = 1,
  maxCommentsPerPost = 50,
  mods = [],
  bots = DEFAULT_BOTS,
  contacted = new Set(),
  excludeNames = [],
} = {}) {
  const candidates = [];
  const addedAuthors = new Set(); // 跨帖全局去重
  let excludedCount = 0;

  for (const post of posts || []) {
    const tree = (commentsByPost && commentsByPost[post.id]) || [];
    const flat = flattenComments(tree);
    const recent = filterCommentsByRecency(flat, { commentHours, minScore });
    const sliced = recent.slice(0, maxCommentsPerPost);
    const postAuthor = String(post.author || '').trim();

    for (const comment of sliced) {
      const name = String(comment.author || '').trim();
      if (isExcludedAuthor(name, {
        op: postAuthor ? [postAuthor] : [],
        mods,
        bots,
        contacted,
        excludeNames,
      })) {
        excludedCount += 1;
        continue;
      }
      const key = name.toLowerCase();
      if (addedAuthors.has(key)) {
        excludedCount += 1; // 跨帖重复作者只保留首个帖子的一条
        continue;
      }
      addedAuthors.add(key);
      candidates.push({
        username: name,
        postId: String(post.id || ''),
        postTitle: String(post.title || '').trim(),
        postUrl: post.permalink
          ? `https://www.reddit.com${post.permalink}`
          : `https://www.reddit.com/comments/${post.id}/`,
        commentSnippet: String(comment.body || '').slice(0, 300),
        commentScore: comment.score,
        commentCreatedUtc: comment.createdUtc,
        reason: 'commented_on_target_post',
      });
    }
  }
  return { candidates, excludedCount };
}

// ==================== 浏览器层（需 AdsPower 登录态） ====================

/**
 * 拉取社区最近帖子（new 排序）。在页面上下文中 fetch .json 端点，
 * 复用已登录 cookie（与 engine healthcheck 的 fetchMeJson 同思路）。
 * @param {object} page Playwright page
 * @param {string} sub 社区名（不含 r/）
 * @param {{maxPosts?: number}} [opts]
 * @returns {Promise<{ok: boolean, status?: number, posts: Array<object>}>}
 */
async function fetchSubredditPosts(page, sub, { maxPosts = 100 } = {}) {
  const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/new.json?limit=${maxPosts}&raw_json=1`;
  return page.evaluate(async (targetUrl) => {
    const res = await fetch(targetUrl, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return { ok: false, status: res.status, posts: [] };
    const data = await res.json();
    const children = data?.data?.children || [];
    const posts = [];
    for (const child of children) {
      const d = child && child.data;
      if (!d || child.kind !== 't3') continue;
      posts.push({
        id: String(d.id || ''),
        title: String(d.title || ''),
        author: String(d.author || ''),
        permalink: String(d.permalink || ''),
        stickied: Boolean(d.stickied),
        createdUtc: typeof d.created_utc === 'number' ? d.created_utc : null,
        score: typeof d.score === 'number' ? d.score : null,
        numComments: typeof d.num_comments === 'number' ? d.num_comments : 0,
      });
    }
    return { ok: true, status: res.status, posts };
  }, url);
}

/**
 * 拉取单个帖子的评论树（紧凑结构：author/body/score/createdUtc/replies）。
 * @param {object} page Playwright page
 * @param {string} postId 帖子 id
 * @param {{commentLimit?: number}} [opts]
 * @returns {Promise<{ok: boolean, status?: number, children: Array<object>}>}
 */
async function fetchPostComments(page, postId, { commentLimit = 200 } = {}) {
  const url = `https://www.reddit.com/comments/${encodeURIComponent(postId)}.json?limit=${commentLimit}&raw_json=1&sort=new`;
  return page.evaluate(async (targetUrl) => {
    const res = await fetch(targetUrl, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return { ok: false, status: res.status, children: [] };
    const data = await res.json();
    const listing = Array.isArray(data) && data[1] ? data[1] : data;
    const children = (listing && listing.data && listing.data.children) || [];

    // 递归紧凑化：只保留需要字段，replies 可能是对象或空字符串
    const compact = (items) => {
      const out = [];
      for (const node of items) {
        if (!node || node.kind !== 't1') continue;
        const d = node.data || {};
        let replies = [];
        const rawReplies = d.replies;
        if (rawReplies && typeof rawReplies === 'object' && Array.isArray(rawReplies.data && rawReplies.data.children)) {
          replies = compact(rawReplies.data.children);
        }
        out.push({
          author: String(d.author || ''),
          body: String(d.body || ''),
          score: typeof d.score === 'number' ? d.score : null,
          createdUtc: typeof d.created_utc === 'number' ? d.created_utc : null,
          replies,
        });
      }
      return out;
    };
    return { ok: true, status: res.status, children: compact(children) };
  }, url);
}

// ---- 状态文件读写（原子写） ----

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/** 读取已处理帖子 id 集合（跨运行去重） */
function loadProcessedPostIds() {
  const state = readJsonFile(PROCESSED_POSTS_FILE, { postIds: [] });
  return new Set(Array.isArray(state.postIds) ? state.postIds.map(String) : []);
}

/** 读取已联系用户集合（大小写不敏感，跨运行去重） */
function loadContactedUsers() {
  const state = readJsonFile(CONTACTED_FILE, { users: [] });
  const users = Array.isArray(state.users) ? state.users : [];
  return new Set(users.map((u) => String(u).toLowerCase()));
}

/** 记录已处理帖子 id（发现成功后调用） */
function recordProcessedPostIds(postIds) {
  const state = readJsonFile(PROCESSED_POSTS_FILE, { postIds: [] });
  const merged = new Set([...(Array.isArray(state.postIds) ? state.postIds : []), ...postIds]);
  writeJsonFile(PROCESSED_POSTS_FILE, { schemaVersion: 1, postIds: [...merged] });
}

/** 记录已联系用户（发送成功后调用） */
function recordContactedUsers(users) {
  const state = readJsonFile(CONTACTED_FILE, { users: [] });
  const merged = new Set([...(Array.isArray(state.users) ? state.users : []), ...users.map((u) => String(u))]);
  writeJsonFile(CONTACTED_FILE, { schemaVersion: 1, users: [...merged] });
}

/**
 * 完整发现流程：给定 page 与配置，产出候选列表。
 * @param {object} page Playwright page（已登录 Reddit）
 * @param {object} cfg 发现配置
 * @param {string} cfg.sub 社区名
 * @param {Array<string>} cfg.keywords 标题关键词
 * @param {object} [cfg.opts] discover 选项（commentHours/minScore/maxCommentsPerPost/maxPosts/mods/bots/excludeNames）
 * @returns {Promise<{ok, sub, keywords, postsScanned, matchedPosts, skippedPosts, candidates, excludedCount}>}
 */
async function runDiscover(page, cfg) {
  const sub = String(cfg.sub || '').trim().replace(/^r\//i, '');
  if (!sub) throw new Error('sub 社区名不能为空');
  const keywords = normalizeKeywords(cfg.keywords);
  if (!keywords.length) throw new Error('keywords 至少需要一个关键词');

  const opts = cfg.opts || {};
  const seenPostIds = loadProcessedPostIds();
  const contacted = loadContactedUsers();

  const { ok, status, posts } = await fetchSubredditPosts(page, sub, { maxPosts: opts.maxPosts || 100 });
  if (!ok) {
    return { ok: false, status, sub, keywords, reason: `subreddit_posts_fetch_failed (HTTP ${status})` };
  }

  const { matched, skipped } = filterPostsByKeywords(posts, keywords, seenPostIds);

  const commentsByPost = {};
  const errors = [];
  for (const post of matched) {
    const res = await fetchPostComments(page, post.id, { commentLimit: (opts.maxCommentsPerPost || 50) * 4 });
    if (!res.ok) {
      errors.push({ postId: post.id, status: res.status });
      continue;
    }
    commentsByPost[post.id] = res.children;
  }

  const { candidates, excludedCount } = buildCandidates(matched, commentsByPost, {
    commentHours: opts.commentHours || 48,
    minScore: opts.minScore == null ? 1 : opts.minScore,
    maxCommentsPerPost: opts.maxCommentsPerPost || 50,
    mods: opts.mods || [],
    bots: opts.bots || DEFAULT_BOTS,
    contacted,
    excludeNames: opts.excludeNames || [],
  });

  return {
    ok: true,
    status,
    sub,
    keywords,
    postsScanned: posts.length,
    matchedPosts: matched, // 数组：命中帖子的完整记录（含 id/title/permalink）
    matchedCount: matched.length,
    skippedPosts: skipped,
    errors,
    candidates,
    excludedCount,
  };
}

// ==================== CLI 入口 ====================

const { loadAdsModules } = require(path.join(ENGINE_ROOT, 'lib', 'resolve-ads'));

function parseArgs(argv) {
  const options = { config: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config') options.config = argv[i + 1];
  }
  return options;
}

function emitJson(payload) {
  // server.js 通过 @@OUTREACH_JSON@@ 前缀识别结构结果并自动入队
  process.stdout.write(`@@OUTREACH_JSON@@${JSON.stringify(payload)}\n`);
}

async function main() {
  const { config: configPath } = parseArgs(process.argv.slice(2));
  if (!configPath) {
    console.error('用法: node lib/outreach/discover.js --config <config.json>');
    process.exit(2);
  }
  const cfg = readJsonFile(configPath, null);
  if (!cfg || !cfg.sub || !cfg.keywords) {
    console.error('config 必须包含 sub 与 keywords');
    process.exit(2);
  }
  if (!cfg.target) {
    console.error('config 必须包含 target（AdsPower 目标）');
    process.exit(2);
  }

  const { machineManager } = loadAdsModules();
  const { MachineManager } = machineManager;
  const manager = new MachineManager({ concurrency: 1, stopStartedProfiles: true });
  try {
    const profiles = await manager.resolveProfiles(targetQuery(cfg.target));
    if (!profiles.length) throw new Error('没有匹配的 AdsPower profile');
    const machine = await manager.connectMachine(profiles[0].id);
    const page = await manager.getMainPage(machine);
    // 先落到 Reddit 域，再使用相对 fetch 统一由页面上下文发请求
    await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 120000 });

    const result = await runDiscover(page, cfg);
    if (result.ok) {
      recordProcessedPostIds(result.matchedPosts.map((p) => p.id));
    }
    emitJson({ ...result, profile: { serial: profiles[0].serial, id: profiles[0].id, name: profiles[0].name } });
  } finally {
    await manager.closeAll().catch(() => {});
  }
}

/** 与 lib/runner.js targetQuery 相同语义的本地实现（避免循环依赖） */
function targetQuery(target) {
  if (target.type === 'serial') return { serialNumbers: String(target.value).split(',').map((s) => s.trim()).filter(Boolean) };
  if (target.type === 'profiles') return { profileIds: String(target.value).split(',').map((s) => s.trim()).filter(Boolean) };
  return { groupName: String(target.value).trim() };
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[discover] 失败: ${error.message}`);
    emitJson({ ok: false, error: error.message });
    process.exitCode = 1;
  });
}

module.exports = {
  normalizeKeywords,
  titleMatchesKeywords,
  filterPostsByKeywords,
  flattenComments,
  filterCommentsByRecency,
  isExcludedAuthor,
  dedupeAuthors,
  buildCandidates,
  fetchSubredditPosts,
  fetchPostComments,
  runDiscover,
  loadProcessedPostIds,
  loadContactedUsers,
  recordProcessedPostIds,
  recordContactedUsers,
  PROCESSED_POSTS_FILE,
  CONTACTED_FILE,
  DEFAULT_BOTS,
  BOT_NAME_PATTERN,
};