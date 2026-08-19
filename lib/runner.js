#!/usr/bin/env node
'use strict';
/**
 * runner.js — 手动控制版 Reddit 养号执行器
 *
 * 由 server.js 以子进程方式启动，参数通过 --config <json文件> 传入。
 * 使用仓库内置引擎：MachineManager（AdsPower 连接）、
 * healthcheck（登录/karma）、assess-risk（档位门控）、openAndReadPost
 * （阅读详情）、voteOnPostDual（点赞双轨）、comment.js / post.js（写操作门控）。
 *
 * 比例语义：
 *   - upvoteRatio   0~1  对浏览列表收集到的每个候选帖，以该概率点赞
 *   - readRatio     0~1  浏览过程中每次滚动停顿后，以该概率打开一篇帖子阅读
 *   - commentRatio  0~1  每个板块养号结束后，以该概率挑选一条评论执行
 *                        （评论内容来自 commentBank，档位/质量/AI 检查由 comment.js 完成）
 *
 * 安全边界与源仓库一致：评论/发帖全部经过档位门控 + 频率门控 + AI 痕迹检查；
 * 手动版新增"近日发帖频率"门控（近 lookbackDays 天发帖数 < maxCount，状态存
 * 本目录 state/posts.json）。
 *
 * 用法：
 *   node lib/runner.js --config /tmp/manual-config.json
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ---- 使用仓库内置引擎（绝对路径 require，避免 cwd 假设）----
const ENGINE_ROOT = path.resolve(__dirname, '..', 'engine');
const { loadAdsModules } = require(path.join(ENGINE_ROOT, 'lib', 'resolve-ads'));
const { machineManager } = loadAdsModules();
const { MachineManager } = machineManager;
const { extractAccountInfo } = require(path.join(ENGINE_ROOT, 'scripts', 'healthcheck'));
const { assessTier, parseRedditorFor, parseKarma } = require(path.join(ENGINE_ROOT, 'scripts', 'assess-risk'));
const { fetchCommunityRules } = require(path.join(ENGINE_ROOT, 'lib', 'community-rules'));
const { writeMdReport } = require(path.join(ENGINE_ROOT, 'lib', 'md-report'));
const {
  collectPostCandidates,
  openAndReadPost,
  detectChallenge,
  humanScroll,
  SUB_POOL,
} = require(path.join(ENGINE_ROOT, 'scripts', 'warmup'));
const { voteOnPostDual } = require(path.join(ENGINE_ROOT, 'lib', 'upvote'));
const { createRng, randInt, shuffle, chance } = require(path.join(ENGINE_ROOT, 'lib', 'rng'));
const { parseConfig } = require('./config');

const REPORT_DIR = path.join(__dirname, '..', 'logs');
const STATE_DIR = path.join(__dirname, '..', 'state');
const POSTS_STATE_FILE = path.join(STATE_DIR, 'posts.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- 状态：近日发帖频率（手动版独立状态，避免污染源仓库统计）----
function readPostsState() {
  try {
    return JSON.parse(fs.readFileSync(POSTS_STATE_FILE, 'utf8'));
  } catch {
    return { schemaVersion: 1, accounts: {} };
  }
}

function writePostsState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${POSTS_STATE_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, POSTS_STATE_FILE);
}

/** 近 N 天内某账号发帖数 */
function recentPostCount(state, key, days) {
  const list = state.accounts[key] || [];
  const cutoff = Date.now() - days * 86400000;
  return list.filter((t) => t >= cutoff).length;
}

function recordPost(state, key) {
  if (!state.accounts[key]) state.accounts[key] = [];
  state.accounts[key].push(Date.now());
  writePostsState(state);
}

// ---- 子进程写操作（使用内置引擎的完整门控）----
function runScript(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ENGINE_ROOT, 'scripts', script), ...args], {
      cwd: ENGINE_ROOT,
      stdio: 'inherit',
    });
    child.on('close', (code) => resolve({ code, script }));
  });
}

function targetArgs(profile) {
  return profile.serial != null ? ['--serial', String(profile.serial)] : ['--profiles', profile.id];
}

function writeRuleArgs(rules, sub, { flair = false } = {}) {
  const rule = rules[String(sub).toLowerCase()] || {};
  const args = [];
  if (rule.ack) args.push('--rules-ack', rule.ack);
  if (rule.confirmedUnresolved?.length) args.push('--confirm-unresolved', rule.confirmedUnresolved.join(','));
  if (flair && rule.flair) args.push('--flair', rule.flair);
  return args;
}

// ---- 进度协议：@@STATUS@@<json> 单行，server 解析用于前端展示 ----
function emitStatus(payload) {
  console.log(`@@STATUS@@${JSON.stringify(payload)}`);
}

// ---- 目标机器 ----
function targetQuery(target) {
  if (target.type === 'serial') return { serialNumbers: String(target.value).split(',').map((s) => s.trim()).filter(Boolean) };
  if (target.type === 'profiles') return { profileIds: String(target.value).split(',').map((s) => s.trim()).filter(Boolean) };
  return { groupName: String(target.value).trim() };
}

async function fetchRuleSnapshots(target, subs) {
  const manager = new MachineManager({ concurrency: 1, stopStartedProfiles: true });
  try {
    const profiles = await manager.resolveProfiles(targetQuery(target));
    if (!profiles.length) throw new Error('没有匹配的机器');
    const machine = await manager.connectMachine(profiles[0].id);
    const page = await manager.getMainPage(machine);
    const results = [];
    for (const sub of subs) {
      try {
        const snapshot = await fetchCommunityRules(page, sub);
        results.push({ ok: true, subreddit: snapshot.subreddit, hash: snapshot.hash, rules: snapshot.rules });
      } catch (error) {
        results.push({ ok: false, subreddit: sub, error: error.message });
      }
    }
    return { profile: { serial: profiles[0].serial, id: profiles[0].id, name: profiles[0].name }, results };
  } finally {
    await manager.closeAll().catch(() => {});
  }
}

// ---- 随机选板块 ----
function selectSubs(cfg, rng) {
  const source = cfg.subMode === 'random' ? SUB_POOL : cfg.subs;
  const uniqueSubs = [...new Set(source)];
  if (!uniqueSubs.length) return [];

  // subCount 表示每个账号实际安排的浏览次数，而不是最多抽取多少个不同社区。
  // 当指定社区少于 subCount 时，按随机轮次循环补足；例如只填 1 个社区、
  // subCount=4，就会让当前账号浏览该社区 4 次后再切换下一台机器。
  const selected = [];
  while (selected.length < cfg.subCount) {
    const round = shuffle(rng, [...uniqueSubs]);
    selected.push(...round.slice(0, cfg.subCount - selected.length));
  }
  return selected;
}

/** 替换评论/帖子文本里的 {sub} 占位符 */
function fillPlaceholders(text, sub) {
  return String(text).replace(/\{sub\}/g, sub).replace(/\{r\/\{sub\}\}/g, `r/${sub}`);
}

/** 根据 Reddit 页面内容判断社区是否已被封禁。 */
function classifyBannedPage(snapshot) {
  const text = String(snapshot.text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const title = String(snapshot.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const combined = `${title} ${text}`;
  const patterns = [
    /this (?:community|subreddit) has been banned/,
    /r\/[a-z0-9_]+ has been banned from reddit/,
    /(?:community|subreddit) has been banned/,
    /(?:community|subreddit) (?:is )?banned/,
    /has been banned from reddit/,
  ];
  const hit = patterns.find((pattern) => pattern.test(combined));
  return { banned: Boolean(hit), reason: hit ? combined.match(hit)?.[0] || 'banned' : null };
}

/** 检测社区是否被 Reddit 标记为 banned/不可访问。 */
async function detectBanned(page) {
  const snapshot = await page.evaluate(() => ({
    text: document.body?.innerText || '',
    title: document.title || '',
    url: location.href,
  }));
  return { ...classifyBannedPage(snapshot), url: snapshot.url };
}

/** 从当前来源中挑一个未被确认封禁的替代社区，不消耗后续浏览槽位。 */
function selectReplacementSub(cfg, rng, banned, remaining = []) {
  const source = cfg.subMode === 'random' ? SUB_POOL : cfg.subs;
  const bannedKeys = new Set([...banned].map((sub) => String(sub).toLowerCase()));
  const queued = new Set(remaining.map((sub) => String(sub).toLowerCase()));
  const candidates = [...new Map(source.map((sub) => [String(sub).toLowerCase(), sub])).values()]
    .filter((sub) => !bannedKeys.has(String(sub).toLowerCase()));
  const fresh = candidates.filter((sub) => !queued.has(String(sub).toLowerCase()));
  if (fresh.length) return shuffle(rng, fresh)[0];
  return shuffle(rng, candidates)[0] || null;
}

/**
 * 处理社区 banned 时的策略：
 * - 只有一个指定社区：保留 banned 结果，不替换；
 * - 多个指定社区或完全随机：从同一来源换一个未确认封禁的社区。
 */
function canReplaceBannedSub(cfg) {
  return cfg.subMode === 'random' || cfg.subs.length > 1;
}

function mdCell(value) {
  return String(value == null || value === '' ? '-' : value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return [hours ? `${hours}小时` : '', minutes ? `${minutes}分钟` : '', (!hours && !minutes) || secs ? `${secs}秒` : '']
    .filter(Boolean)
    .join('');
}

/** 将机器报告渲染为给人阅读的 Markdown。 */
function renderHumanReport(report) {
  const { config, results, summary } = report;
  const statusNames = {
    done: '完成',
    banned: '板块封禁',
    no_activity: '无有效活动',
    logged_out: '未登录',
    error: '失败',
  };
  const failed = results.filter((item) => ['error', 'logged_out'].includes(item.status)).length;
  const lines = [
    '# Reddit 养号运行报告',
    '',
    '## 运行概况',
    '',
    `- 开始时间：${new Date(report.startedAt).toLocaleString('zh-CN')}`,
    `- 结束时间：${new Date(report.finishedAt).toLocaleString('zh-CN')}`,
    `- 目标机器：${config.target.type} = ${config.target.value}`,
    `- 社区模式：${config.subMode === 'random' ? '完全随机' : `指定社区（${config.subs.join('、')}）`}`,
    `- 每账号浏览次数：${config.subCount}`,
    `- 每个社区停留：${config.minMinutesPerSub}-${config.maxMinutesPerSub} 分钟`,
    `- 完成账号：${summary.ok}/${summary.total}`,
    `- 失败或未登录：${failed}`,
    `- 阅读 ${summary.reads} 篇，点赞 ${summary.upvoted} 次，评论 ${summary.comments} 次，发帖 ${summary.posts} 次`,
    `- 检出封禁社区 ${summary.banned} 次，自动替换 ${summary.replacementSubs} 次`,
    '',
    '## 账号结果',
    '',
    '| 机器 | 账号 | 状态 | 实际社区 | 阅读 | 点赞 | 评论 | 发帖 | 用时 |',
    '|---|---|---|---|---:|---:|---:|---:|---:|',
  ];

  for (const item of results) {
    lines.push(`| ${mdCell(item.serial ?? item.profileId)} | ${mdCell(item.username || item.name)} | ${mdCell(statusNames[item.status] || item.status)} | ${mdCell((item.subs || []).map((sub) => `r/${sub}`).join('、'))} | ${item.reads || 0} | ${item.upvoted || 0} | ${item.comments || 0} | ${item.posts || 0} | ${formatDuration(item.dwellSeconds)} |`);
  }

  const noteworthy = results.filter((item) => item.error || item.bannedSubs?.length || item.replacements?.length || item.challenges);
  if (noteworthy.length) {
    lines.push('', '## 异常与切换明细', '');
    for (const item of noteworthy) {
      lines.push(`### 机器 ${item.serial ?? item.profileId} · ${item.username || item.name || '未知账号'}`, '');
      if (item.error) lines.push(`- 错误：${String(item.error).replace(/\r?\n/g, ' ')}`);
      if (item.challenges) lines.push(`- 风控页面：${item.challenges} 次`);
      for (const banned of item.bannedSubs || []) {
        lines.push(`- 封禁：r/${banned.sub}（${banned.reason || 'Reddit 标记为 banned'}）${banned.url ? `，页面 ${banned.url}` : ''}`);
      }
      for (const replacement of item.replacements || []) {
        lines.push(`- 自动切换：r/${replacement.from} → r/${replacement.to}`);
      }
      lines.push('');
    }
  }

  lines.push('## 说明', '', '- JSON 报告保留完整原始数据，本文档用于快速查看运行结果。', '');
  return lines.join('\n');
}

// ---- 单板块浏览循环（时长区间 + 阅读比例）----
async function browseSub(page, sub, cfg, rng, scrollTargetRef) {
  const out = { sub, scrollFallbacks: 0, reads: 0, candidates: [] };
  const dwellMs = randInt(rng, cfg.minMinutesPerSub * 60000, cfg.maxMinutesPerSub * 60000);
  const started = Date.now();
  while (Date.now() - started < dwellMs) {
    const sc = await humanScroll(page, rng, null, 'list', cfg.inputMode, scrollTargetRef.current);
    out.scrollFallbacks += sc?.scrollFallbacks || 0;
    const rest = Math.min(randInt(rng, 3000, 8000), dwellMs - (Date.now() - started));
    if (rest > 0) await sleep(rest);
    // 阅读详情（按比例）：只在前 80% 时间预算内做，避免卡尾
    if (chance(rng, cfg.readRatio) && Date.now() - started < dwellMs * 0.8) {
      const reading = await openAndReadPost(page, sub, rng, 45000, cfg.inputMode, scrollTargetRef.current);
      if (reading?.opened) {
        out.reads += 1;
        out.scrollFallbacks += reading.scrollFallbacks || 0;
      }
      await sleep(randInt(rng, 1200, 3200));
    }
  }
  // 收集候选帖（供点赞比例 + 评论定位）
  out.candidates = await collectPostCandidates(page, 12).catch(() => []);
  return out;
}

// ---- 点赞（按候选帖比例）----
async function upvoteByRatio(page, candidates, ratio, rng, voteMode) {
  const upvotedPosts = [];
  let fallbacks = 0;
  if (ratio <= 0) return { upvoted: 0, upvotedPosts, upvoteFallbacks: 0 };
  const targets = candidates.filter(() => chance(rng, ratio));
  for (const post of targets.slice(0, 6)) {
    try {
      const r = await voteOnPostDual(page, post.id, { mode: voteMode, rng });
      if (r.ok) upvotedPosts.push(post);
      if (r.fallback) fallbacks += 1;
      await sleep(randInt(rng, 2000, 4500));
    } catch {
      // 单帖点赞失败不影响整体
    }
  }
  return { upvoted: upvotedPosts.length, upvotedPosts, upvoteFallbacks: fallbacks };
}

// ---- 主流程 ----
async function main() {
  const argv = process.argv.slice(2);
  const configIdx = argv.indexOf('--config');
  if (configIdx < 0 || !argv[configIdx + 1]) throw new Error('缺少 --config <json文件>');
  const raw = JSON.parse(fs.readFileSync(path.resolve(argv[configIdx + 1]), 'utf8'));
  const cfg = parseConfig(raw);
  const rng = cfg.seed != null ? createRng(cfg.seed) : Math.random;
  const startedAt = new Date();
  const manager = new MachineManager({ concurrency: 1, stopStartedProfiles: true });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('收到停止信号，正在关闭 profile...');
    await manager.closeAll();
  };
  process.once('SIGTERM', () => shutdown().finally(() => process.exit(143)));
  process.once('SIGINT', () => shutdown().finally(() => process.exit(130)));

  const results = [];
  emitStatus({ phase: 'start', at: startedAt.toISOString(), config: { target: cfg.target, subMode: cfg.subMode, subCount: cfg.subCount } });
  console.log(`[手动养号] ${startedAt.toLocaleString('zh-CN')}`);
  console.log(`目标: ${cfg.target.type}=${cfg.target.value} | 板块模式: ${cfg.subMode} | 每账号板块数: ${cfg.subCount}`);
  console.log(`时长: ${cfg.minMinutesPerSub}-${cfg.maxMinutesPerSub} 分钟/板块 | 点赞比例 ${Math.round(cfg.upvoteRatio * 100)}% | 阅读比例 ${Math.round(cfg.readRatio * 100)}% | 评论比例 ${Math.round(cfg.commentRatio * 100)}%${cfg.post.enabled ? ` | 发帖: 开(近${cfg.post.lookbackDays}天≤${cfg.post.maxCount}篇)` : ''}${cfg.skipTierGate ? ' | 写操作绕过档位门控(测试模式)' : ''}`);
  console.log('---');

  try {
    const profiles = await manager.resolveProfiles(targetQuery(cfg.target));
    if (!profiles.length) throw new Error('没有匹配的机器');
    console.log(`共 ${profiles.length} 台机器\n`);
    emitStatus({ phase: 'profiles', total: profiles.length });

    for (const profile of profiles) {
      if (shuttingDown) break;
      const label = profile.serial != null ? `serial ${profile.serial}` : profile.id;
      const accKey = profile.serial != null ? `serial:${profile.serial}` : `id:${profile.id}`;
      console.log(`[${label}] ${profile.name}: 开始...`);
      try {
        const machine = await manager.connectMachine(profile.id);
        const page = await manager.getMainPage(machine);
        const info = await extractAccountInfo(page, machine, { skipShadowProbe: true, accountKey: accKey });
        if (!info.loggedIn) {
          console.log(`[${label}] ❌ 登录状态未确认（API 与用户入口均未命中），跳过`);
          results.push({ serial: profile.serial, name: profile.name, profileId: profile.id, status: 'logged_out', error: '未登录' });
          continue;
        }
        const createdDays = parseRedditorFor(info.created);
        const commentKarma = parseKarma(info.commentKarma);
        const assessment = assessTier({ createdDays, commentKarma });
        console.log(`[${label}] ✅ 已登录 u/${info.username}`);

        // 板块选择（可指定多个随机选 / 完全随机）
        const subs = selectSubs(cfg, rng);
        console.log(`[${label}] 板块: ${subs.join(', ')}`);

        const agg = { visited: 0, reads: 0, upvoted: 0, comments: 0, posts: 0, dwellSeconds: 0, challenges: 0, banned: 0, replacementSubs: 0, upvoteFallbacks: 0, scrollFallbacks: 0 };
        const scrollTargetRef = { current: null };
        const pagesVisited = [];
        const bannedSubs = [];
        const replacements = [];
        const bannedSubNames = new Set();
        const remainingSubs = [...subs];
        let returnBannedResult = false;

        while (remainingSubs.length && !shuttingDown) {
          // remainingSubs 中允许出现重复社区：每一项都代表一个独立浏览槽位。
          // 替换只排除已确认 banned 的社区，访问过的可用社区仍可再次使用。
          let sub = remainingSubs.shift();
          let resolved = false;
          while (!resolved && sub) {
            if (bannedSubNames.has(sub)) {
              const replacement = selectReplacementSub(cfg, rng, bannedSubNames, remainingSubs);
              if (!replacement) {
                console.log(`  [${label}] r/${sub}: 已确认 banned，且没有可替换社区`);
                resolved = true;
                continue;
              }
              agg.replacementSubs += 1;
              replacements.push({ from: sub, to: replacement });
              console.log(`  [${label}] r/${sub}: 已确认 banned，替换为 r/${replacement}`);
              sub = replacement;
              continue;
            }
            console.log(`  [${label}] r/${sub}: 进入浏览`);
            const subStart = Date.now();
            try {
              await page.goto(`https://www.reddit.com/r/${encodeURIComponent(sub)}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
              await sleep(randInt(rng, 1500, 3000));
              const banned = await detectBanned(page);
              if (banned.banned) {
                agg.banned += 1;
                bannedSubNames.add(sub);
                bannedSubs.push({ sub, reason: banned.reason, url: banned.url });
                console.log(`  [${label}] r/${sub}: 检测到 banned (${banned.reason || 'unknown'})`);
                if (!canReplaceBannedSub(cfg)) {
                  console.log(`  [${label}] 仅选择了一个社区，保留 banned 结果并返回`);
                  remainingSubs.length = 0;
                  returnBannedResult = true;
                  resolved = true;
                  continue;
                }
                const replacement = selectReplacementSub(cfg, rng, bannedSubNames, remainingSubs);
                if (!replacement) {
                  console.log(`  [${label}] 没有可替换的候选社区，返回 banned 结果`);
                  resolved = true;
                  continue;
                }
                agg.replacementSubs += 1;
                replacements.push({ from: sub, to: replacement });
                console.log(`  [${label}] banned，替换为 r/${replacement}`);
                sub = replacement;
                continue;
              }
              const challenge = await detectChallenge(page);
              if (challenge.challenge) {
                agg.challenges += 1;
                console.log(`  [${label}] r/${sub}: 风控页 (${challenge.challenge})，本轮跳过该板块`);
                resolved = true;
                continue;
              }
              const subRes = await browseSub(page, sub, cfg, rng, scrollTargetRef);
              agg.visited += 1;
              agg.scrollFallbacks += subRes.scrollFallbacks;
              const vote = await upvoteByRatio(page, subRes.candidates, cfg.upvoteRatio, rng, cfg.voteMode);
              agg.upvoted += vote.upvoted;
              agg.upvoteFallbacks += vote.upvoteFallbacks;
              pagesVisited.push({ sub, candidates: subRes.candidates, reads: subRes.reads });
              agg.reads += subRes.reads;

              if (cfg.commentRatio > 0 && cfg.commentBank.length && chance(rng, cfg.commentRatio)) {
                const post = subRes.candidates[randInt(rng, 0, Math.max(0, subRes.candidates.length - 1))];
                if (post && post.href) {
                  const text = fillPlaceholders(cfg.commentBank[randInt(rng, 0, cfg.commentBank.length - 1)], sub);
                  const postUrl = post.href.startsWith('/') ? `https://www.reddit.com${post.href}` : post.href;
                  console.log(`  [${label}] r/${sub}: 自动读取评论规则 Hash...`);
                  const snapshot = await fetchCommunityRules(page, sub);
                  const rule = cfg.commentRules[String(sub).toLowerCase()] || {};
                  console.log(`  [${label}] r/${sub}: 尝试评论 (比例命中) → ${postUrl.slice(0, 80)}`);
                  const r = await runScript('comment.js', [
                    ...targetArgs(profile), '--sub', sub, '--text', text, '--post-url', postUrl,
                    '--rules-ack', snapshot.hash,
                    ...(rule.confirmedUnresolved?.length ? ['--confirm-unresolved', rule.confirmedUnresolved.join(',')] : []),
                    ...(cfg.skipTierGate ? ['--force-tier', 'T2'] : []),
                  ]);
                  agg.comments += r.code === 0 ? 1 : 0;
                  console.log(`  [${label}] r/${sub}: 评论子进程退出码 ${r.code}${r.code === 0 ? '（已发布/通过门控）' : '（被门控拒绝）'}`);
                }
              }
              resolved = true;
            } catch (subError) {
              console.log(`  [${label}] r/${sub}: 访问异常 ${subError.message.slice(0, 80)}`);
              resolved = true;
            }
            agg.dwellSeconds += Math.round((Date.now() - subStart) / 1000);
          }
        }

        // 发帖（账号资格门控由 post.js 内部执行 + 近日发帖频率 + 指定多个社区随机选）
        if (cfg.post.enabled && !shuttingDown && !returnBannedResult) {
          const postState = readPostsState();
          const freqNow = recentPostCount(postState, accKey, cfg.post.lookbackDays);
          const freqOk = freqNow < cfg.post.maxCount;
          console.log(`[${label}] 发帖门控: 近${cfg.post.lookbackDays}天发帖 ${freqNow}/${cfg.post.maxCount} ${freqOk ? '✅' : '⛔'}`);
          if (freqOk) {
            const postSub = cfg.post.subs[randInt(rng, 0, cfg.post.subs.length - 1)];
            const title = fillPlaceholders(cfg.post.title, postSub);
            const text = fillPlaceholders(cfg.post.text, postSub);
            console.log(`[${label}] 尝试发帖 → r/${postSub}（从 ${cfg.post.subs.join(',')} 中随机）`);
            const r = await runScript('post.js', [
              ...targetArgs(profile), '--sub', postSub, '--title', title, '--text', text,
              ...writeRuleArgs(cfg.post.rules, postSub, { flair: true }),
              ...(cfg.skipTierGate ? ['--force-tier', 'T2'] : []),
            ]);
            if (r.code === 0) {
              agg.posts += 1;
              recordPost(postState, accKey);
              console.log(`[${label}] 发帖成功记录 (posts.json)`);
            } else {
              console.log(`[${label}] 发帖被拒（post.js 门控未通过，退出码 ${r.code}）`);
            }
          } else {
            console.log(`[${label}] 跳过发帖（近${cfg.post.lookbackDays}天已达上限）`);
          }
        }

        results.push({
          serial: profile.serial,
          name: profile.name,
          profileId: profile.id,
          status: agg.visited > 0 ? 'done' : (agg.banned > 0 ? 'banned' : 'no_activity'),
          username: info.username,
          commentKarma,
          subs: pagesVisited.map((p) => p.sub),
          visited: agg.visited,
          reads: agg.reads,
          upvoted: agg.upvoted,
          comments: agg.comments,
          posts: agg.posts,
          dwellSeconds: agg.dwellSeconds,
          challenges: agg.challenges,
          banned: agg.banned,
          bannedSubs,
          replacementSubs: agg.replacementSubs,
          replacements,
          upvoteFallbacks: agg.upvoteFallbacks,
          scrollFallbacks: agg.scrollFallbacks,
        });
        console.log(`[${label}] 完成: 浏览 ${agg.visited} 板块 / 阅读 ${agg.reads} 帖 / 点赞 ${agg.upvoted} / 评论 ${agg.comments} / 发帖 ${agg.posts}\n`);
        emitStatus({ phase: 'account', serial: profile.serial, name: profile.name, ...agg, done: results.length, total: profiles.length });
      } catch (error) {
        console.log(`[${label}] ❌ 失败: ${error.message.slice(0, 120)}`);
        results.push({ serial: profile.serial, name: profile.name, profileId: profile.id, status: 'error', error: error.message.slice(0, 200) });
      }
    }
  } finally {
    const cleanup = await manager.closeAll();
    const cleanupFailures = cleanup.filter((item) => item.status === 'rejected');
    if (cleanupFailures.length) console.log(`清理失败 ${cleanupFailures.length} 台`);
    else console.log('Profile 清理: 通过');
  }

  // 报告
  const finishedAt = new Date();
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = finishedAt.toISOString().replace(/[:.]/g, '-');
  const report = {
    task: 'manual-warmup',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    config: cfg,
    results,
    summary: {
      total: results.length,
      ok: results.filter((r) => r.status === 'done').length,
      upvoted: results.reduce((s, r) => s + (r.upvoted || 0), 0),
      reads: results.reduce((s, r) => s + (r.reads || 0), 0),
      comments: results.reduce((s, r) => s + (r.comments || 0), 0),
      posts: results.reduce((s, r) => s + (r.posts || 0), 0),
      banned: results.reduce((s, r) => s + (r.banned || 0), 0),
      replacementSubs: results.reduce((s, r) => s + (r.replacementSubs || 0), 0),
    },
  };
  const reportFile = path.join(REPORT_DIR, `manual-run-${stamp}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  const humanReportFile = writeMdReport(reportFile, renderHumanReport(report));
  console.log(`\nJSON 报告: ${reportFile}`);
  console.log(`可读报告: ${humanReportFile || '生成失败（JSON 报告不受影响）'}`);
  emitStatus({ phase: 'done', ok: true, reportFile, humanReportFile, summary: report.summary });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[手动养号] 启动失败: ${error.message}`);
    emitStatus({ phase: 'error', ok: false, error: error.message });
    process.exit(1);
  });
}

module.exports = {
  selectSubs,
  classifyBannedPage,
  detectBanned,
  selectReplacementSub,
  canReplaceBannedSub,
  renderHumanReport,
  targetArgs,
  writeRuleArgs,
  fetchRuleSnapshots,
};
