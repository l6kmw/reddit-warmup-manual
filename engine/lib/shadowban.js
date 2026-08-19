'use strict';
/**
 * shadowban.js — shadowban 探测缓存（对应优化计划 P0-6）
 *
 * 背景：daily 每次运行都通过 extractAccountInfo 做无痕 shadowban 探测——
 * 一天内 daily + 手动 healthcheck + assess-risk 可能 3 次用裸 Chromium 访问
 * 自己主页，探测行为本身即风控信号（观察者效应）。且无痕探针不继承
 * AdsPower 指纹/代理配置，常被网络层拦截导致探测不可用。
 *
 * 方案：
 *   1. 探测结果缓存到 reports/state/shadowban.json（detected_at/evidence/skip_until）
 *   2. daily 默认跳过探测、读缓存（命中且未过期则不探测）
 *   3. healthcheck（显式巡检）做完整探测并写缓存
 *   4. --force 显式覆盖缓存强制重新探测
 *
 * 缓存文件 Schema:
 * {
 *   schemaVersion: 1,
 *   updatedAt: ISO,
 *   accounts: {
 *     "serial:9": {
 *       shadowbanned: true|false|null,
 *       evidence: "comment_not_visible_readback" | null,
 *       detectedAt: ISO,
 *       skipUntil: ISO   // 缓存有效期（默认 24h）
 *     }
 *   }
 * }
 */
'use strict';

const path = require('path');
const { readState, writeState } = require('./state');

const CACHE_NAME = 'shadowban';
const DEFAULT_TTL_MS = 24 * 3600 * 1000; // 缓存有效期 24h

/**
 * 读取 shadowban 缓存
 * @returns {object} {schemaVersion, updatedAt, accounts}
 */
function loadCache() {
  const def = { schemaVersion: 1, updatedAt: null, accounts: {} };
  return readState(CACHE_NAME, def) || def; // 损坏时重建空缓存
}

/**
 * 读取某账号缓存判定
 * @param {string} key 账号键（serial:N 或 id:xxx）
 * @returns {{shadowbanned: boolean|null, evidence: string|null, detectedAt: string|null, skipUntil: string|null}|null}
 */
function getCached(key) {
  const cache = loadCache();
  return cache.accounts[key] || null;
}

/**
 * 写入某账号缓存判定（带有效期 skipUntil）
 * @param {string} key 账号键
 * @param {boolean|null} shadowbanned 判定（null = 检测不可用）
 * @param {string|null} evidence 证据
 * @param {number} [ttlMs] 缓存有效期（默认 24h）
 * @returns {boolean} 是否写成功
 */
function setCached(key, shadowbanned, evidence = null, ttlMs = DEFAULT_TTL_MS) {
  const cache = loadCache();
  const now = new Date();
  cache.updatedAt = now.toISOString();
  cache.accounts[key] = {
    shadowbanned,
    evidence,
    detectedAt: now.toISOString(),
    skipUntil: new Date(now.getTime() + ttlMs).toISOString(),
  };
  return writeState(CACHE_NAME, cache);
}

/**
 * 判断某账号今日是否应跳过探测（命中缓存且未过期）
 * @param {string} key 账号键
 * @param {boolean} [force] 强制重新探测（跳过缓存判断）
 * @returns {{skip: boolean, reason: string|null, cached: object|null}}
 */
function shouldSkip(key, force = false) {
  if (force) return { skip: false, reason: 'force', cached: null };
  const cached = getCached(key);
  if (!cached || !cached.skipUntil) return { skip: false, reason: 'no-cache', cached };
  const now = Date.now();
  const skipUntil = Date.parse(cached.skipUntil);
  if (Number.isNaN(skipUntil) || now >= skipUntil) {
    return { skip: false, reason: 'expired', cached };
  }
  return { skip: true, reason: 'cache-hit', cached };
}

module.exports = { loadCache, getCached, setCached, shouldSkip, DEFAULT_TTL_MS };
