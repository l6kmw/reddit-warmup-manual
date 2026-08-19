'use strict';
/**
 * rng.js — 可播种随机数 + 真人行为分布（对应优化计划 P2-3/P2-6）
 *
 * 背景（PI 方法论）：
 *   1. Math.random() 均匀分布最不像人——真人的行为间隔是幂律/长尾分布
 *   2. 无种子不可复现——同一参数组合两次运行结果不同，实验无法回溯
 *
 * 实现：
 *   - mulberry32 可播种 PRNG（确定性、快速、够用）
 *   - 对数正态分布（lognormal）：真人逗留/间隔的标准模型之一，
 *     参数 mu/sigma 可校准；截断到 [min, max] 区间
 *   - 所有采样函数接受 rng 参数，缺省用 Math.random（向后兼容）
 *
 * 用法：
 *   const { createRng, lognormalInt, randInt, shuffle } = require('../lib/rng');
 *   const rng = createRng(seed);        // --seed 场景
 *   const dwell = lognormalInt(rng, 120, 240, { mu: 5.0, sigma: 0.4 });
 */
'use strict';

/** mulberry32 可播种 PRNG（返回 [0,1) 均匀） */
function createRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 标准正态（Box-Muller），基于传入 rng */
function normal(rng) {
  const u = 1 - rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * 对数正态采样（截断到 [min, max]）
 * @param {function} rng 随机源
 * @param {number} min 下限（秒/次数）
 * @param {number} max 上限
 * @param {object} [params] mu/sigma（默认校准：mu=log(中点), sigma=0.35）
 * @returns {number} 截断后的整数
 */
function lognormalInt(rng, min, max, params = {}) {
  const { mu = Math.log((min + max) / 2), sigma = 0.35 } = params;
  let v = Math.exp(mu + sigma * normal(rng));
  v = Math.round(v);
  return Math.max(min, Math.min(max, v));
}

/** 区间内整数（均匀，可播种） */
function randInt(rng, min, max) {
  return Math.floor(min + rng() * (max - min + 1));
}

/** 洗牌（可播种） */
function shuffle(rng, arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 按概率返回 true（可播种） */
function chance(rng, p) {
  return rng() < p;
}

module.exports = { createRng, lognormalInt, randInt, shuffle, chance, normal };
