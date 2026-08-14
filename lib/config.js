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
    post: {
      enabled: Boolean(cfg.post && cfg.post.enabled),
      title: (cfg.post && cfg.post.title && String(cfg.post.title).trim()) || null,
      text: (cfg.post && cfg.post.text && String(cfg.post.text).trim()) || null,
      subs: strList(cfg.post && cfg.post.subs),
      lookbackDays: num(cfg.post && cfg.post.lookbackDays, 7, 1, 90, 'post.lookbackDays'),
      maxCount: num(cfg.post && cfg.post.maxCount, 2, 1, 30, 'post.maxCount'),
    },
    inputMode: cfg.inputMode === 'legacy' ? 'legacy' : 'wheel',
    voteMode: ['api-only', 'mixed'].includes(cfg.voteMode) ? cfg.voteMode : 'click-first',
    seed: cfg.seed != null && cfg.seed !== '' ? Number(cfg.seed) : null,
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

module.exports = { parseConfig, strList, num };
