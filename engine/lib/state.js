'use strict';
/**
 * state.js — reports/state/ 状态文件统一读写（对应优化计划 P0-4 / 原则三）
 *
 * 设计要点：
 *   1. 原子写：写临时文件（.tmp.<pid>）→ rename 覆盖，杜绝并发/崩溃丢数据
 *   2. 状态文件带 schemaVersion，供未来迁移（P1-3 schema 版本化）
 *   3. 读失败（损坏）返回 null 不抛异常——宁可少记不可记脏
 *   4. 单文件单用途：comments.json（频率门控）、shadowban.json（缓存）等
 *
 * 用法：
 *   const { readState, writeState, bumpDaily } = require('../lib/state');
 *   const st = readState('comments', { schemaVersion: 1 });
 *   writeState('comments', st);
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Tests and one-off diagnostics may redirect state explicitly. Production keeps
// the historical reports/state default when no override is provided.
const STATE_DIR = process.env.REDDIT_WARMUP_STATE_DIR
  ? path.resolve(process.env.REDDIT_WARMUP_STATE_DIR)
  : path.join(__dirname, '..', 'reports', 'state');

/**
 * 读取状态文件（损坏/不存在返回 defaultValue）
 * @param {string} name 状态文件名（不含 .json）
 * @param {object} defaultValue 默认结构（含 schemaVersion）
 * @returns {object|null} 解析成功返回对象；损坏返回 null
 */
function readState(name, defaultValue) {
  const file = path.join(STATE_DIR, `${name}.json`);
  try {
    if (!fs.existsSync(file)) return defaultValue;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...defaultValue, ...data }; // 缺失字段补默认
  } catch {
    // 文件损坏 → 返回 null，调用方决定是否重建
    return null;
  }
}

/**
 * 原子写状态文件（tmp + rename）
 * @param {string} name 状态文件名（不含 .json）
 * @param {object} data 要写入的对象
 * @returns {boolean} 是否成功
 */
function writeState(name, data) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const file = path.join(STATE_DIR, `${name}.json`);
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file); // 原子替换
    return true;
  } catch {
    return false;
  }
}

/**
 * 频率门控：读取/递增每日计数（comments.json）
 *
 * Schema:
 * {
 *   schemaVersion: 1,
 *   updatedAt: ISO,
 *   accounts: {
 *     "serial:9": { day: "2026-08-10", comments: 1, upvotes: 5, lastAt: ISO }
 *   }
 * }
 *
 * @param {string} key 账号键（如 "serial:9" 或 "id:k1exc02p"）
 * @returns {{state: object, daily: object, day: string}}
 */
function loadDailyCounter(key) {
  const day = new Date().toISOString().slice(0, 10); // 本地日期用 toLocaleDateString? 用 UTC 统一
  const defaultValue = { schemaVersion: 1, updatedAt: null, accounts: {} };
  // P1-3: 走版本化加载——版本过高/损坏时回退默认（宁可少记不可记脏，不阻塞主流程）
  let state = defaultValue;
  try {
    const { loadVersioned } = require('./schema');
    const r = loadVersioned('comments', defaultValue);
    if (r.ok && r.data) state = r.data;
    // 版本问题（upgrade/downgrade）或损坏：保留默认，不抛异常
  } catch {
    state = defaultValue;
  }
  const acc = state.accounts[key] || { day: null, comments: 0, upvotes: 0, lastAt: null };
  // 跨天重置
  if (acc.day !== day) {
    acc.day = day;
    acc.comments = 0;
    acc.upvotes = 0;
  }
  return { state, daily: acc, day };
}

/**
 * 递增某账号当日某动作计数（原子写）
 * @param {string} key 账号键
 * @param {'comments'|'upvotes'} field 动作类型
 * @param {number} [n=1] 增量
 * @returns {{ok: boolean, count: number, state: object}}
 */
function bumpDaily(key, field, n = 1) {
  const { state, daily } = loadDailyCounter(key);
  daily[field] = (daily[field] || 0) + n;
  daily.lastAt = new Date().toISOString();
  state.updatedAt = daily.lastAt;
  state.accounts[key] = daily;
  const ok = writeState('comments', state);
  return { ok, count: daily[field], state };
}

/**
 * 查询某账号当日计数（只读）
 * @param {string} key 账号键
 * @param {string} field 动作类型（comments/upvotes）
 * @returns {number} 当日计数
 */
function getDailyCount(key, field) {
  const { daily } = loadDailyCounter(key);
  return daily[field] || 0;
}

/**
 * 写入最近一次运行摘要（last-run.json）——agent 的跨会话记忆（优化计划 P1-5）
 *
 * agent 第二天打开会话时先读这个文件，就能知道"昨晚发生了什么"，
 * 不用重跑 daily/巡检。
 *
 * Schema:
 * {
 *   schemaVersion: 1,
 *   script: "daily",
 *   startedAt: ISO, finishedAt: ISO,
 *   exitCode: 0|1|2,
 *   target: { type: "serial"|"profiles"|"group", value: string },
 *   summary: { machinesTotal, machinesOk, machinesFailed, tierDistribution, browsed, upvoted, comments, posts, shadowbanned: [...] },
 *   alerts: [{ level, serial, message }],
 *   reportFile: "reports/daily-xxx.json"
 * }
 *
 * @param {object} entry 运行摘要（不含 schemaVersion，自动补）
 * @returns {boolean} 是否写成功
 */
function writeLastRun(entry) {
  const data = {
    schemaVersion: 1,
    ...entry,
    finishedAt: entry.finishedAt || new Date().toISOString(),
  };
  return writeState('last-run', data);
}

module.exports = {
  STATE_DIR,
  readState,
  writeState,
  loadDailyCounter,
  bumpDaily,
  getDailyCount,
  writeLastRun,
};
