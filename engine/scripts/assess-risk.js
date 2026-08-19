#!/usr/bin/env node
/**
 * assess-risk.js — 评估 Reddit 账号风险档位 (T0-T3)
 *
 * 基于用户主页的注册时间与 karma 计算档位, 用于评论/发帖门控。
 *
 * 用法:
 *   node scripts/assess-risk.js --serial 4,5,6,7
 *   node scripts/assess-risk.js --group Reddit
 *   node scripts/assess-risk.js --serial 4 --json
 *   node scripts/assess-risk.js --serial 4 --account-data account-data.json
 *
 * 补录: 页面抓不到注册时间时 (保守按 T0), 可用 --account-data 传入
 *   账号资料文件补录注册日期: [{"serial": 9, "createdAt": "2026-05-01"}]
 */
const { loadAdsModules } = require('../lib/resolve-ads');
const { machineManager } = loadAdsModules();
const { MachineManager } = machineManager;
const { extractAccountInfo } = require('./healthcheck');
const fs = require('fs');
const path = require('path');
const { ENV_ERROR } = require('../lib/exit-codes');
const { emitJSON } = require('../lib/jsonout');

// 从账号资料文件补录注册日期。格式: JSON 数组/对象, key 为 serial 或 profileId,
// 值为 ISO 日期或天数。用于页面抓不到注册时间时 (保守 T0) 的修正。
// 例: [{"serial": 9, "createdAt": "2026-05-01"}, ...]
function loadAccountData(file) {
  if (!file) return null;
  const raw = fs.readFileSync(path.resolve(file), 'utf8');
  const data = JSON.parse(raw);
  const list = Array.isArray(data) ? data : (data.accounts || []);
  const map = {};
  for (const item of list) {
    const key = item.serial != null ? `serial:${item.serial}` : `id:${item.profileId}`;
    map[key] = item;
  }
  return map;
}

function createdDaysFromData(item) {
  if (!item) return null;
  if (typeof item.createdDays === 'number') return item.createdDays;
  if (item.createdAt) {
    const days = Math.floor((Date.now() - Date.parse(item.createdAt)) / 86400000);
    return days >= 0 ? days : null;
  }
  return null;
}

// "Redditor for X" / "Reddit 资历 X" → 天数估算 (中英文单位兼容)
function parseRedditorFor(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  const years = lower.match(/([\d.]+)\s*(?:years?|年)/);
  const months = lower.match(/([\d.]+)\s*(?:months?|个月)/);
  const weeks = lower.match(/([\d.]+)\s*(?:weeks?|周)/);
  const days = lower.match(/([\d.]+)\s*(?:days?|天)/);
  let totalDays = 0;
  if (years) totalDays += parseFloat(years[1]) * 365;
  if (months) totalDays += parseFloat(months[1]) * 30;
  if (weeks) totalDays += parseFloat(weeks[1]) * 7;
  if (days) totalDays += parseFloat(days[1]);
  return totalDays > 0 ? Math.round(totalDays) : null;
}

function parseKarma(value) {
  if (value == null) return null;
  const cleaned = String(value).replace(/,/g, '').trim().toLowerCase();
  const match = cleaned.match(/^([\d.]+)\s*([km])?$/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  if (match[2] === 'k') return Math.round(num * 1000);
  if (match[2] === 'm') return Math.round(num * 1000000);
  return Math.round(num);
}

/**
 * 档位顺序（用于取低者比较）：T0 < T1 < T2 < T3
 */
const TIER_ORDER = ['T0', 'T1', 'T2', 'T3'];

/** 各档位允许动作 */
const TIER_ALLOWED = {
  T0: ['browse', 'upvote'],
  T1: ['browse', 'upvote', 'comment-1'],
  T2: ['browse', 'upvote', 'comment', 'post-low'],
  T3: ['browse', 'upvote', 'comment', 'post', 'link-comment'],
};

/**
 * 时间维度档位（注册时长是硬门槛，不可被 karma 豁免）
 * @param {number|null} createdDays
 * @returns {'T0'|'T1'|'T2'|'T3'}
 */
function tierForDays(createdDays) {
  if (createdDays == null) return 'T0';
  if (createdDays < 7) return 'T0';
  if (createdDays < 30) return 'T1';
  if (createdDays < 60) return 'T2';
  return 'T3';
}

/**
 * karma 维度档位（karma 无法获取时按最低档 T1 保守处理）
 * @param {number|null} commentKarma
 * @returns {'T0'|'T1'|'T2'|'T3'}
 */
function tierForKarma(commentKarma) {
  const k = commentKarma == null ? 0 : commentKarma; // 缺失按 0（最低档）
  if (k < 50) return 'T1';
  if (k <= 200) return 'T2';
  return 'T3';
}

/**
 * 计算风险档位——时间档位 × karma 档位取低者（更保守，更符合养号逻辑）
 *
 * 安全轮教训（P0-5 动机）：旧逻辑允许 karma 豁免注册时长（8天+karma60→T2
 * 可发帖、31天+karma300→T3 可放链接），方向"更激进"，新号发帖+放链接正好
 * 踩中 Reddit spam 风控红线。注册时长是硬门槛，karma 只能在其内校准，不能越级。
 *
 * P2-2 对账：返回 evidence 证据链（输入 → 维度档位 → 取低者），
 * 供 assess --explain 输出"为什么得到这个档位"。
 *
 * @param {{createdDays: number|null, commentKarma: number|null}} info
 * @returns {{tier: string, reason: string, allowed: string[], evidence: object}}
 */
function assessTier({ createdDays, commentKarma }) {
  const tDays = tierForDays(createdDays);
  const tKarma = tierForKarma(commentKarma);
  const tier = TIER_ORDER[Math.min(TIER_ORDER.indexOf(tDays), TIER_ORDER.indexOf(tKarma))];
  const reason = `时间档位 ${tDays} × karma 档位 ${tKarma} → 取低者 ${tier}`;
  // P2-2: 证据链（输入 → 维度判定 → 最终档位）
  const evidence = {
    input: {
      createdDays: createdDays ?? null,
      commentKarma: commentKarma ?? null,
      createdKnown: createdDays != null,
      karmaKnown: commentKarma != null,
    },
    byDays: { tier: tDays, rule: tierForDaysRule(createdDays) },
    byKarma: { tier: tKarma, rule: tierForKarmaRule(commentKarma) },
    combination: `min(${tDays}, ${tKarma}) = ${tier}`,
    conservativeBias: createdDays == null ? '注册时间未知 → 按 T0 保守处理' : (commentKarma == null ? 'karma 未知 → 按最低档 T1 处理' : '数据完整'),
  };
  return { tier, reason, allowed: TIER_ALLOWED[tier], evidence };
}

/** 时间维度规则说明（供 evidence） */
function tierForDaysRule(createdDays) {
  if (createdDays == null) return '注册时间未知 → T0（保守）';
  if (createdDays < 7) return `注册 ${createdDays} 天 < 7 → T0`;
  if (createdDays < 30) return `注册 ${createdDays} 天 ∈ [7,30) → T1（注册时长硬门槛，karma 不能越级）`;
  if (createdDays < 60) return `注册 ${createdDays} 天 ∈ [30,60) → T2（注册时长硬门槛，karma 不能越级）`;
  return `注册 ${createdDays} 天 ≥ 60 → T3`;
}

/** karma 维度规则说明（供 evidence） */
function tierForKarmaRule(commentKarma) {
  if (commentKarma == null) return 'karma 未知 → 按最低档 T1（保守）';
  const k = commentKarma;
  if (k < 50) return `comment karma ${k} < 50 → T1`;
  if (k <= 200) return `comment karma ${k} ∈ [50,200] → T2`;
  return `comment karma ${k} > 200 → T3`;
}

function parseArgs(argv) {
  const options = { profileIds: [], serialNumbers: [], groupName: undefined, json: false, accountData: null, explain: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--serial') {
      options.serialNumbers.push(...String(argv[++index] ?? '').split(','));
    } else if (arg === '--profiles') {
      options.profileIds.push(...String(argv[++index] ?? '').split(','));
    } else if (arg === '--group') {
      options.groupName = argv[++index];
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--account-data') {
      options.accountData = argv[++index];
    } else if (arg === '--explain') {
      options.explain = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`未知参数: ${arg}`);
    } else {
      options.profileIds.push(arg);
    }
  }
  if (!options.profileIds.length && !options.serialNumbers.length && !options.groupName) {
    throw new Error('请通过 --serial N,M / --profiles id1,id2 / --group NAME 选择机器');
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manager = new MachineManager({ concurrency: 1 });
  const results = [];
  const accountData = loadAccountData(options.accountData);
  let backedUp = 0;
  try {
    const profiles = await manager.resolveProfiles(options);
    if (!profiles.length) throw new Error('没有匹配的机器');

    for (const profile of profiles) {
      const label = profile.serial ? `serial ${profile.serial}` : profile.id;
      try {
        const machine = await manager.connectMachine(profile.id);
        const page = await manager.getMainPage(machine);
        const info = await extractAccountInfo(page, machine);
        let createdDays = parseRedditorFor(info.created);
        let commentKarma = parseKarma(info.commentKarma);
        let backedUpFrom = null;
        // 页面抓不到注册时间时, 尝试从账号资料文件补录
        if (createdDays == null && accountData) {
          const key = profile.serial != null ? `serial:${profile.serial}` : `id:${profile.id}`;
          const extra = createdDaysFromData(accountData[key]);
          if (extra != null) {
            createdDays = extra;
            backedUpFrom = 'account-data';
            backedUp += 1;
          }
        }
        const assessment = assessTier({ createdDays, commentKarma });
        results.push({
          serial: profile.serial,
          profileId: profile.id,
          name: profile.name,
          loggedIn: info.loggedIn,
          username: info.username,
          createdRaw: info.created,
          createdDays,
          createdSource: backedUpFrom || (info.created ? 'profile-page' : null),
          commentKarma,
          linkKarma: parseKarma(info.linkKarma),
          ...assessment,
        });
        if (!options.json) {
          const src = backedUpFrom ? ` (补录: ${createdDays} 天)` : '';
          console.log(`  [${label}] ${profile.name}: 档位 ${assessment.tier} (${assessment.reason})${src} 允许: ${assessment.allowed.join(', ')}`);
          // P2-2: --explain 输出证据链（为什么得到这个档位）
          if (options.explain) {
            const ev = assessment.evidence;
            console.log(`    证据链:`);
            console.log(`      · 输入: createdDays=${ev.input.createdDays ?? '未知'}${ev.input.createdKnown ? '' : '（保守 T0）'}, karma=${ev.input.commentKarma ?? '未知'}${ev.input.karmaKnown ? '' : '（保守 T1）'}`);
            console.log(`      · 时间维度: ${ev.byDays.rule}`);
            console.log(`      · karma 维度: ${ev.byKarma.rule}`);
            console.log(`      · 组合: ${ev.combination}`);
          }
        }
      } catch (error) {
        results.push({ serial: profile.serial, profileId: profile.id, name: profile.name, tier: 'T0', error: error.message });
        if (!options.json) console.log(`  [${label}] ${profile.name}: ❌ 评估失败 - ${error.message.slice(0, 80)}`);
      }
    }
    if (!options.json && backedUp > 0) console.log(`\n补录来源: ${backedUp} 个账号从 --account-data 补录注册时间`);
    if (options.json) {
      emitJSON({
        results: { ok: true, accounts: results, backedUp },
        script: 'assess-risk',
        exitCode: 0,
        args: { serials: options.serialNumbers, profiles: options.profileIds, group: options.groupName, accountData: options.accountData || null },
      });
    }
  } finally {
    await manager.closeAll();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('出错:', error.message);
    process.exitCode = ENV_ERROR;
  });
}

module.exports = { assessTier, tierForDays, tierForKarma, parseRedditorFor, parseKarma, parseArgs, loadAccountData, createdDaysFromData };
