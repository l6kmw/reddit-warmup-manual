'use strict';
/**
 * requeue.js — 私信触达：队列恢复工具（人工介入语义）
 *
 * 背景：旧版 sender 曾用 daily-limit 逻辑把超出额度的 pending 批量标记为
 *       skipped(daily_limit_reached)，且旧版选择器失败的条目被标记为 failed。
 *       这些条目在状态机中允许恢复（skipped→pending / failed→pending，
 *       见 queue.js TRANSITIONS），本工具就是执行恢复的唯一入口。
 *
 * 用法：
 *   node lib/outreach/requeue.js                      # dry-run：打印恢复计划
 *   node lib/outreach/requeue.js --apply               # 实际恢复（默认全部 skipped+failed）
 *   node lib/outreach/requeue.js --from failed         # 只恢复 failed
 *   node lib/outreach/requeue.js --reason daily_limit_reached   # 只恢复该原因的 skipped
 *   node lib/outreach/requeue.js --sub lawncare        # 只恢复指定子版
 *   node lib/outreach/requeue.js --username x,y        # 只恢复指定用户
 *   node lib/outreach/requeue.js --apply --backup      # 恢复前备份队列文件
 *
 * 安全设计：
 *   - 默认 dry-run，--apply 才真正落盘；
 *   - 迁移受 queue.js 状态机约束（非法迁移不会发生）；
 *   - 失败条目恢复后会被当前 sender 重新尝试发送（这正是人工介入的语义）。
 */

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const queueModule = require('./queue');

const { STATUS, TRANSITIONS, readQueue } = queueModule;

/**
 * 纯函数：生成恢复计划（不落盘）。
 * @param {Array<object>} items 队列 items
 * @param {object} [opts]
 * @param {Array<string>} [opts.statuses=['skipped','failed']] 要恢复的当前状态
 * @param {Array<string>} [opts.reasons=[]] 仅恢复 skipReason 匹配的条目（空=不按原因过滤）
 * @param {Array<string>} [opts.subs=[]] 仅恢复指定 sub（空=不按 sub 过滤）
 * @param {Array<string>} [opts.usernames=[]] 仅恢复指定用户名（空=不按用户名过滤）
 * @returns {{toRequeue: Array, notEligible: Array, filteredOut: Array}}
 */
function buildRequeuePlan(items, { statuses = ['skipped', 'failed'], reasons = [], subs = [], usernames = [] } = {}) {
  const wantedStatus = new Set((statuses || []).map((s) => String(s).toLowerCase()));
  const wantedReason = new Set((reasons || []).map((r) => String(r).toLowerCase()));
  const wantedSub = new Set((subs || []).map((s) => String(s).toLowerCase()).filter(Boolean));
  const wantedUser = new Set((usernames || []).map((u) => String(u).toLowerCase()).filter(Boolean));

  const toRequeue = [];
  const notEligible = [];
  const filteredOut = [];

  for (const item of items || []) {
    const st = String(item.status || '').toLowerCase();
    if (!wantedStatus.has(st)) continue;

    if (wantedReason.size) {
      const r = String(item.skipReason || '').toLowerCase();
      if (!wantedReason.has(r)) {
        filteredOut.push({ id: item.id, username: item.username, reason: `skipReason 不匹配: ${r || '(无)'}` });
        continue;
      }
    }
    if (wantedSub.size) {
      const s = String(item.sub || '').toLowerCase();
      if (!wantedSub.has(s)) {
        filteredOut.push({ id: item.id, username: item.username, reason: `sub 不匹配: ${s || '(无)'}` });
        continue;
      }
    }
    if (wantedUser.size) {
      const u = String(item.username || '').toLowerCase();
      if (!wantedUser.has(u)) {
        filteredOut.push({ id: item.id, username: item.username, reason: `username 不匹配: ${u || '(无)'}` });
        continue;
      }
    }

    const allowed = TRANSITIONS[st] || [];
    if (!allowed.includes(STATUS.PENDING)) {
      notEligible.push({ id: item.id, username: item.username, from: st });
      continue;
    }
    toRequeue.push(item);
  }
  return { toRequeue, notEligible, filteredOut };
}

/**
 * 执行恢复（默认 dry-run；apply=true 时落盘）。
 * @param {object} [opts]
 * @param {Array<string>} [opts.statuses]
 * @param {Array<string>} [opts.reasons]
 * @param {Array<string>} [opts.subs]
 * @param {Array<string>} [opts.usernames]
 * @param {boolean} [opts.apply=false] true=真正修改状态
 * @returns {{applied: boolean, updated: Array<string>, invalid: Array, plan: object}}
 */
function requeue({ statuses, reasons, subs, usernames, apply = false } = {}) {
  const queue = readQueue();
  const plan = buildRequeuePlan(queue.items || [], { statuses, reasons, subs, usernames });
  if (!apply) {
    return { applied: false, updated: [], invalid: [], plan };
  }
  const ids = plan.toRequeue.map((i) => i.id);
  const result = queueModule.markStatus(ids, STATUS.PENDING, {});
  return { applied: true, updated: result.updated, invalid: result.invalid, plan };
}

// ==================== CLI 入口 ====================

function parseArgs(argv) {
  const opts = { statuses: [], reasons: [], subs: [], usernames: [], apply: false, backup: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--backup') opts.backup = true;
    else if (arg === '--from') opts.statuses = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--reason') opts.reasons = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--sub') opts.subs = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--username') opts.usernames = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (!opts.statuses.length) opts.statuses = ['skipped', 'failed'];
  return opts;
}

function main() {
  const fs = require('fs');
  const opts = parseArgs(process.argv.slice(2));

  if (opts.backup && opts.apply) {
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const src = queueModule.QUEUE_FILE;
    const dst = `${src}.bak-${stamp}`;
    fs.copyFileSync(src, dst);
    console.log(`[requeue] 已备份队列到 ${path.relative(ROOT, dst)}`);
  }

  const result = requeue({
    statuses: opts.statuses,
    reasons: opts.reasons,
    subs: opts.subs,
    usernames: opts.usernames,
    apply: opts.apply,
  });

  const { toRequeue, notEligible, filteredOut } = result.plan;
  console.log(`[requeue] ${opts.apply ? '已执行' : 'dry-run（加 --apply 生效）'}：`);
  console.log(`  - 将恢复 ${toRequeue.length} 条 → pending（状态: ${opts.statuses.join(',')}）`);
  if (opts.reasons.length) console.log(`  - 原因过滤: ${opts.reasons.join(',')}`);
  if (opts.subs.length) console.log(`  - sub 过滤: ${opts.subs.join(',')}`);
  if (opts.usernames.length) console.log(`  - username 过滤: ${opts.usernames.join(',')}`);
  if (notEligible.length) console.log(`  - 状态机不允许恢复: ${notEligible.length} 条（${notEligible.slice(0, 5).map((n) => `${n.username}(${n.from})`).join(', ')}${notEligible.length > 5 ? '...' : ''}）`);
  if (filteredOut.length) console.log(`  - 已被过滤器排除: ${filteredOut.length} 条`);
  if (result.applied) console.log(`  - 实际更新: ${result.updated.length} 条${result.invalid.length ? `；无效迁移: ${result.invalid.length} 条` : ''}`);
}

if (require.main === module) {
  main();
}

module.exports = { buildRequeuePlan, requeue };