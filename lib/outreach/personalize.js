'use strict';
/**
 * personalize.js — 触达消息去模板化（个性化初信生成）
 *
 * 问题：queue 入队时用同一 template 渲染所有 draft（只换 {username} 等占位符），
 *       大量用户收到相同句式 → Reddit 内容指纹命中 spam（与 34/35 号机被标记相关）。
 * 方案：发送前（sender 懒个性化）或批量重写（CLI）用 LLM 基于帖子/评论内容生成
 *       个性化初信；LLM 不可用或校验失败 → 回退原草稿（绝不阻塞发送流程）。
 *
 * 纯函数（可单测）：
 *   buildPersonalizePrompt(item)                       -> string
 *   validatePersonalized(text, {username})             -> {ok, errors}
 *   maybePersonalize(draft, provider, item)            -> {ok, draft?, error?, kept}
 *   isPersonalized(item)                               -> boolean
 *
 * CLI（批量重写队列既有模板草稿）：
 *   node lib/outreach/personalize.js --config <cfg> [--apply] [--limit N]
 *   默认 dry-run：只打印将重写的样本，不落盘；--apply 才写回队列。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const aiProvider = require('./ai-provider');

const STATE_DIR = process.env.OUTREACH_STATE_DIR || path.join(ROOT, 'state');
const QUEUE_FILE = path.join(STATE_DIR, 'outreach-queue.json');

const MIN_WORDS = 15;
const MAX_WORDS = 90;

/** 命中即视为“模板感/营销感”的禁用标记（可被『saw your comment』这类高频模板句命中） */
const BANNED_MARKERS = [
  'saw your comment',
  'saw your post',
  'hope this finds',
  'hope you are doing well',
  'hoping this reaches',
  'automation',
  'automated',
  'bot account',
  'i am an ai',
  'came across your',
  'just wanted to reach out',
];

// ==================== 纯函数 ====================

/**
 * 构造个性化生成提示：给 LLM 帖子/评论上下文 + 明确的“去模板”约束。
 * @param {object} item 队列条目（username/postTitle/commentSnippet/sub）
 * @returns {string}
 */
function buildPersonalizePrompt(item) {
  const i = item || {};
  return [
    'Write a short, natural Reddit private message to start a genuine conversation with a real redditor.',
    '',
    `Their username: ${String(i.username || '').trim()}`,
    `Subreddit: r/${String(i.sub || '').trim()}`,
    `Their post title: "${String(i.postTitle || '').trim()}"`,
    `Their comment on that post: "${String(i.commentSnippet || '').trim()}"`,
    '',
    'Requirements:',
    '1. Reference one specific detail from their comment or post so it reads like you actually read it.',
    '2. Sound like a real person: casual, specific, varied. NOT a marketing template.',
    '3. Avoid clichés and templated openings (no "saw your comment", no "I hope this finds you well", no "Hi, my name is...").',
    '4. Never mention automation, bots, ads, marketing, or self-promotion.',
    `5. Keep it ${MIN_WORDS}-${MAX_WORDS} words, one short message. End with a simple open question.`,
    '',
    'Output the message text only. No quotes, no preamble, no signature.',
  ].join('\n');
}

/** 统计英文词数（按空白切分）。 */
function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * 校验个性化产出：空 / 占位符残留 / 模板标记 / 长度越界。
 * @param {string} text LLM 产出
 * @param {{username?: string}} [opts]
 * @returns {{ok: boolean, errors: Array<string>}}
 */
function validatePersonalized(text, { username = '' } = {}) {
  const errors = [];
  const t = String(text || '').trim();
  if (!t) {
    errors.push('empty');
    return { ok: false, errors };
  }
  if (/\{[^}]*\}/.test(t)) errors.push('leftover_placeholder');
  if (/[<>\n]{2,}/.test(t)) errors.push('suspicious_linebreaks');
  const lc = t.toLowerCase();
  for (const marker of BANNED_MARKERS) {
    if (lc.includes(marker)) {
      errors.push(`banned_marker:${marker}`);
      break;
    }
  }
  const words = countWords(t);
  if (words < MIN_WORDS) errors.push(`too_short:${words}w`);
  if (words > MAX_WORDS) errors.push(`too_long:${words}w`);
  return { ok: errors.length === 0, errors };
}

/** 该条目是否已个性化（personalizedAt 已打点）。 */
function isPersonalized(item) {
  return Boolean(item && item.personalizedAt);
}

/**
 * 对单条草稿做 LLM 个性化；任何失败都保留原稿（kept=true），不阻塞流程。
 * @param {string} draft 原草稿（模板）
 * @param {object} provider AI provider（需提供 completeText；mock 会自动走 kept 分支）
 * @param {object} item 队列条目
 * @returns {Promise<{ok: boolean, draft?: string, kept?: boolean, error?: string}>}
 */
async function maybePersonalize(draft, provider, item) {
  if (!provider || typeof provider.completeText !== 'function') {
    return { ok: false, kept: true, error: 'provider_not_supported' };
  }
  const original = String(draft || '').trim();
  if (!original) return { ok: false, kept: true, error: 'empty_draft' };
  const res = await provider.completeText({
    system: 'You are a helpful assistant who writes natural, human-sounding Reddit messages.',
    user: buildPersonalizePrompt(item),
    maxTokens: 260,
    temperature: 0.85,
  });
  if (!res.ok) return { ok: false, kept: true, error: res.error };
  const check = validatePersonalized(res.text);
  if (!check.ok) return { ok: false, kept: true, error: `validation:${check.errors.join(',')}`, text: res.text };
  return { ok: true, draft: res.text };
}

// ==================== 队列读写（原子写，与 queue.js 一致） ====================

function readQueue() {
  try {
    return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  } catch {
    return { schemaVersion: 2, items: [] };
  }
}

function writeQueue(data) {
  const tmp = `${QUEUE_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, QUEUE_FILE);
}

/**
 * 批量重写队列 pending 草稿。
 * @param {object} opts
 * @param {object} opts.provider AI provider
 * @param {number} [opts.limit] 最多处理条数（0=不限）
 * @param {boolean} [opts.apply] 是否写回队列（默认 dry-run）
 * @returns {Promise<{ok: true, scanned: number, rewritten: number, kept: number, samples: Array}>}
 */
async function rewriteQueueDrafts({ provider, limit = 0, apply = false } = {}) {
  const queue = readQueue();
  const items = Array.isArray(queue.items) ? queue.items : [];
  const pending = items.filter((i) => i.status === 'pending' && !isPersonalized(i));
  const targets = limit > 0 ? pending.slice(0, limit) : pending;
  const samples = [];
  let rewritten = 0;
  let kept = 0;

  for (const item of targets) {
    const before = String(item.draft || '').trim();
    const result = await maybePersonalize(before, provider, item);
    if (result.ok && result.draft) {
      item.draft = result.draft;
      item.personalizedAt = new Date().toISOString();
      rewritten += 1;
      samples.push({
        username: item.username,
        before: before.slice(0, 80),
        after: result.draft.slice(0, 120),
      });
    } else {
      kept += 1;
      samples.push({ username: item.username, error: result.error, before: before.slice(0, 80) });
    }
  }

  if (apply) writeQueue(queue);
  return { ok: true, scanned: targets.length, rewritten, kept, samples };
}

// ==================== CLI ====================

function parseArgs(argv) {
  const options = { config: null, apply: false, limit: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config') options.config = argv[i + 1];
    else if (argv[i] === '--apply') options.apply = true;
    else if (argv[i] === '--limit') options.limit = Number(argv[i + 1]);
  }
  return options;
}

async function main() {
  const { config: configPath, apply, limit } = parseArgs(process.argv.slice(2));
  if (!configPath) {
    console.error('用法: node lib/outreach/personalize.js --config <cfg.json> [--apply] [--limit N]');
    process.exit(2);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.error(`[personalize] 配置读取失败: ${error.message}`);
    process.exit(2);
  }
  const provider = aiProvider.createProvider(cfg.provider || { type: 'openai' });
  const result = await rewriteQueueDrafts({ provider, limit, apply });
  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    scanned: result.scanned,
    rewritten: result.rewritten,
    kept: result.kept,
    samples: result.samples.slice(0, 5),
  }, null, 2));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`[personalize] 失败: ${e && e.message || e}`);
    process.exit(1);
  });
}

module.exports = {
  buildPersonalizePrompt,
  validatePersonalized,
  isPersonalized,
  maybePersonalize,
  rewriteQueueDrafts,
  MIN_WORDS,
  MAX_WORDS,
  BANNED_MARKERS,
};