#!/usr/bin/env node
'use strict';
/**
 * runner.js — 手动控制版 Reddit 养号执行器
 *
 * 由 server.js 以子进程方式启动，参数通过 --config <json文件> 传入。
 * 复用 reddit-warmup-skills 引擎：MachineManager（AdsPower 连接）、
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

// ---- 复用 reddit-warmup-skills 引擎（绝对路径 require，避免 cwd 假设）----
const SKILLS_ROOT = path.resolve(__dirname, '..', '..', 'reddit-warmup-skills', 'reddit-warmup');
const { loadAdsModules } = require(path.join(SKILLS_ROOT, 'lib', 'resolve-ads'));
const { machineManager } = loadAdsModules();
const { MachineManager } = machineManager;
const { extractAccountInfo } = require(path.join(SKILLS_ROOT, 'scripts', 'healthcheck'));
const { assessTier, parseRedditorFor, parseKarma } = require(path.join(SKILLS_ROOT, 'scripts', 'assess-risk'));
const { POST_TIER_ALLOWED } = require(path.join(SKILLS_ROOT, 'scripts', 'post'));
const {
  collectPostCandidates,
  openAndReadPost,
  detectChallenge,
  humanScroll,
  SUB_POOL,
} = require(path.join(SKILLS_ROOT, 'scripts', 'warmup'));
const { voteOnPostDual } = require(path.join(SKILLS_ROOT, 'lib', 'upvote'));
const { createRng, randInt, shuffle, chance } = require(path.join(SKILLS_ROOT, 'lib', 'rng'));
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

// ---- 子进程写操作（复用源仓库完整门控）----
function runScript(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SKILLS_ROOT, 'scripts', script), ...args], {
      cwd: SKILLS_ROOT,
      stdio: 'inherit',
    });
    child.on('close', (code) => resolve({ code, script }));
  });
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

// ---- 随机选板块 ----
function selectSubs(cfg, rng) {
  if (cfg.subMode === 'random') {
    return shuffle(rng, SUB_POOL).slice(0, cfg.subCount);
  }
  return shuffle(rng, cfg.subs).slice(0, Math.min(cfg.subCount, cfg.subs.length));
}

/** 替换评论/帖子文本里的 {sub} 占位符 */
function fillPlaceholders(text, sub) {
  return String(text).replace(/\{sub\}/g, sub).replace(/\{r\/\{sub\}\}/g, `r/${sub}`);
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
  console.log(`时长: ${cfg.minMinutesPerSub}-${cfg.maxMinutesPerSub} 分钟/板块 | 点赞比例 ${Math.round(cfg.upvoteRatio * 100)}% | 阅读比例 ${Math.round(cfg.readRatio * 100)}% | 评论比例 ${Math.round(cfg.commentRatio * 100)}%${cfg.post.enabled ? ` | 发帖: 开(近${cfg.post.lookbackDays}天≤${cfg.post.maxCount}篇)` : ''}`);
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
        console.log(`[${label}] ✅ 已登录 u/${info.username} | karma ${commentKarma ?? '?'} | 档位 ${assessment.tier} (${assessment.reason})`);

        // 板块选择（可指定多个随机选 / 完全随机）
        const subs = selectSubs(cfg, rng);
        console.log(`[${label}] 板块: ${subs.join(', ')}`);

        const agg = { visited: 0, reads: 0, upvoted: 0, comments: 0, posts: 0, dwellSeconds: 0, challenges: 0, upvoteFallbacks: 0, scrollFallbacks: 0 };
        const scrollTargetRef = { current: null };
        const pagesVisited = [];

        for (const sub of subs) {
          if (shuttingDown) break;
          console.log(`  [${label}] r/${sub}: 进入浏览`);
          const subStart = Date.now();
          try {
            await page.goto(`https://www.reddit.com/r/${encodeURIComponent(sub)}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await sleep(randInt(rng, 1500, 3000));
            const challenge = await detectChallenge(page);
            if (challenge.challenge) {
              agg.challenges += 1;
              console.log(`  [${label}] r/${sub}: 风控页 (${challenge.challenge})，本轮跳过该板块`);
              continue;
            }
            const subRes = await browseSub(page, sub, cfg, rng, scrollTargetRef);
            agg.visited += 1;
            agg.reads += subRes.reads;
            agg.scrollFallbacks += subRes.scrollFallbacks;
            // 点赞比例
            const vote = await upvoteByRatio(page, subRes.candidates, cfg.upvoteRatio, rng, cfg.voteMode);
            agg.upvoted += vote.upvoted;
            agg.upvoteFallbacks += vote.upvoteFallbacks;
            pagesVisited.push({ sub, candidates: subRes.candidates, reads: subRes.reads });

            // 评论比例：以该板块为一个"评论机会"，按概率挑一条评论库内容执行
            if (cfg.commentRatio > 0 && cfg.commentBank.length && chance(rng, cfg.commentRatio)) {
              const post = subRes.candidates[randInt(rng, 0, Math.max(0, subRes.candidates.length - 1))];
              if (post && post.href) {
                const text = fillPlaceholders(cfg.commentBank[randInt(rng, 0, cfg.commentBank.length - 1)], sub);
                const postUrl = post.href.startsWith('/') ? `https://www.reddit.com${post.href}` : post.href;
                console.log(`  [${label}] r/${sub}: 尝试评论 (比例命中) → ${postUrl.slice(0, 80)}`);
                const r = await runScript('comment.js', ['--serial', String(profile.serial), '--sub', sub, '--text', text, '--post-url', postUrl]);
                agg.comments += r.code === 0 ? 1 : 0;
                console.log(`  [${label}] r/${sub}: 评论子进程退出码 ${r.code}${r.code === 0 ? '（已发布/通过门控）' : '（被门控拒绝）'}`);
              }
            }
          } catch (subError) {
            console.log(`  [${label}] r/${sub}: 访问异常 ${subError.message.slice(0, 80)}`);
          }
          agg.dwellSeconds += Math.round((Date.now() - subStart) / 1000);
        }

        // 发帖（档位 + 近日发帖频率 + 指定多个社区随机选）
        if (cfg.post.enabled && !shuttingDown) {
          const tierOk = Boolean(POST_TIER_ALLOWED[assessment.tier]);
          const postState = readPostsState();
          const freqNow = recentPostCount(postState, accKey, cfg.post.lookbackDays);
          const freqOk = freqNow < cfg.post.maxCount;
          console.log(`[${label}] 发帖门控: 档位 ${assessment.tier} ${tierOk ? '✅' : '⛔'} | 近${cfg.post.lookbackDays}天发帖 ${freqNow}/${cfg.post.maxCount} ${freqOk ? '✅' : '⛔'}`);
          if (tierOk && freqOk) {
            const postSub = cfg.post.subs[randInt(rng, 0, cfg.post.subs.length - 1)];
            const title = fillPlaceholders(cfg.post.title, postSub);
            const text = fillPlaceholders(cfg.post.text, postSub);
            console.log(`[${label}] 尝试发帖 → r/${postSub}（从 ${cfg.post.subs.join(',')} 中随机）`);
            const r = await runScript('post.js', ['--serial', String(profile.serial), '--sub', postSub, '--title', title, '--text', text]);
            if (r.code === 0) {
              agg.posts += 1;
              recordPost(postState, accKey);
              console.log(`[${label}] 发帖成功记录 (posts.json)`);
            } else {
              console.log(`[${label}] 发帖被拒（post.js 门控未通过，退出码 ${r.code}）`);
            }
          } else {
            console.log(`[${label}] 跳过发帖（门控未满足）`);
          }
        }

        results.push({
          serial: profile.serial,
          name: profile.name,
          profileId: profile.id,
          status: agg.visited > 0 ? 'done' : 'no_activity',
          tier: assessment.tier,
          reason: assessment.reason,
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
    },
  };
  const reportFile = path.join(REPORT_DIR, `manual-run-${stamp}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(`\n报告: ${reportFile}`);
  emitStatus({ phase: 'done', ok: true, reportFile, summary: report.summary });
}

main().catch((error) => {
  console.error(`[手动养号] 启动失败: ${error.message}`);
  emitStatus({ phase: 'error', ok: false, error: error.message });
  process.exit(1);
});
