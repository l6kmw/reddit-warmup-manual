'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { writeMdReport } = require('./md-report');
const { loadAdsModules } = require('./resolve-ads');

// 网络波动容错: 统一走 pageActions.goto (超时自动重试)
const gotoPage = (page, url, options = {}) => loadAdsModules().pageActions.goto(page, url, options);

const REPORT_DIR = path.join(__dirname, '..', 'reports', 'community-rules');
const ACTIONS = new Set(['comment', 'post']);

const CATEGORY_DEFINITIONS = [
  { category: 'affiliate_referral', pattern: /affiliate|referral|ref(?:erral)?\s+(?:code|link)|associate(?:s)?\s+link|佣金|返利|推广码/i },
  { category: 'self_promotion', pattern: /self[ -]?promo|promot(?:e|ion|ional)|advertis(?:e|ing)|spam|own\s+(?:site|blog|channel|business|store)|自我推广|营销|广告|引流/i },
  { category: 'commerce_solicitation', pattern: /buy(?:ing)?|sell(?:ing)?|sale|solicit|vendor|service(?:s)?\s+(?:offer|listing)|marketplace|交易|买卖|招揽|接单/i },
  { category: 'hiring', pattern: /hiring|hire|job(?:s)?|recruit|employment|freelanc|招聘|求职|招人/i },
  { category: 'survey', pattern: /survey|questionnaire|research\s+(?:study|participant)|poll\b|调查|问卷|受访/i },
  { category: 'giveaway', pattern: /giveaway|contest|sweepstake|raffle|prize|赠品|抽奖| giveaway/i },
  { category: 'offsite_contact', pattern: /(?:send|contact|message)\s+(?:me|us)|direct\s+message|\bdm\b|\bpm\b|discord|telegram|whatsapp|email\s+me|私信|站外联系|加我/i },
  { category: 'personal_info', pattern: /personal\s+(?:info|information|data)|doxx|phone\s+number|email\s+address|real\s+name|(?:home|physical|mailing|street)\s+address|个人信息|隐私|人肉|家庭住址/i },
  { category: 'low_quality_duplicate', pattern: /low[ -]?quality|duplicate|repost|repeat(?:ed|itive)|effort|short\s+post|one[ -]?liner|低质量|重复内容|水帖/i },
  { category: 'title_format', pattern: /title|headline|标题|题目格式/i },
  { category: 'flair', pattern: /flair|标签/i },
  { category: 'ai_content', pattern: /\bai\b|artificial\s+intelligence|chatgpt|generated\s+(?:content|text)|机器生成|人工智能|AI 内容/i },
  { category: 'links', pattern: /\blink(?:s|ing)?\b|url|website|external\s+(?:site|link)|domain|外链|链接|网址/i },
];

const PROHIBITION = /\b(?:no|not\s+allowed|not\s+permitted|not\s+welcome|not\s+tolerated|prohibited|forbidden|do\s+not|don't|must\s+not|may\s+not|banned|(?:are|is|be|will\s+be)\s+removed|isn't\s+allowed|aren't\s+allowed)\b|禁止|不得|不允许|严禁|请勿/i;
const REQUIREMENT = /\b(?:must|required|requirement|need(?:s|ed)?\s+to|have\s+to)\b|必须|需要|务必/i;
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>()]+|\b[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.(?:com|net|org|io|co|ai|app|dev|shop|store|me|ly)(?:\/[^\s<>()]*)?/ig;

function cleanText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function shortHash(value, length = 16) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function normalizeKind(kind) {
  const value = cleanText(kind).toLowerCase();
  if (value === 'comment') return 'comment';
  if (value === 'link' || value === 'post') return 'post';
  return 'all';
}

function classifyRuleText(text) {
  const categories = CATEGORY_DEFINITIONS.filter((item) => item.pattern.test(text)).map((item) => item.category);
  const mode = PROHIBITION.test(text) ? 'prohibit' : REQUIREMENT.test(text) ? 'require' : 'unknown';
  return { categories: [...new Set(categories)].sort(), mode };
}

function unresolvedRuleClauses(title, description) {
  const chunks = cleanText(description).split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z“"'])/).map(cleanText).filter(Boolean);
  if (!chunks.length) chunks.push(cleanText(title));
  const enforcementOnly = /^(?:violations?|users? who violate|breaking this rule).*(?:ban|remove)|^(?:this|these).*(?:strictly enforced)|^(?:requesting )?(?:exceptions|appeals)|^no exceptions/i;
  return chunks.filter((chunk) => {
    if (chunk.length < 12 || enforcementOnly.test(chunk)) return false;
    const classification = classifyRuleText(chunk);
    return classification.categories.length === 0 && (classification.mode !== 'unknown' || chunk.length >= 24);
  }).map((text, index) => ({ id: `clause-${shortHash(`${index}:${text}`, 10)}`, text }));
}

function normalizeRule(raw = {}, index = 0) {
  const title = cleanText(raw.short_name ?? raw.title ?? raw.name ?? `Rule ${index + 1}`);
  const description = cleanText(raw.description ?? raw.violation_reason ?? raw.body ?? '');
  const kind = normalizeKind(raw.kind ?? raw.appliesTo ?? raw.applicability);
  const priorityValue = Number(raw.priority ?? index);
  const priority = Number.isFinite(priorityValue) ? priorityValue : index;
  const classification = classifyRuleText(`${title}\n${description}`);
  const unresolvedClauses = unresolvedRuleClauses(title, description);
  const identity = stableStringify({ title, description, kind, priority });
  return {
    id: `rule-${shortHash(identity, 12)}`,
    title,
    description,
    kind,
    priority,
    applicability: kind === 'all' ? ['comment', 'post'] : [kind],
    categories: classification.categories,
    mode: classification.mode,
    unresolvedClauses,
  };
}

function canonicalRules(rules) {
  return rules.map((rule, index) => normalizeRule(rule, index)).sort((a, b) =>
    a.priority - b.priority || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

function computeRulesHash(subreddit, rules) {
  const canonical = canonicalRules(rules).map(({ id, ...rule }) => rule);
  return crypto.createHash('sha256')
    .update(stableStringify({ subreddit: cleanText(subreddit).toLowerCase(), rules: canonical }))
    .digest('hex');
}

function createRulesSnapshot({ subreddit, source, fetchedAt = new Date().toISOString(), rules }) {
  const normalized = canonicalRules(Array.isArray(rules) ? rules : []);
  return {
    schemaVersion: 1,
    subreddit: cleanText(subreddit),
    source: cleanText(source),
    fetchedAt,
    hash: computeRulesHash(subreddit, normalized),
    rules: normalized,
  };
}

function validateSnapshot(snapshot) {
  if (!snapshot || !snapshot.subreddit || !Array.isArray(snapshot.rules) || !snapshot.hash) {
    return { ok: false, reason: '规则快照缺少 subreddit、rules 或 hash' };
  }
  const actual = computeRulesHash(snapshot.subreddit, snapshot.rules);
  if (actual !== snapshot.hash) return { ok: false, reason: `规则快照 hash 校验失败: expected ${snapshot.hash}, actual ${actual}` };
  return { ok: true, actual };
}

function extractSignals(input = {}) {
  const title = cleanText(input.title);
  const text = cleanText(input.text);
  const link = cleanText(input.link);
  const combined = `${title}\n${text}\n${link}`;
  const urls = [...new Set([...(combined.match(URL_PATTERN) || []), ...(link ? [link] : [])])];
  return {
    links: urls,
    self_promotion: /\b(?:my|our)\s+(?:product|service|store|shop|site|website|app|course|channel|newsletter|business)\b|check\s+out\s+(?:my|our)|promo(?:tional)?\s+code|我的(?:产品|服务|店铺|网站|课程)|欢迎购买|限时优惠/i.test(combined),
    affiliate_referral: /affiliate|referral|ref(?:erral)?\s+(?:code|link)|use\s+(?:my\s+)?code|associate(?:s)?\s+link|返利|推广码|邀请码/i.test(combined),
    commerce_solicitation: /\b(?:for\s+sale|buy\s+now|selling|taking\s+orders|hire\s+me|paid\s+service|book\s+a\s+call)\b|出售|购买|接单|付费服务|报价/i.test(combined),
    hiring: /\b(?:we(?:'re|\s+are)?\s+hiring|job\s+opening|apply\s+(?:here|now)|looking\s+to\s+hire|vacancy)\b|招聘|招人|投简历|职位/i.test(combined),
    survey: /\b(?:survey|questionnaire|research\s+participants?|fill\s+out\s+(?:this|our))\b|调查问卷|填写问卷|招募受访者/i.test(combined),
    giveaway: /\b(?:giveaway|sweepstakes?|raffle|win\s+(?:a|free)|free\s+prize)\b|赠品|抽奖|免费领取/i.test(combined),
    offsite_contact: /\b(?:dm|pm|message|email)\s+(?:me|us)\b|discord|telegram|whatsapp|私信我|加我|站外联系/i.test(combined),
    personal_info: /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|\+?\d[\d\s().-]{8,}\d|\b(?:my|their)\s+(?:phone|address|email|real\s+name)\b|手机号|身份证|家庭住址|邮箱(?:是|：|:)/i.test(combined),
    low_quality_duplicate: cleanText(text).length < (input.action === 'post' ? 100 : 30) || /(.{12,})\1{2,}/s.test(text),
    ai_content: input.aiDetected === true || /\b(?:generated\s+by\s+(?:ai|chatgpt)|as\s+an\s+ai)\b|由\s*AI\s*生成/i.test(combined),
  };
}

function contentViolation(rule, signals, input) {
  if (rule.mode !== 'prohibit') return null;
  for (const category of rule.categories) {
    if (category === 'links' && signals.links.length) return { category, evidence: signals.links };
    if (signals[category] === true) return { category, evidence: true };
  }
  return null;
}

function requirementViolation(rule, input) {
  if (rule.mode !== 'require') return null;
  if (rule.categories.includes('flair') && !cleanText(input.flair)) {
    return { category: 'flair', evidence: 'missing' };
  }
  if (rule.categories.includes('title_format')) {
    const ruleText = `${rule.title}\n${rule.description}`;
    const title = cleanText(input.title);
    if (/title.*(?:must|required).*(?:question|\?)/i.test(ruleText) && !/[?？]$/.test(title)) {
      return { category: 'title_format', evidence: 'title_must_be_question' };
    }
    const prefix = ruleText.match(/(?:title.*(?:must|required).*(?:start|begin|prefix)[^\[]*)\[([^\]]{1,32})\]/i);
    if (prefix && !title.toLowerCase().startsWith(`[${prefix[1]}]`.toLowerCase())) {
      return { category: 'title_format', evidence: `missing_prefix:[${prefix[1]}]` };
    }
  }
  return null;
}

function titleProhibitionViolation(rule, input) {
  if (rule.mode !== 'prohibit' || !rule.categories.includes('title_format')) return null;
  const ruleText = `${rule.title}\n${rule.description}`;
  const title = cleanText(input.title);
  if (/no\s+(?:all[ -]?)?caps|do\s+not.*all[ -]?caps|禁止.*全大写/i.test(ruleText)) {
    const letters = title.match(/[A-Za-z]/g) || [];
    if (letters.length >= 5 && letters.every((char) => char === char.toUpperCase())) {
      return { category: 'title_format', evidence: 'all_caps' };
    }
  }
  return null;
}

function contextTokens(value) {
  const stop = new Set(['about', 'after', 'again', 'also', 'because', 'been', 'being', 'could', 'does', 'from', 'have', 'into', 'just', 'more', 'only', 'other', 'should', 'some', 'than', 'that', 'their', 'there', 'these', 'they', 'this', 'those', 'very', 'what', 'when', 'where', 'which', 'with', 'would', 'your']);
  return new Set((cleanText(value).toLowerCase().match(/[a-z0-9]{4,}|[\p{Script=Han}]{2,}/gu) || []).filter((token) => !stop.has(token)));
}

function checkCommentContext(input) {
  if (!cleanText(input.postUrl)) return { ok: false, hard: true, reason: '评论必须提供明确 --post-url，禁止盲选帖子' };
  const context = input.postContext || {};
  if (!cleanText(context.title) && !cleanText(context.body)) {
    return { ok: false, hard: true, reason: '无法读取目标帖标题或正文，不能可靠判断评论相关性' };
  }
  const comment = contextTokens(input.text);
  const post = contextTokens(`${context.title}\n${context.body}`);
  const overlap = [...comment].filter((token) => post.has(token));
  if (overlap.length) return { ok: true, overlap };
  return { ok: false, hard: false, reason: '机器未发现评论与目标帖的明确词汇关联，需要逐条人工确认', id: 'context-relevance' };
}

function reviewContent(snapshot, input = {}, confirmation = {}) {
  const action = cleanText(input.action).toLowerCase();
  const invalid = validateSnapshot(snapshot);
  if (!invalid.ok) return blocked('rules_snapshot_invalid', invalid.reason, snapshot, confirmation);
  if (!ACTIONS.has(action)) return blocked('invalid_action', 'action 必须是 comment 或 post', snapshot, confirmation);

  const rules = snapshot.rules.filter((rule) => rule.applicability.includes(action));
  const signals = extractSignals({ ...input, action });
  const hits = [];
  const unresolved = [];

  for (const rule of rules) {
    const violation = contentViolation(rule, signals, input) || requirementViolation(rule, input) || titleProhibitionViolation(rule, input);
    if (violation) {
      hits.push({ ruleId: rule.id, title: rule.title, category: violation.category, evidence: violation.evidence });
      continue;
    }
    const deterministicallyChecked = rule.categories.some((category) => {
      if (category === 'links') return true;
      if (category === 'flair') return rule.mode === 'require';
      if (category === 'title_format') {
        const ruleText = `${rule.title}\n${rule.description}`;
        return /title.*(?:question|\?|start|begin|prefix)|(?:all[ -]?)?caps|标题.*(?:问句|开头|前缀|全大写)/i.test(ruleText);
      }
      return Object.prototype.hasOwnProperty.call(signals, category);
    });
    if (!(rule.unresolvedClauses || []).length && (rule.mode === 'unknown' || !rule.categories.length || !deterministicallyChecked ||
        (rule.mode === 'require' && !rule.categories.includes('flair')))) {
      unresolved.push({ id: rule.id, ruleId: rule.id, title: rule.title, reason: '规则可能影响该动作，但机器无法可靠判定' });
    }
    for (const clause of rule.unresolvedClauses || []) {
      unresolved.push({
        id: `${rule.id}:${clause.id}`,
        ruleId: rule.id,
        title: rule.title,
        reason: `未决子句: ${clause.text}`,
      });
    }
  }

  if (action === 'comment') {
    const relevance = checkCommentContext(input);
    if (!relevance.ok && relevance.hard) hits.push({ ruleId: 'context', title: '目标帖上下文', category: 'comment_context', evidence: relevance.reason });
    else if (!relevance.ok) unresolved.push({ id: relevance.id, ruleId: 'context', title: '评论相关性', reason: relevance.reason });
  }

  const confirmed = new Set((confirmation.confirmedUnresolved || []).map(String));
  const unconfirmed = unresolved.filter((item) => !confirmed.has(item.id));
  if (hits.length) {
    return verdict(false, 'rules_violation', `内容命中 ${hits.length} 条社区规则或上下文硬门槛`, snapshot, hits, unresolved, confirmation, unconfirmed, signals);
  }
  if (confirmation.rulesAck !== snapshot.hash) {
    const reason = confirmation.rulesAck
      ? `规则已变化或 ack 过期: expected ${snapshot.hash}, received ${confirmation.rulesAck}`
      : `缺少当前规则确认: 请提供 --rules-ack ${snapshot.hash}`;
    return verdict(false, 'rules_ack_mismatch', reason, snapshot, hits, unresolved, confirmation, unconfirmed, signals);
  }
  if (unconfirmed.length) {
    return verdict(false, 'rules_unresolved', `仍有 ${unconfirmed.length} 条未决规则/上下文未逐条确认`, snapshot, hits, unresolved, confirmation, unconfirmed, signals);
  }
  return verdict(true, 'rules_allowed', '当前规则 hash 已确认，明确限制均通过，未决项均已逐条确认', snapshot, hits, unresolved, confirmation, [], signals);
}

function verdict(allowed, gate, reason, snapshot, hits, unresolved, confirmation, unconfirmed, signals) {
  return {
    allowed,
    gate,
    reason,
    rules: {
      subreddit: snapshot?.subreddit ?? null,
      source: snapshot?.source ?? null,
      fetchedAt: snapshot?.fetchedAt ?? null,
      hash: snapshot?.hash ?? null,
      summary: (snapshot?.rules || []).map((rule) => ({ id: rule.id, title: rule.title, kind: rule.kind, categories: rule.categories, mode: rule.mode })),
    },
    hits,
    unresolved,
    confirmations: {
      rulesAck: confirmation.rulesAck || null,
      hashMatches: confirmation.rulesAck === snapshot?.hash,
      confirmedUnresolved: [...new Set((confirmation.confirmedUnresolved || []).map(String))].sort(),
      unconfirmed: unconfirmed.map((item) => item.id),
    },
    signals,
  };
}

function blocked(gate, reason, snapshot, confirmation = {}) {
  return verdict(false, gate, reason, snapshot || {}, [], [], confirmation, [], {});
}

async function fetchCommunityRules(page, subreddit, { now = () => new Date().toISOString() } = {}) {
  const sub = cleanText(subreddit).replace(/^r\//i, '');
  if (!/^[A-Za-z0-9_]{2,21}$/.test(sub)) throw new Error(`无效 subreddit: ${subreddit}`);
  const base = `https://www.reddit.com/r/${encodeURIComponent(sub)}/about/rules`;
  const currentUrl = typeof page.url === 'function' ? page.url() : '';
  if (!/^https:\/\/(?:www\.|old\.)?reddit\.com\//i.test(currentUrl)) {
    await gotoPage(page, base, { timeout: 120000 });
  }

  const attempts = [];
  try {
    const response = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
        return { ok: res.ok, status: res.status, text: await res.text() };
      } catch (error) {
        return { ok: false, status: 0, error: error?.message || String(error), text: '' };
      }
    }, `https://www.reddit.com/r/${encodeURIComponent(sub)}/about/rules.json`);
    attempts.push({ source: 'about/rules.json', status: response.status });
    if (response.ok) {
      const payload = JSON.parse(response.text);
      if (!Array.isArray(payload.rules)) throw new Error('JSON 响应缺少 rules 数组');
      return createRulesSnapshot({ subreddit: sub, source: 'reddit-same-origin:/about/rules.json', fetchedAt: now(), rules: payload.rules });
    }
  } catch (error) {
    attempts.push({ source: 'about/rules.json', error: cleanText(error.message).slice(0, 160) });
  }

  try {
    await gotoPage(page, base, { timeout: 120000 });
    await page.waitForTimeout(1500);
    const extracted = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const candidates = [...document.querySelectorAll('[data-testid*="rule" i], shreddit-community-rule, section, article, li')];
      const rules = [];
      for (const el of candidates) {
        const titleEl = el.querySelector('h1,h2,h3,h4,h5,h6,strong,[slot="title"]');
        const title = clean(titleEl?.textContent);
        const body = clean(el.textContent);
        if (!title || body.length < title.length || body.length > 5000) continue;
        const description = clean(body.slice(title.length));
        if (!description && title.length < 4) continue;
        rules.push({ short_name: title, description, kind: 'all', priority: rules.length });
      }
      const unique = [];
      const seen = new Set();
      for (const rule of rules) {
        const key = `${rule.short_name}\n${rule.description}`.toLowerCase();
        if (!seen.has(key)) { seen.add(key); unique.push(rule); }
      }
      return unique;
    });
    attempts.push({ source: 'about/rules-page', count: extracted.length });
    if (extracted.length) {
      return createRulesSnapshot({ subreddit: sub, source: 'reddit-page:/about/rules', fetchedAt: now(), rules: extracted });
    }
  } catch (error) {
    attempts.push({ source: 'about/rules-page', error: cleanText(error.message).slice(0, 160) });
  }
  const error = new Error(`无法获取 r/${sub} 当前社区规则，已 fail closed`);
  error.code = 'RULES_FETCH_FAILED';
  error.attempts = attempts;
  throw error;
}

async function readPostContext(page, postUrl, expectedSubreddit) {
  let parsed;
  try { parsed = new URL(postUrl); } catch { throw new Error('无效 --post-url'); }
  if (!/(^|\.)reddit\.com$/i.test(parsed.hostname) || !/\/r\/[^/]+\/comments\//i.test(parsed.pathname)) {
    throw new Error('--post-url 必须是 reddit.com 的明确帖子 URL');
  }
  const match = parsed.pathname.match(/\/r\/([^/]+)\/comments\//i);
  if (expectedSubreddit && match && match[1].toLowerCase() !== cleanText(expectedSubreddit).toLowerCase()) {
    throw new Error(`帖子属于 r/${match[1]}，与 --sub ${expectedSubreddit} 不一致`);
  }
  await gotoPage(page, parsed.href, { timeout: 120000 });
  await page.waitForTimeout(1500);
  const context = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const post = document.querySelector('shreddit-post');
    const title = clean(post?.getAttribute('post-title')) || clean(document.querySelector('h1')?.textContent) || clean(document.querySelector('meta[property="og:title"]')?.content);
    const body = clean(post?.querySelector('[slot="text-body"]')?.textContent) || clean(document.querySelector('[data-post-click-location="text-body"]')?.textContent) || clean(document.querySelector('meta[property="og:description"]')?.content);
    return { title, body };
  });
  if (!context.title && !context.body) throw new Error('无法读取目标帖标题或正文');
  return { url: parsed.href, ...context };
}

function snapshotMarkdown(snapshot) {
  const lines = [
    `# r/${snapshot.subreddit} 社区规则快照`, '',
    `- 来源: ${snapshot.source}`, `- 抓取时间: ${snapshot.fetchedAt}`, `- Hash: \`${snapshot.hash}\``,
    `- 规则数: ${snapshot.rules.length}`, '', '## 规则摘要', '',
  ];
  if (!snapshot.rules.length) lines.push('- （该端点返回空规则列表）');
  for (const rule of snapshot.rules) {
    lines.push(`- ${rule.priority}. **${rule.title}** [${rule.kind}; ${rule.mode}; ${rule.categories.join(', ') || 'unclassified'}]`);
    if (rule.description) lines.push(`  ${rule.description}`);
  }
  lines.push('');
  return lines.join('\n');
}

function writeRulesSnapshot(snapshot, reportDir = REPORT_DIR) {
  fs.mkdirSync(reportDir, { recursive: true });
  const safeSub = snapshot.subreddit.replace(/[^A-Za-z0-9_-]/g, '_');
  const file = path.join(reportDir, `${safeSub}-${snapshot.hash.slice(0, 16)}.json`);
  fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  writeMdReport(file, snapshotMarkdown(snapshot));
  return file;
}

function reviewMarkdown(review, input = {}) {
  const lines = [
    `# 社区规则预审`, '', `- 结果: ${review.allowed ? 'ALLOW' : 'REJECT'}`, `- 门控: ${review.gate}`,
    `- 原因: ${review.reason}`, `- 动作: ${input.action || '-'}`, `- 社区: r/${review.rules.subreddit || '-'}`,
    `- 规则来源: ${review.rules.source || '-'}`, `- 抓取时间: ${review.rules.fetchedAt || '-'}`,
    `- 规则 Hash: \`${review.rules.hash || '-'}\``, `- Ack 匹配: ${review.confirmations.hashMatches ? '是' : '否'}`,
    '', '## 命中项', '',
  ];
  if (!review.hits.length) lines.push('- （无）');
  for (const hit of review.hits) lines.push(`- ${hit.ruleId} ${hit.title}: ${hit.category}`);
  lines.push('', '## 未决项', '');
  if (!review.unresolved.length) lines.push('- （无）');
  for (const item of review.unresolved) lines.push(`- ${item.id} ${item.title}: ${item.reason}${review.confirmations.confirmedUnresolved.includes(item.id) ? '（已确认）' : '（未确认）'}`);
  lines.push('');
  return lines.join('\n');
}

function writeRulesReview(review, input = {}, reportDir = REPORT_DIR) {
  fs.mkdirSync(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.T]/g, '-').replace(/Z$/, '');
  const action = ACTIONS.has(input.action) ? input.action : 'unknown';
  const file = path.join(reportDir, `preflight-${action}-${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ task: 'reddit-community-rules-preflight', at: new Date().toISOString(), input: {
    action, subreddit: review.rules.subreddit, postUrl: input.postUrl || null, title: input.title || null,
    flair: input.flair || null, hasLink: Boolean(input.link || (cleanText(input.text).match(URL_PATTERN) || []).length),
  }, ...review }, null, 2)}\n`);
  writeMdReport(file, reviewMarkdown(review, input));
  return file;
}

module.exports = {
  CATEGORY_DEFINITIONS,
  cleanText,
  stableStringify,
  normalizeRule,
  canonicalRules,
  computeRulesHash,
  createRulesSnapshot,
  validateSnapshot,
  extractSignals,
  checkCommentContext,
  reviewContent,
  fetchCommunityRules,
  readPostContext,
  writeRulesSnapshot,
  writeRulesReview,
  snapshotMarkdown,
  reviewMarkdown,
};
