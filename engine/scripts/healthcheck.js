#!/usr/bin/env node
/**
 * reddit-healthcheck.js — Reddit 账号批量巡检
 *
 * 对指定 AdsPower 机器(serial 或 profile id)执行 Reddit 账号健康检查:
 *   1. 登录状态 (已登录/未登录)
 *   2. 用户名 (通过 /user/<name>/communities 特征精确定位, 排除广告链接)
 *   3. karma (link + comment)
 *   4. 账号年龄
 *
 * 用法:
 *   node scripts/healthcheck.js --serial 4,5,6,7
 *   node scripts/healthcheck.js --profiles id1,id2
 *   node scripts/healthcheck.js --group Reddit
 *
 * 报告与回放:
 *   每次运行写入 reports/healthcheck-*.json; 自动读取最近一份做
 *   shadowban 判定历史对比 (翻转率统计, 用于评估误报率)。
 */
const { loadAdsModules } = require('../lib/resolve-ads');
const { machineManager, pageActions } = loadAdsModules();
const { MachineManager } = machineManager;
const actions = pageActions;
const fs = require('fs');
const path = require('path');
const { BLOCKED, ENV_ERROR } = require('../lib/exit-codes');
const { getCached: getCachedShadow, setCached: setCachedShadow, shouldSkip } = require('../lib/shadowban');
const { emitJSON } = require('../lib/jsonout');
const { waitForRedditAccountLoad } = require('../lib/reddit-account-load');

const REPORT_DIR = path.join(__dirname, '..', 'reports');
const EVIDENCE_DIR = path.join(REPORT_DIR, 'evidence');

// E3: shadowban 判定命中现场截图（只读，失败不阻塞巡检）
// 存 reports/evidence/<serial>-<ts>-shadowban.png，结果对象 evidence 记相对路径。
async function captureShadowEvidence(page, serial) {
  try {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const filename = `${serial ?? 'unknown'}-${Date.now()}-shadowban.png`;
    const abs = path.join(EVIDENCE_DIR, filename);
    await actions.screenshot(page, abs);
    return path.relative(REPORT_DIR, abs);
  } catch {
    return null; // E3 仅事后复核用，截图失败不阻塞主流程
  }
}

// 人类可读日志：--json 模式下必须走 stderr（协议：JSON 独占 stdout，管道解析才干净）
function log(...args) {
  if (global.__healthcheckJsonMode) {
    console.error(...args);
  } else {
    console.log(...args);
  }
}

function healthcheckExitCode(results, cleanupFailures = []) {
  if (cleanupFailures.length || results.some((item) => item.status === 'env_error')) return ENV_ERROR;
  return results.every((item) => item.status === 'healthy') ? 0 : BLOCKED;
}

// 读取每个账号最近一次巡检结果，而非只读最近一个批次。
// 分批巡检的相邻报告通常包含不同账号；只读最后一份会导致 comparable≈0。
function loadLastHealthcheckReport() {
  if (!fs.existsSync(REPORT_DIR)) return null;
  const files = fs.readdirSync(REPORT_DIR)
    .filter((f) => /^healthcheck-.*\.json$/.test(f))
    .sort()
    .reverse();
  if (!files.length) return null;
  const map = {};
  const sources = {};
  let newestAt = null;
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(REPORT_DIR, file), 'utf8'));
      if (!newestAt) newestAt = data.finishedAt || data.startedAt || null;
      for (const result of data.results || []) {
        if (result.serial == null || map[String(result.serial)]) continue;
        map[String(result.serial)] = result;
        sources[String(result.serial)] = file;
      }
    } catch {
      // 损坏的历史报告跳过，不影响其他账号回放。
    }
  }
  return Object.keys(map).length
    ? { file: 'per-account-latest', at: newestAt, map, sources }
    : null;
}

// 对比当前结果与历史: 统计 shadowban 判定翻转与变化。
function compareShadowHistory(currentResults, history) {
  if (!history) return null;
  const flips = [];
  const changes = [];
  for (const r of currentResults) {
    if (r.serial == null || r.shadowbanned == null) continue;
    const old = history.map[String(r.serial)];
    if (!old || old.shadowbanned == null) continue;
    if (old.shadowbanned !== r.shadowbanned) {
      flips.push({ serial: r.serial, name: r.name, was: old.shadowbanned, now: r.shadowbanned });
    }
  }
  const comparable = currentResults.filter((r) => {
    if (r.serial == null) return false;
    const old = history.map[String(r.serial)];
    return old && old.shadowbanned != null;
  }).length;
  return { comparedWith: history.file, at: history.at, comparable, flips, flipRate: comparable ? flips.length / comparable : 0 };
}

// 通过 /api/me.json 获取当前登录用户（权威登录态 + 账号元数据）。
// - 已登录: HTTP 200 且 data.name 非空 → { ok: true, name, linkKarma, commentKarma, created, isSuspended }
// - 未登录: 401/403 或 data 为空 → { ok: false, name: null }
// - 网络/解析异常 → { ok: false, name: null }（不抛错，交给 DOM 降级）
// 注意: 不能用 /api/v1/me（只返回 features 列表，无 name 字段）。
// 2026-08-14 扩展: data.created（Unix 秒）/link_karma/comment_karma/is_suspended
// 一并返回——比用户主页 DOM 文本解析权威（serial 4 实测主页文本抓不到 karma，
// API 字段齐全），assess-risk 据此可算出真实档位，并能直接暴露封禁状态。
async function fetchMeJson(page) {
  try {
    return await page.evaluate(async () => {
      const res = await fetch('/api/me.json', {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        return { ok: false, name: null, status: res.status, linkKarma: null, commentKarma: null, created: null, isSuspended: null };
      }
      const data = await res.json();
      const d = data?.data || {};
      const name = d.name || null;
      return {
        ok: Boolean(name),
        name,
        status: res.status,
        linkKarma: typeof d.link_karma === 'number' ? d.link_karma : null,
        commentKarma: typeof d.comment_karma === 'number' ? d.comment_karma : null,
        created: typeof d.created === 'number' ? d.created : null, // Unix 秒
        isSuspended: typeof d.is_suspended === 'boolean' ? d.is_suspended : null,
      };
    });
  } catch {
    return { ok: false, name: null, status: -1, linkKarma: null, commentKarma: null, created: null, isSuspended: null }; // API 不可用 → DOM 降级
  }
}

// 登录判定纯函数（导出供单测）：
// API 优先：401/403 是权威未登录；API 临时异常时才允许 DOM 兜底；
// API 临时异常且 DOM 无用户入口 → unknown，不冒充未登录。
// @param {{api: {ok: boolean, name: string|null, status?: number}, dom: {communities: string|null, header: string|null}}}
// @returns {{loggedIn: boolean, state: 'logged_in'|'logged_out'|'unknown', username: string|null, source: 'api'|'dom'|null}}
function resolveLogin({ api, dom }) {
  if (api && api.ok && api.name) {
    return { loggedIn: true, state: 'logged_in', username: api.name, source: 'api' };
  }
  const status = Number(api?.status);
  // 401/403 明确表示会话未认证，不能被旧 DOM 链接覆盖。
  if (status === 401 || status === 403) {
    return { loggedIn: false, state: 'logged_out', username: null, source: 'api' };
  }
  const domHref = (dom && (dom.communities || dom.header)) || null;
  const match = domHref ? domHref.match(/\/user\/([^/]+)/) : null;
  if (match) {
    return { loggedIn: true, state: 'logged_in', username: match[1], source: 'dom' };
  }
  // -1、429、5xx 等属于暂时无法确认，不应归类为已退出。
  return { loggedIn: false, state: 'unknown', username: null, source: null };
}

// 把 Unix 秒注册时间转成 parseRedditorFor 可解析的"X 天"文本（≥1 天），不足 1 天按 1。
function createdDaysText(unixSec) {
  if (typeof unixSec !== 'number' || !Number.isFinite(unixSec)) return null;
  const days = Math.floor((Date.now() / 1000 - unixSec) / 86400);
  return days >= 1 ? `${days} 天` : '1 天';
}

// 从页面 DOM 精确定位登录用户名。
// 不能用 /api/v1/me (只返回 features), 也不能直接找 /user/ 链接 (会抓到推广广告)。
// 登录用户的可靠特征是存在 /user/<name>/communities 的"管理社区"入口。
//
// 2026-08-14 修复（serial 4 真实验收发现）：
//   新版 shreddit 首页用户入口懒加载——/user/<name>/communities 入口不在首页、
//   header/[data-testid="user-avatar"]/faceplate-dropdown-menu 内无 /user/ 链接，
//   纯 DOM 检测会把已登录账号误判为未登录（实测 /api/me.json 返回 name 而 DOM 全空）。
//   修复：登录判定改为 API 优先（/api/me.json 权威、健壮），DOM 检测降级兜底。
async function extractAccountInfo(page, machine, opts = {}) {
  const { skipShadowProbe = false, forceShadowProbe = false, accountKey = null } = opts;
  await actions.goto(page, 'https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await waitForRedditAccountLoad(page);

  // ---- 登录判定：API 优先 + DOM 降级 ----
  // 1) /api/me.json 是权威登录态（200 + data.name）；2) 失败/未登录时回退 DOM 锚点
  // （保留旧逻辑作为降级路径，兼顾旧版 UI 与 API 异常场景）。
  const api = await fetchMeJson(page);
  const dom = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a')];
    const isPromoted = (a) => !!a.closest('.promoted-name-container, [class*="advertiser"]')
      || /advertiser/i.test(a.getAttribute('class') || '');
    const comm = links.find((a) => /\/user\/[^/]+\/communities/.test(a.getAttribute('href') || '') && !isPromoted(a));
    const header = links.find((a) => {
      const href = a.getAttribute('href') || '';
      return /\/user\/[^/]+\/?$/.test(href) && !isPromoted(a)
        && a.closest('header, [data-testid="user-avatar"], faceplate-dropdown-menu');
    });
    return {
      communities: comm?.getAttribute('href') || null,
      header: header?.getAttribute('href') || null,
      hasLoginLink: links.some((a) => /login/.test(a.getAttribute('href') || '')),
    };
  });

  // 纯函数判定（导出供单测）：API 优先，DOM 兜底，均无 → 未登录
  const login = resolveLogin({ api, dom });
  if (!login.loggedIn) {
    return { loggedIn: false, loginState: login.state, username: null, hasLoginLink: dom.hasLoginLink };
  }
  const username = login.username;

  // 账号元数据：API（/api/me.json）权威优先，DOM 主页文本解析降级补齐缺失字段。
  // 2026-08-14 修复：serial 4 实测主页文本抓不到 karma/注册时间（新版 UI 文本变化），
  // 而 /api/me.json 字段齐全——link_karma/comment_karma/created 直接可用。
  let linkKarma = api.linkKarma ?? null;
  let commentKarma = api.commentKarma ?? null;
  let created = createdDaysText(api.created);
  try {
    await actions.goto(page, `https://www.reddit.com/user/${username}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForTimeout(3000);
    const profile = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const link = text.match(/link karma\s*[:：]?\s*([\d,\.]+[km]?)/i);
      const comment = text.match(/comment karma\s*[:：]?\s*([\d,\.]+[km]?)/i);
      const cake = text.match(/redditor for\s*([^\n]+)/i)
        // 中文 UI: 值在标签前 ("2 周\nReddit 资历")
        || text.match(/([\d.]+\s*(?:年|个月|周|天))\s*\n\s*reddit\s*资历/i);
      return { link: link?.[1] || null, comment: comment?.[1] || null, cake: cake?.[1] || null };
    });
    // 仅当 API 缺字段时用 DOM 文本补齐（API 是权威，不覆盖）
    if (linkKarma == null && profile.link != null) linkKarma = profile.link;
    if (commentKarma == null && profile.comment != null) commentKarma = profile.comment;
    if (created == null && profile.cake != null) created = profile.cake;
  } catch {
    // 用户主页抓取失败不影响登录判断（API 元数据已兜底）
  }

  if (api.isSuspended === true) {
    return {
      loggedIn: true, username, hasLoginLink: dom.hasLoginLink,
      linkKarma, commentKarma, created, isSuspended: true,
      shadowbanned: null, shadowSource: 'skipped-suspended',
    };
  }

  // Shadowban 检测（P2-6 校准修复）:
  // 旧方案用无痕 context（裸 Chromium 无指纹/代理）访问主页，会被 Reddit 网络层
  // 风控拦截（返回非标准响应），导致系统性误报——实测 4/4 账号误判 shadowban，
  // 真实浏览器（带 AdsPower 指纹+登录态）主页全部正常。
  //
  // 新方案：直接在真实 profile 浏览器（已登录 + 指纹 + 代理）内访问用户主页判定。
  // shadowban 的核心特征是"登录用户打开自己的主页，帖子区对他人不可见"——
  // 登录态下若页面显示 "this content is not available" 或内容区为空，才是真 shadowban。
  // 真实浏览器流量带指纹，不会被网络层误拦，判定可靠。
  //
  // P0-6 缓存策略保留：daily 等高频调用传 skipShadowProbe=true 读缓存(24h)。
  let shadowbanned = null;
  const cacheKey = accountKey;
  if (skipShadowProbe && cacheKey && !forceShadowProbe) {
    const cached = getCachedShadow(cacheKey);
    if (cached && cached.shadowbanned !== undefined && cached.shadowbanned !== null) {
      shadowbanned = cached.shadowbanned;
      // 标记来源，便于调用方区分"缓存判定"与"本次实测"
      return { loggedIn: true, username, hasLoginLink: dom.hasLoginLink, linkKarma, commentKarma, created, isSuspended: api.isSuspended ?? null, shadowbanned, shadowSource: 'cache' };
    }
  }
  try {
    // 复用已打开的登录页面（刚抓完 karma），直接判定主页可见性
    const probeInfo = await page.evaluate((uname) => {
      const text = document.body?.innerText?.toLowerCase() || '';
      const hasKarma = text.includes('karma') || text.includes('redditor for') || text.includes('cakeday');
      const hasProfileChrome = text.includes('overview') || text.includes('posts') || text.includes('comments');
      const profileLoaded = hasKarma || hasProfileChrome;
      return {
        // 真 shadowban 特征：登录态下主页仍显示"内容不可用"
        unavailable: text.includes('this content is not available') || text.includes('page not found'),
        // 主页正常特征：有用户资料骨架（Overview/Posts/Comments/karma）
        looksLikeProfile: profileLoaded,
        // 内容区为空（真 shadowban 时登录用户看自己主页也是空的）
        empty: (document.body?.innerText || '').trim().length < 200,
        hasUsername: uname ? new RegExp(`${uname.toLowerCase()}`).test(text) : false,
      };
    }, username);
    // 判定逻辑（真实浏览器，无网络层拦截干扰）：
    //   - unavailable → 真 shadowban
    //   - 页面连用户资料骨架都没有 → 可疑（真 shadowban 或页面异常）
    //   - 正常显示用户资料 → 非 shadowban
    shadowbanned = probeInfo.unavailable || (!probeInfo.looksLikeProfile && probeInfo.empty);
    // 实测结果写缓存（P0-6）
    if (cacheKey) {
      setCachedShadow(cacheKey, shadowbanned, shadowbanned ? 'probe' : null);
    }
  } catch {
    shadowbanned = null; // 探测失败不阻塞主流程（判定置 null 表示不可用）
  }

  return { loggedIn: true, username, hasLoginLink: dom.hasLoginLink, linkKarma, commentKarma, created, isSuspended: api.isSuspended ?? null, shadowbanned, shadowSource: 'probe' };
}

function parseArgs(argv) {
  const options = {
    profileIds: [], serialNumbers: [], groupName: undefined,
    concurrency: 2, json: false, stopStarted: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--serial') {
      options.serialNumbers.push(...String(argv[++index] ?? '').split(','));
    } else if (arg === '--profiles') {
      options.profileIds.push(...String(argv[++index] ?? '').split(','));
    } else if (arg === '--group') {
      options.groupName = argv[++index];
    } else if (arg === '--concurrency') {
      options.concurrency = Number(argv[++index]);
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--stop-started') {
      options.stopStarted = true;
    } else if (arg === '--keep-open') {
      options.stopStarted = false;
    } else if (arg.startsWith('--')) {
      throw new Error(`未知参数: ${arg}`);
    } else {
      options.profileIds.push(arg);
    }
  }
  if (!options.profileIds.length && !options.serialNumbers.length && !options.groupName) {
    throw new Error('请通过 --serial N,M / --profiles id1,id2 / --group NAME 选择机器');
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('--concurrency 必须是大于 0 的整数');
  }
  return options;
}

async function mapWithConcurrency(items, concurrency, iteratee) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await iteratee(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  global.__healthcheckJsonMode = options.json; // log() 据此分流 stdout/stderr
  const manager = new MachineManager({
    concurrency: options.concurrency,
    stopStartedProfiles: options.stopStarted,
  });
  let shuttingDown = false;
  let cleanupDone = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${signal}，正在关闭本轮启动的 AdsPower profiles...`);
    const settled = await manager.closeAll();
    const failed = settled.filter((item) => item.status === 'rejected').length;
    process.exitCode = failed ? ENV_ERROR : 128 + (signal === 'SIGINT' ? 2 : 15);
  };
  const onSigint = () => { shutdown('SIGINT').finally(() => process.exit()); };
  const onSigterm = () => { shutdown('SIGTERM').finally(() => process.exit()); };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  try {
    const profiles = await manager.resolveProfiles(options);
    if (!profiles.length) throw new Error('没有匹配的机器');

    log(`巡检 ${profiles.length} 台机器，并发上限 ${options.concurrency}...\n`);
    const results = await mapWithConcurrency(profiles, options.concurrency, async (profile) => {
      const label = profile.serial ? `serial ${profile.serial}` : profile.id;
      try {
        const machine = await manager.connectMachine(profile.id);
        const page = await manager.getMainPage(machine);
        // healthcheck 是显式巡检：做完整探测并写缓存（供 daily 等高频调用复用）
        const accKey = profile.serial != null ? `serial:${profile.serial}` : `id:${profile.id}`;
        const info = await extractAccountInfo(page, machine, { accountKey: accKey });
        const shadow = info.shadowbanned == null ? '' : (info.shadowbanned ? ' | ⚠️ SHADOWBAN' : ' | ✅ 正常可见');
        const susp = info.isSuspended === true ? ' | ⛔ SUSPENDED(被封禁)' : '';
        log(`[${label}] ${profile.name}: ${info.loggedIn ? '✅ 已登录 u/' + info.username : info.loginState === 'unknown' ? '⚠️ 登录状态未知' : '❌ 未登录'}` +
          (info.linkKarma != null ? ` | link ${info.linkKarma}` : '') +
          (info.commentKarma != null ? ` | comment ${info.commentKarma}` : '') +
          (info.created ? ` | ${info.created}` : '') + shadow + susp);
        const status = info.loginState === 'unknown'
          ? 'login_unknown'
          : !info.loggedIn
            ? 'logged_out'
            : info.isSuspended === true
            ? 'suspended'
            : info.shadowbanned === true
              ? 'shadowbanned'
              : info.shadowbanned === false
                ? 'healthy'
                : 'probe_unknown';
        // E3: shadowban 命中 → 主页现场截图留档（事后复核证据）
        const evidence = [];
        if (info.shadowbanned === true) {
          const ev = await captureShadowEvidence(page, profile.serial);
          if (ev) evidence.push(ev);
        }
        return { serial: profile.serial, name: profile.name, profileId: profile.id, ...info, status, evidence };
      } catch (error) {
        log(`[${label}] ${profile.name}: ❌ 检查失败 - ${error.message.slice(0, 80)}`);
        return {
          serial: profile.serial,
          profileId: profile.id,
          label,
          name: profile.name,
          loggedIn: false,
          status: 'env_error',
          evidence: [],
          error: error.message,
        };
      }
    });

    const ok = results.filter((r) => r.loggedIn).length;
    log(`\n汇总: ${ok}/${results.length} 已登录`);

    // 历史回放对比: 必须在写新报告之前读取, 否则会和自己比
    const history = loadLastHealthcheckReport();
    const diff = compareShadowHistory(results, history);

    // 持久化报告 (供下次历史回放对比)
    const report = {
      task: 'reddit-healthcheck',
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      results,
    };
    try {
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      const stamp = `${new Date().toISOString().replace(/[:.T]/g, '-').replace(/Z$/, '')}-${process.pid}`;
      fs.writeFileSync(path.join(REPORT_DIR, `healthcheck-${stamp}.json`), JSON.stringify(report, null, 2));
    } catch {
      // 报告写入失败不阻塞主流程
    }

    if (diff) {
      log(`\n历史对比 (${diff.comparedWith} @ ${diff.at}):`);
      if (!diff.flips.length) {
        log(`  ${diff.comparable} 个账号 shadowban 判定无变化 (翻转率 0%)`);
      } else {
        for (const f of diff.flips) {
          log(`  ⚠ [serial ${f.serial}] ${f.name}: ${f.was ? 'SHADOWBAN' : '正常'} → ${f.now ? 'SHADOWBAN' : '正常'}`);
        }
        log(`  翻转率 ${(diff.flipRate * 100).toFixed(1)}% (${diff.flips.length}/${diff.comparable}) — 需人工复核`);
      }
    }

    const cleanupResults = await manager.closeAll();
    cleanupDone = true;
    const cleanupFailures = cleanupResults.filter((item) => item.status === 'rejected');
    if (cleanupFailures.length) {
      log(`关闭失败: ${cleanupFailures.length} 个 profile 未确认停止`);
    }
    const exitCode = healthcheckExitCode(results, cleanupFailures);

    if (options.json) {
      emitJSON({
        results: {
          ok: exitCode === 0,
          accounts: results,
          historyCompare: diff,
          cleanup: {
            ok: cleanupFailures.length === 0,
            failed: cleanupFailures.length,
          },
        },
        script: 'healthcheck',
        exitCode,
        startedAt,
        args: {
          serials: options.serialNumbers,
          profiles: options.profileIds,
          group: options.groupName,
          concurrency: options.concurrency,
          stopStarted: options.stopStarted,
        },
      });
      process.exitCode = exitCode;
      return;
    }
    process.exitCode = exitCode;
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    if (!shuttingDown && !cleanupDone) await manager.closeAll();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('出错:', error.message);
    process.exitCode = ENV_ERROR;
  });
}

module.exports = { extractAccountInfo, fetchMeJson, resolveLogin, createdDaysText, healthcheckExitCode, parseArgs, mapWithConcurrency };
