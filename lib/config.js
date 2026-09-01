'use strict';
/**
 * config.js — 手动控制版配置校验（server 与 runner 共用）
 *
 * server 在接收 /api/run 时先校验（失败直接 400），
 * runner 启动时再校验一次（最终防线），保证前后端规则一致。
 */

/** 数值钳制校验 */
function num(v, dft, min, max, name) {
  const x = v == null ? dft : Number(v);
  if (!Number.isFinite(x) || x < min || x > max) {
    throw new Error(`${name} 必须是 ${min}-${max} 的数字`);
  }
  return x;
}

/** 字符串列表解析（逗号/换行分隔） */
function strList(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return String(v).split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
}

/** 按社区规范化写操作规则确认。 */
function writeRules(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).map(([sub, rule]) => [String(sub).toLowerCase(), {
    ack: rule && rule.ack ? String(rule.ack).trim() : null,
    confirmedUnresolved: strList(rule && rule.confirmedUnresolved),
    flair: rule && rule.flair ? String(rule.flair).trim() : null,
  }]));
}

/**
 * 社区场景关键词预置（控制台按社区自动推荐，可在控制台覆盖）。
 * 键为社区名（小写，不含 r/），值为推荐标题关键词。
 */
const SUB_KEYWORD_PRESETS = {
  lawncare: ['overseed', 'weed', 'fertilizer', 'sod', 'dethatch'],
  soccer: ['transfer', 'loan', 'bid', 'signed', 'deal'],
  amazonseller: ['fba', 'fees', 'coupon'],
  ecommerce: ['startup', 'store', 'shopify', 'sales'],
};

/**
 * 校验并规范化配置
 * @param {object} cfg 前端提交的原始配置
 * @returns {object} 规范化后的配置
 */
function parseConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('配置必须是 JSON 对象');
  if (!cfg.target || !cfg.target.type || !cfg.target.value) {
    throw new Error('缺少 target（serial/profiles/group 及取值）');
  }
  if (!['serial', 'profiles', 'group'].includes(cfg.target.type)) {
    throw new Error('target.type 必须是 serial / profiles / group');
  }
  const parsed = {
    target: {
      type: cfg.target.type,
      value: String(cfg.target.value).trim(),
    },
    subMode: cfg.subMode === 'random' ? 'random' : 'specified',
    subs: strList(cfg.subs),
    subCount: num(cfg.subCount, 2, 1, 8, 'subCount'),
    minMinutesPerSub: num(cfg.minMinutesPerSub, 2, 1, 180, 'minMinutesPerSub'),
    maxMinutesPerSub: num(cfg.maxMinutesPerSub, 4, 1, 180, 'maxMinutesPerSub'),
    upvoteRatio: num(cfg.upvoteRatio, 0.3, 0, 1, 'upvoteRatio'),
    readRatio: num(cfg.readRatio, 0.6, 0, 1, 'readRatio'),
    commentRatio: num(cfg.commentRatio, 0, 0, 1, 'commentRatio'),
    commentBank: strList(cfg.commentBank),
    commentRules: writeRules(cfg.commentRules),
    post: {
      enabled: Boolean(cfg.post && cfg.post.enabled),
      title: (cfg.post && cfg.post.title && String(cfg.post.title).trim()) || null,
      text: (cfg.post && cfg.post.text && String(cfg.post.text).trim()) || null,
      subs: strList(cfg.post && cfg.post.subs),
      rules: writeRules(cfg.post && cfg.post.rules),
      lookbackDays: num(cfg.post && cfg.post.lookbackDays, 7, 1, 90, 'post.lookbackDays'),
      maxCount: num(cfg.post && cfg.post.maxCount, 2, 1, 30, 'post.maxCount'),
    },
    inputMode: cfg.inputMode === 'legacy' ? 'legacy' : 'wheel',
    voteMode: ['api-only', 'mixed'].includes(cfg.voteMode) ? cfg.voteMode : 'click-first',
    seed: cfg.seed != null && cfg.seed !== '' ? Number(cfg.seed) : null,
    skipTierGate: Boolean(cfg.skipTierGate),
  };

  if (parsed.maxMinutesPerSub < parsed.minMinutesPerSub) {
    throw new Error('maxMinutesPerSub 必须 >= minMinutesPerSub');
  }
  if (parsed.subMode === 'specified' && !parsed.subs.length) {
    throw new Error('subMode=specified 时必须提供 subs 列表');
  }
  if (parsed.commentRatio > 0 && !parsed.commentBank.length) {
    throw new Error('commentRatio > 0 时必须提供 commentBank 评论内容库');
  }
  if (parsed.post.enabled) {
    if (!parsed.post.title) throw new Error('开启发帖必须提供 post.title');
    if (!parsed.post.text) throw new Error('开启发帖必须提供 post.text');
    if (!parsed.post.subs.length) throw new Error('开启发帖必须提供 post.subs 列表');
  }
  return parsed;
}

/**
 * 校验并规范化私信触达（outreach）配置。
 * 与 parseConfig 分离，避免养号配置段的无关字段混入。
 *
 * @param {object} cfg 前端提交的原始 outreach 配置
 * @returns {object} 规范化后的配置
 */
function parseOutreachConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('配置必须是 JSON 对象');
  if (!cfg.target || !cfg.target.type || !cfg.target.value) {
    throw new Error('缺少 target（serial/profiles/group 及取值）');
  }
  if (!['serial', 'profiles', 'group'].includes(cfg.target.type)) {
    throw new Error('target.type 必须是 serial / profiles / group');
  }
  const sub = String(cfg.sub || '').trim().replace(/^r\//i, '');
  if (!sub) throw new Error('缺少 sub（目标社区）');
  const keywords = strList(cfg.keywords);
  if (!keywords.length) throw new Error('keywords 至少需要一个标题关键词');
  const template = cfg.template != null ? String(cfg.template) : '';
  if (!template.trim()) throw new Error('template 不能为空');
  if (!template.includes('{username}')) throw new Error('template 必须包含 {username} 占位符');
  const channel = String(cfg.channel || 'compose').toLowerCase();
  if (!['matrix', 'compose'].includes(channel)) throw new Error('channel 必须是 matrix / compose');

  const parsed = {
    target: {
      type: cfg.target.type,
      value: String(cfg.target.value).trim(),
    },
    sub,
    keywords,
    template,
    channel,
    personalize: Boolean(cfg.personalize), // 触达消息去模板化：发送前 LLM 个性化
    runLimit: num(cfg.runLimit ?? cfg.dailyLimit, 20, 1, 200, 'runLimit'),
    sendIntervalMin: num(cfg.sendIntervalMin, 60, 5, 600, 'sendIntervalMin'),
    sendIntervalMax: num(cfg.sendIntervalMax, 120, 5, 600, 'sendIntervalMax'),
    maxPosts: num(cfg.maxPosts, 100, 1, 500, 'maxPosts'),
    maxCommentsPerPost: num(cfg.maxCommentsPerPost, 50, 1, 1000, 'maxCommentsPerPost'),
    commentHours: num(cfg.commentHours, 168, 1, 24 * 30, 'commentHours'),
    minScore: num(cfg.minScore, 1, 0, 1000, 'minScore'),
    mods: strList(cfg.mods),
    bots: strList(cfg.bots),
    excludeNames: strList(cfg.excludeNames),
    subjects: strList(cfg.subjects),
    seed: cfg.seed != null && cfg.seed !== '' ? Number(cfg.seed) : null,
  };

  if (parsed.sendIntervalMax < parsed.sendIntervalMin) {
    throw new Error('sendIntervalMax 必须 >= sendIntervalMin');
  }
  return parsed;
}

module.exports = { parseConfig, parseOutreachConfig, strList, num, writeRules, SUB_KEYWORD_PRESETS };
