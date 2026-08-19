#!/usr/bin/env node
/**
 * reddit-warmup.js — Reddit 全自动养号脚本 (无人值守版)
 *
 * 完整自动化流程, 不需要人工介入:
 *   1. 自动连接机器, 检测登录状态 (未登录自动跳过并记录)
 *   2. 自动检测验证码/风控页面, 遇到则等待重试, 多次失败则跳过
 *   3. 从板块池随机挑选本次目标 (避免每天同样的行为模式)
 *   4. 访问 subreddit, 随机滚动浏览, 模拟真人阅读节奏
 *   5. 随机点赞 1-3 个帖子 (只 upvote, 不评论不关注)
 *   6. 单台失败自动重试 (可配次数)
 *   7. 输出 JSON 报告到 reports/ 目录
 *
 * 安全边界: 不发布内容, 不评论, 不关注, 不私信。只浏览 + 点赞。
 *
 * 用法:
 *   node examples/reddit-warmup.js --serial 4,5,6,7
 *   node examples/reddit-warmup.js --group Reddit
 *   node examples/reddit-warmup.js --serial 4,5,6,7 --subs ecommerce,AmazonSeller --retries 2
 *   node examples/reddit-warmup.js --serial 4,5,6,7 --min-subs 2 --max-subs 4
 */
const fs = require('fs');
const path = require('path');
const { loadAdsModules } = require('../lib/resolve-ads');
const { machineManager, pageActions } = loadAdsModules();
const { MachineManager } = machineManager;
const { writeMdReport, upvoteLines } = require('../lib/md-report');
const { ENV_ERROR } = require('../lib/exit-codes');
const { waitForRedditAccountLoad } = require('../lib/reddit-account-load');
const { fetchMeJson, resolveLogin } = require('./healthcheck');
const actions = pageActions;

// 养号板块池 (Amazon/e-commerce 相关)
const SUB_POOL = [
  'AmazonSeller',
  'FulfillmentByAmazon',
  'ecommerce',
  'AmazonFBA',
  'Entrepreneur',
  'smallbusiness',
  'AmazonSellerCentral',
  'AmazonWFS',
  'FBA',
  'amazonfbahelp',
  'Shopify',
  'dropshipping',
  'logistics',
  'supplychain',
  'AmazonPrime',
];

function parseArgs(argv) {
  const options = {
    profileIds: [],
    serialNumbers: [],
    groupName: undefined,
    subs: [],
    minSubs: 2,
    maxSubs: 4,
    retries: 2,
    minUpvotes: 1,
    maxUpvotes: 3,
    minSecondsPerSub: 120,
    maxSecondsPerSub: 240,
    seed: null, // P2-6: --seed 可复现（同 seed 运行结果一致，实验可回溯）
    inputMode: 'wheel', // E1: wheel|legacy（默认 wheel；异常自动降级 legacy）
    voteMode: 'click-first', // E2: click-first|api-only|mixed（mixed 默认关，A/B 验证后再开）
    reportDir: path.join(__dirname, '..', 'reports'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--serial') {
      options.serialNumbers.push(...String(argv[++index] ?? '').split(','));
    } else if (arg === '--profiles') {
      options.profileIds.push(...String(argv[++index] ?? '').split(','));
    } else if (arg === '--group') {
      options.groupName = argv[++index];
    } else if (arg === '--subs') {
      options.subs = String(argv[++index] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--min-subs') {
      options.minSubs = Number(argv[++index]);
    } else if (arg === '--max-subs') {
      options.maxSubs = Number(argv[++index]);
    } else if (arg === '--retries') {
      options.retries = Number(argv[++index]);
    } else if (arg === '--min-upvotes') {
      options.minUpvotes = Number(argv[++index]);
    } else if (arg === '--max-upvotes') {
      options.maxUpvotes = Number(argv[++index]);
    } else if (arg === '--min-seconds-per-sub') {
      options.minSecondsPerSub = Number(argv[++index]);
    } else if (arg === '--max-seconds-per-sub') {
      options.maxSecondsPerSub = Number(argv[++index]);
    } else if (arg === '--seed') {
      options.seed = Number(argv[++index]);
    } else if (arg === '--input-mode') {
      options.inputMode = argv[++index];
    } else if (arg === '--vote-mode') {
      options.voteMode = argv[++index];
    } else if (arg.startsWith('--')) {
      throw new Error(`未知参数: ${arg}`);
    } else {
      options.profileIds.push(arg);
    }
  }
  if (!options.profileIds.length && !options.serialNumbers.length && !options.groupName) {
    throw new Error('请通过 --serial N,M / --profiles id1,id2 / --group NAME 选择机器');
  }
  if (!Number.isInteger(options.minSubs) || options.minSubs < 1) {
    throw new Error('--min-subs 必须是大于 0 的整数');
  }
  if (!Number.isInteger(options.maxSubs) || options.maxSubs < options.minSubs) {
    throw new Error('--max-subs 必须是大于等于 --min-subs 的整数');
  }
  if (!Number.isInteger(options.retries) || options.retries < 0) {
    throw new Error('--retries 必须是非负整数');
  }
  if (!Number.isInteger(options.minUpvotes) || options.minUpvotes < 0) {
    throw new Error('--min-upvotes 必须是非负整数');
  }
  if (!Number.isInteger(options.maxUpvotes) || options.maxUpvotes < options.minUpvotes) {
    throw new Error('--max-upvotes 必须是大于等于 --min-upvotes 的整数');
  }
  if (!Number.isInteger(options.minSecondsPerSub) || options.minSecondsPerSub < 30) {
    throw new Error('--min-seconds-per-sub 必须是 >= 30 的整数 (建议 120+, 模拟真人浏览节奏)');
  }
  if (!Number.isInteger(options.maxSecondsPerSub) || options.maxSecondsPerSub < options.minSecondsPerSub) {
    throw new Error('--max-seconds-per-sub 必须是大于等于 --min-seconds-per-sub 的整数');
  }
  if (!['wheel', 'legacy'].includes(options.inputMode)) {
    throw new Error('--input-mode 必须是 wheel 或 legacy');
  }
  if (!['click-first', 'api-only', 'mixed'].includes(options.voteMode)) {
    throw new Error('--vote-mode 必须是 click-first、api-only 或 mixed');
  }
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
// P2-3/P2-6: 可播种 RNG + 真人行为分布（对数正态替代均匀分布）
const { createRng, lognormalInt, randInt, shuffle, chance } = require('../lib/rng');
const { voteOnPostDual, voteOnPostApi } = require('../lib/upvote');
// E1: 拟人化输入层（真实滚轮）
const { wheelScroll, planToWheelSteps, findScrollContainer } = require('../lib/human-input');

/** 从板块池随机挑 n 个不重复的（可播种） */
function pickSubs(pool, count, rng = Math.random) {
  const shuffled = shuffle(rng, pool);
  return shuffled.slice(0, Math.min(count, pool.length));
}

/**
 * 检测页面是否被风控 (验证码/挑战页)
 * Reddit 风控页特征: 出现 "verify" / "captcha" / "are you a human" 等
 */
async function detectChallenge(page) {
  const info = await page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    const url = location.href.toLowerCase();
    const has = (t) => text.includes(t) || url.includes(t);
    const challengeWords = ['verify you are human', 'are you a human', 'captcha', 'verify your identity', 'unusual activity'];
    const hit = challengeWords.find((w) => has(w));
    return { challenge: hit || null, url: location.href };
  });
  return info;
}

/** 检测是否已登录：/api/me.json 权威优先，旧版 DOM 入口降级兜底。 */
async function isLoggedIn(page) {
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
    };
  });
  return { ...resolveLogin({ api, dom }), apiStatus: api.status, isSuspended: api.isSuspended ?? null };
}

/**
 * 在页面上模拟真人滚动浏览 (更慢、带阅读停顿、偶尔回滚)
 */
async function humanScroll(page, rng = Math.random, probe = null, scrollKind = 'list', inputMode = 'wheel', scrollTarget = null) {
  const scrolls = randInt(rng, 2, 4);
  let lastScrollAt = Date.now();
  let scrollFallbacks = 0;
  // E1: wheel 优先，异常自动降级 legacy（scrollBy），降级计数计入报告审计
  const doScroll = async (dy) => {
    if (inputMode === 'wheel') {
      try {
        await wheelScroll(page, { dy, rng, scrollTarget });
        return;
      } catch {
        scrollFallbacks += 1;
      }
    }
    await page.evaluate((step) => {
      window.scrollBy(0, step);
    }, dy);
  };
  for (let i = 0; i < scrolls; i += 1) {
    const dy = randInt(rng, 400, 800);
    await doScroll(dy);
    // 滚动后阅读停顿: 2-6 秒, 像在看完一段内容
    const pauseMs = randInt(rng, 2000, 6000);
    await sleep(pauseMs);
    // E0 探针: 读取页面原生 scroll 事件 + 上报调用（旁路, 不影响行为）
    if (probe) {
      await probe.flushScroll(page, scrollKind);
      probe.event('scroll-call', { dy, pauseMs: Date.now() - lastScrollAt, input: inputMode });
    }
    lastScrollAt = Date.now();
  }
  // 偶尔回滚一下, 更像真人 (回头再看上面内容)
  if (chance(rng, 0.6)) {
    const back = -randInt(rng, 200, 500);
    await doScroll(back);
    await sleep(randInt(rng, 1500, 3500));
    if (probe) {
      await probe.flushScroll(page, scrollKind);
      probe.event('scroll-call', { dy: back, pauseMs: Date.now() - lastScrollAt, input: inputMode });
    }
  }
  return { scrollFallbacks };
}

/**
 * 收集页面上的候选帖子（P2 修复：排除置顶公告帖）。
 *
 * 背景：Reddit 新版 UI（shreddit）中，置顶官方公告（pinned announcements）
 * 的链接也是 a[href*="/comments/"]，但它们不在 shreddit-post 列表项内
 * （inPost=false）。直接用全局锚点选择器收集会把公告帖当候选——
 * 公告帖可能已锁定不可投票，且"打开/点赞公告帖"不属于养号目标行为
 * （实测 verify-real 曾因此点赞对象与回读对象错位）。
 *
 * 优先从 shreddit-post 自定义元素取（列表项内的真实帖子，天然排除公告）；
 * 页面无 shreddit-post（旧版 UI 或异常）时回退全局锚点方式。
 *
 * 注意：此函数会作为 page.evaluate 的第一个参数注入浏览器上下文执行，
 * 因此必须自包含（不能闭包引用外部变量），document 用页面全局；
 * 单测时通过注入 globalThis.document 模拟。
 *
 * @param {number} [limit=12] 最多收集数量
 * @returns {Array<{id: string, href: string, title: string}>}
 */
function collectCandidatesFromDom(limit = 12) {
  const doc = document;
  // 方式 1（新版 UI）：shreddit-post 列表项
  const postEls = [...doc.querySelectorAll('shreddit-post')];
  if (postEls.length) {
    const seen = new Set();
    const out = [];
    for (const el of postEls) {
      const id = (el.id || '').replace(/^t3_/, '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const titleLink = el.querySelector('a[href*="/comments/"]');
      out.push({
        id,
        href: titleLink?.getAttribute('href') || `https://www.reddit.com/comments/${id}/`,
        title: (titleLink?.textContent || '').trim().slice(0, 120),
      });
      if (out.length >= limit) break;
    }
    if (out.length) return out;
  }
  // 方式 2（回退）：全局锚点（旧版 UI 或页面无 shreddit-post）
  const anchors = [...doc.querySelectorAll('a[href*="/comments/"]')];
  const seen2 = new Set();
  return anchors
    .map((a) => {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/comments\/([a-z0-9]+)/i);
      return {
        id: m?.[1] || null,
        href,
        title: (a.querySelector('span, div, h3')?.textContent || a.textContent || '').trim().slice(0, 120),
      };
    })
    .filter((p) => {
      if (!p.id || seen2.has(p.id)) return false;
      seen2.add(p.id);
      return true;
    })
    .slice(0, limit);
}

/**
 * 在真实页面执行候选帖收集（薄包装：evaluate 注入纯函数）
 * @param {import('playwright').Page} page
 * @param {number} [limit=12]
 */
async function collectPostCandidates(page, limit = 12) {
  return page.evaluate(collectCandidatesFromDom, limit);
}

function planReadingSession({ textLength = 0, viewportHeight = 800, maxDurationMs = 45000 } = {}, rng = Math.random) {
  const maxMs = Math.max(8000, maxDurationMs);
  const estimatedWords = Math.max(40, Math.round(textLength / 5));
  const wordsPerMinute = randInt(rng, 180, 260);
  const estimatedMs = Math.round((estimatedWords / wordsPerMinute) * 60000);
  const targetMs = Math.min(maxMs, Math.max(12000, estimatedMs));
  const initialPauseMs = Math.min(randInt(rng, 2200, 5200), Math.round(targetMs * 0.3));
  const steps = [];
  let spentMs = initialPauseMs;
  let backtracked = false;
  while (spentMs < targetMs - 1800 && steps.length < 8) {
    const canBacktrack = !backtracked && steps.length >= 2 && chance(rng, 0.28);
    const direction = canBacktrack ? -1 : 1;
    if (canBacktrack) backtracked = true;
    const offset = direction * randInt(rng,
      Math.max(180, Math.round(viewportHeight * (direction < 0 ? 0.18 : 0.42))),
      Math.max(260, Math.round(viewportHeight * (direction < 0 ? 0.38 : 0.78))));
    let pauseMs = randInt(rng, 1800, 5600);
    if (steps.length >= 1 && chance(rng, 0.22)) pauseMs += randInt(rng, 2500, 6000);
    pauseMs = Math.min(pauseMs, targetMs - spentMs);
    steps.push({ offset, pauseMs, cursorX: rng(), cursorY: rng() });
    spentMs += pauseMs;
  }
  return { targetMs, initialPauseMs, steps, estimatedWords, wordsPerMinute };
}

/**
 * 点开一个帖子阅读详情 (进入详情页, 滚动看评论, 停留, 返回列表)
 * 阅读节奏按正文长度估算，包含首屏停顿、分段滚动、偶发长停顿和少量回看。
 */
async function openAndReadPost(page, sub, rng = Math.random, maxReadMs = 45000, inputMode = 'wheel', scrollTarget = null) {
  const candidates = await collectPostCandidates(page, 12);
  const hrefs = candidates.map((p) => p.href).filter((href) => /^https?:\/\/|^\/r\//.test(href));
  if (!hrefs.length) return null;
  const postHref = hrefs[Math.floor(rng() * 100000) % hrefs.length];
  if (!postHref) return null;

  const url = postHref.startsWith('/') ? `https://www.reddit.com${postHref}` : postHref;
  await actions.goto(page, url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const metrics = await page.evaluate(() => ({
    textLength: (document.body?.innerText || '').length,
    viewportHeight: window.innerHeight || 800,
    viewportWidth: window.innerWidth || 1200,
  }));
  const plan = planReadingSession({
    textLength: metrics.textLength,
    viewportHeight: metrics.viewportHeight,
    maxDurationMs: maxReadMs,
  }, rng);
  // E1: 把阅读计划映射为 wheel 子步序列（复用节奏建模）
  const wheelPlan = planToWheelSteps(plan, rng);
  // E1: 帖子页滚动容器（与列表页可能不同，单独探测）
  const postScrollTarget = scrollTarget || await findScrollContainer(page).catch(() => null);
  const readingStarted = Date.now();
  await sleep(plan.initialPauseMs);
  let scrollFallbacks = 0;

  for (const step of wheelPlan) {
    if (page.mouse) {
      const x = Math.round(metrics.viewportWidth * (0.2 + step.cursorX * 0.6));
      const y = Math.round(metrics.viewportHeight * (0.2 + step.cursorY * 0.6));
      await page.mouse.move(x, y, { steps: randInt(rng, 4, 12) }).catch(() => {});
    }
    if (inputMode === 'wheel') {
      try {
        // 子步连滚（真实滚轮），步间快速停顿，整体保留计划的阅读停顿
        for (const s of step.subSteps) {
          await page.mouse.wheel(0, s);
          await sleep(lognormalInt(rng, 120, 700, { mu: 5.6, sigma: 0.35 }));
        }
      } catch {
        // E1: wheel 失败降级 legacy（smooth scrollBy），计入审计
        scrollFallbacks += 1;
        await page.evaluate((offset) => {
          window.scrollBy({ top: offset, left: 0, behavior: 'smooth' });
        }, step.offset);
      }
    } else {
      await page.evaluate((offset) => {
        window.scrollBy({ top: offset, left: 0, behavior: 'smooth' });
      }, step.offset);
    }
    await sleep(step.pauseMs);
  }

  const readingSeconds = Math.max(1, Math.round((Date.now() - readingStarted) / 1000));
  await actions.goto(page, `https://www.reddit.com/r/${encodeURIComponent(sub)}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(randInt(rng, 1200, 2800));
  return { opened: true, readingSeconds, scrollSteps: plan.steps.length, estimatedWords: plan.estimatedWords, scrollFallbacks };
}

/**
 * 对 Reddit 官方投票 API (/api/vote) 发起点赞。
 *
 * 必须放在页面上下文内 fetch，不能改用 Node 侧 APIRequestContext：
 *   - 真实浏览器渲染进程发出的请求带完整 TLS 指纹，才能通过 Reddit
 *     网络层风控；Node 侧 HTTP 客户端会被识别为非浏览器流量并挂起
 *     （实测 POST /api/vote 30s 超时无响应，点赞全部静默失败）。
 *
 * 安全与稳定性兼顾：
 *   - 同源 fetch 默认携带登录 cookie（same-origin credentials），
 *     无需显式 credentials: 'include'，消除 Socket 对该写法的凭据信号；
 *   - 补上 Reddit 前端同款的 X-CSRFToken 头（从 csrf_token cookie 读取），
 *     行为与前端点赞按钮一致。
 */
async function voteOnPost(page, postId) {
  // E2: 委托 lib/upvote 的 api 实现（fetch 逻辑收敛到 upvote.js，避免双份漂移）
  return voteOnPostApi(page, postId);
}

/**
 * 收集页面帖子并随机点赞
 * @param {number} maxUpvotes 最大点赞数
 * @param {number} [minUpvotes=1] 最小点赞数
 * @param {function} [rng] 随机源（可播种）
 * @param {object|null} [probe] E0 行为探针（旁路，事件只 append）
 * @param {'click-first'|'api-only'|'mixed'} [voteMode='click-first'] E2 点赞双轨模式
 */
async function collectAndUpvote(page, sub, maxUpvotes, minUpvotes = 1, rng = Math.random, probe = null, voteMode = 'click-first') {
  // 用 collectPostCandidates 收集（优先 shreddit-post 列表项，排除置顶公告帖）
  const posts = await collectPostCandidates(page, 12);

  let upvoted = 0;
  let upvoteFallbacks = 0;
  const upvotedPosts = [];
  const count = Math.min(posts.length, randInt(rng, minUpvotes, maxUpvotes));
  // 随机选几个帖子点赞（可播种洗牌）
  const targets = shuffle(rng, posts).slice(0, count);
  for (const post of targets) {
    try {
      // E2: 点赞双轨（click-first 真实点击 + api 降级；api-only 保留旧行为）
      const r = await voteOnPostDual(page, post.id, { mode: voteMode, rng });
      // E0 探针: 点赞路径与结果（click/api，含 fallback 标记）
      if (probe) probe.event('upvote', { postId: post.id, ok: r.ok, path: r.path, fallback: r.fallback });
      if (r.ok) {
        upvoted += 1;
        upvotedPosts.push(post); // 只记录真正点赞成功的, 供报告审计
      }
      if (r.fallback) upvoteFallbacks += 1;
      await sleep(randInt(rng, 2000, 4500));
    } catch {
      // 点赞失败不影响
    }
  }
  return {
    posts: posts.map((p) => ({ sub, ...p })),
    upvoted,
    upvotedPosts: upvotedPosts.map((p) => ({ sub, ...p })),
    upvoteFallbacks,
  };
}

/**
 * 单台机器养号 (带登录检测 + 风控检测 + 重试)
 * 新增: 每板块逗留时长区间 (minSecondsPerSub/maxSecondsPerSub), 点赞数区间 (minUpvotes/maxUpvotes)
 * P2-3/P2-6: 支持 seed——同 seed 运行结果可复现（实验可回溯）；逗留时长用对数正态分布（更接近真人）
 */
async function warmUpMachine(manager, profile, subs, {
  retries = 2, minUpvotes = 1, maxUpvotes = 3,
  minSecondsPerSub = 20, maxSecondsPerSub = 45,
  minReadsPerSub = 0,
  seed = null,
  inputMode = 'wheel',
  voteMode = 'click-first', // E2: click-first|api-only|mixed（mixed 默认关）
  probe = null,
  pace = null, // P2-3: 行为档案节奏参数 {dwellMu, dwellSigma}，覆盖逗留时长的 lognormal 形状
} = {}) {
  // 可播种 RNG：seed 提供则确定性复现；否则退化为不可复现（兼容旧行为）
  const rng = seed != null ? createRng(seed) : Math.random;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const machine = await manager.connectMachine(profile.id);
      const page = await manager.getMainPage(machine);
      const result = { visited: 0, upvoted: 0, postsRead: 0, readingSeconds: 0, readingSessions: [], posts: [], upvotedPosts: [], challenges: 0, loggedIn: false, dwellSeconds: 0, scrollFallbacks: 0, upvoteFallbacks: 0, evidence: [] };

      // 先检测登录
      await actions.goto(page, 'https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      // E0 探针: 注入只读 scroll 监听（旁路, 不影响行为）
      if (probe) await probe.install(page);
      console.log('  等待 10 秒加载 Reddit 账号状态...');
      await waitForRedditAccountLoad(page);
      const login = await isLoggedIn(page);
      result.loggedIn = login.loggedIn;

      if (login.state === 'unknown') {
        result.loginState = 'unknown';
        result.error = `登录状态暂时无法确认 (API status ${login.apiStatus ?? 'unknown'}), 重试`;
        lastError = new Error(result.error);
        if (attempt < retries) {
          console.log(`  登录状态未知，第 ${attempt + 1} 次重试...`);
          await sleep(rand(8000, 15000));
          continue;
        }
        result.error = '登录状态暂时无法确认，已达到重试上限';
        return result;
      }

      if (!result.loggedIn) {
        // 检查是否风控页
        const challenge = await detectChallenge(page);
        if (challenge.challenge) {
          result.challenges += 1;
          // E3: 风控现场留档
          const ev = await captureEvidence(page, profile.serial, 'challenge');
          if (ev) result.evidence.push(ev);
          result.error = `风控页面: ${challenge.challenge}`;
          return result;
        }
        // E3: 未登录（门控拒绝）也留档，便于事后判断是登录页/挑战页/其他
        const ev = await captureEvidence(page, profile.serial, 'not-logged-in');
        if (ev) result.evidence.push(ev);
        result.error = '未登录 (/api/me.json 与用户入口均未命中), 跳过';
        return result;
      }

      if (login.isSuspended === true) {
        result.isSuspended = true;
        result.error = '账号已被封禁，停止浏览、滚动和点赞';
        const ev = await captureEvidence(page, profile.serial, 'suspended');
        if (ev) result.evidence.push(ev);
        return result;
      }

      // 逐板块养号
      let scrollTarget = null; // E1: 滚动容器探测结果（每板块重测，缓存复用）
      for (const sub of subs) {
        try {
          const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/`;
          await actions.goto(page, url, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await sleep(randInt(rng, 1500, 3000));
          // E1: 探测滚动容器（window vs shreddit 自定义容器），wheel 依赖它定位指针
          scrollTarget = await findScrollContainer(page).catch(() => null);

          // 风控检测
          const challenge = await detectChallenge(page);
          if (challenge.challenge) {
            result.challenges += 1;
            console.log(`    [${sub}] 检测到风控, 等待 30s 重试...`);
            // E3: 首次风控现场留档
            const ev = await captureEvidence(page, profile.serial, `challenge-${sub}`);
            if (ev) result.evidence.push(ev);
            await sleep(30000);
            const retryChallenge = await detectChallenge(page);
            if (retryChallenge.challenge) {
              // E3: 重试后仍风控 → 持续风控现场留档
              const ev2 = await captureEvidence(page, profile.serial, `challenge-persist-${sub}`);
              if (ev2) result.evidence.push(ev2);
              result.error = `风控持续: ${retryChallenge.challenge}`;
              break;
            }
          }

          // 真人浏览: 在整个逗留时长内穿插滚动/阅读/点开帖子看详情
          // P2-3: 逗留时长从均匀分布改为对数正态（真人行为是长尾分布，非均匀）；
          // 传入行为档案 pace 时用档案的 mu/sigma（每账号节奏差异），否则用默认。
          const dwellMs = lognormalInt(rng, minSecondsPerSub * 1000, maxSecondsPerSub * 1000,
            pace ? { mu: pace.dwellMu, sigma: pace.dwellSigma } : {});
          const started = Date.now();
          let postsRead = 0;
          // 普通 warmup 保留概率波动；批量养号 worker 可要求每板块至少阅读 1 帖。
          const probabilisticReadTarget = chance(rng, 0.85) ? randInt(rng, 1, 2) : 0;
          const readTarget = Math.max(minReadsPerSub, probabilisticReadTarget);
          while (Date.now() - started < dwellMs) {
            // 先滚动浏览列表
            const sc = await humanScroll(page, rng, probe, 'list', inputMode, scrollTarget);
            result.scrollFallbacks += sc?.scrollFallbacks || 0;
            const rest = Math.min(randInt(rng, 3000, 8000), dwellMs - (Date.now() - started));
            if (rest > 0) await sleep(rest);

            // 点开一个帖子阅读详情再返回 (不是每次都做, 保持自然)
            const requiredReadPending = postsRead < minReadsPerSub;
            if (postsRead < readTarget && (requiredReadPending || !chance(rng, 0.3)) && Date.now() - started < dwellMs * 0.8) {
              const remainingMs = dwellMs - (Date.now() - started);
              const reading = await openAndReadPost(page, sub, rng, Math.min(45000, Math.max(8000, remainingMs - 5000)), inputMode, scrollTarget);
              if (reading?.opened) {
                postsRead += 1;
                result.readingSeconds += reading.readingSeconds;
                result.scrollFallbacks += reading.scrollFallbacks || 0;
                result.readingSessions.push({ sub, ...reading });
                // E0 探针: 阅读会话
                if (probe) probe.event('read', { sub, readingSeconds: reading.readingSeconds, scrollSteps: reading.scrollSteps, estimatedWords: reading.estimatedWords });
                await sleep(randInt(rng, 1200, 3200));
              }
            }
          }
          result.visited += 1;
          result.postsRead = (result.postsRead || 0) + postsRead;
          result.dwellSeconds += Math.round((Date.now() - started) / 1000);
          // E0 探针: 板块逗留
          if (probe) probe.event('dwell', { sub, dwellMs, elapsedMs: Date.now() - started });

          // 随机点赞 (区间内)
          const { posts, upvoted, upvotedPosts, upvoteFallbacks } = await collectAndUpvote(page, sub, maxUpvotes, minUpvotes, rng, probe, voteMode);
          result.posts.push(...posts);
          result.upvotedPosts.push(...upvotedPosts);
          result.upvoted += upvoted;
          result.upvoteFallbacks += upvoteFallbacks || 0;

          await sleep(randInt(rng, 2000, 5000));
        } catch (subError) {
          console.log(`    [${sub}] 访问异常: ${subError.message.slice(0, 60)}`);
        }
      }
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        console.log(`  第 ${attempt + 1} 次失败, 重试中...`);
        await sleep(rand(8000, 15000));
      }
    }
  }
  return { visited: 0, upvoted: 0, postsRead: 0, readingSeconds: 0, readingSessions: [], posts: [], upvotedPosts: [], challenges: 0, loggedIn: false, dwellSeconds: 0, scrollFallbacks: 0, evidence: [], error: lastError?.message || '重试次数耗尽' };
}

// E3: 风控/shadowban/门控拒绝现场截图（只读操作，失败不阻塞主流程）
// 存 reports/evidence/<serial>-<ts>-<tag>.png，报告 JSON 的 evidence 数组记相对路径。
function summarizeCleanup(settled = []) {
  const failures = settled
    .filter((item) => item?.status === 'rejected')
    .map((item) => ({
      profileId: item.profileId ?? null,
      reason: item.reason?.message || String(item.reason || '关闭失败'),
    }));
  return { ok: failures.length === 0, failed: failures.length, failures };
}

async function captureEvidence(page, serial, tag) {
  try {
    const evidenceDir = path.join(__dirname, '..', 'reports', 'evidence');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const filename = `${serial ?? 'unknown'}-${Date.now()}-${tag}.png`;
    const abs = path.join(evidenceDir, filename);
    await actions.screenshot(page, abs);
    return path.relative(path.join(__dirname, '..', 'reports'), abs);
  } catch {
    return null; // 截图失败不阻塞养号流程（E3 仅事后复核用）
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  // 写操作有意逐台执行，避免把连接并发配置误当成页面任务并发。
  const manager = new MachineManager({ concurrency: 1 });

  // 确定本次使用的板块 (指定了就用指定的, 否则随机挑——可播种)
  const mainRng = options.seed != null ? createRng(options.seed) : Math.random;
  const subCount = randInt(mainRng, options.minSubs, options.maxSubs);
  const subs = options.subs.length ? options.subs : pickSubs(SUB_POOL, subCount, mainRng);

  const startedAt = new Date();
  console.log(`[养号任务] ${startedAt.toLocaleString('zh-CN')}`);
  console.log(`目标: ${options.serialNumbers.length ? 'serial ' + options.serialNumbers.join(',') : (options.groupName || 'profiles')}`);
  console.log(`板块: ${subs.join(', ')}`);
  console.log('---\n');

  const results = [];
  let cleanup = { ok: true, failed: 0, failures: [] };
  try {
    const profiles = await manager.resolveProfiles(options);
    if (!profiles.length) throw new Error('没有匹配的机器');

    for (const profile of profiles) {
      const label = profile.serial ? `serial ${profile.serial}` : profile.id;
      console.log(`[${label}] ${profile.name}: 开始养号...`);
      try {
        const result = await warmUpMachine(manager, profile, subs, {
          retries: options.retries,
          minUpvotes: options.minUpvotes,
          maxUpvotes: options.maxUpvotes,
          minSecondsPerSub: options.minSecondsPerSub,
          maxSecondsPerSub: options.maxSecondsPerSub,
          seed: options.seed != null ? options.seed + (profile.serial || 0) : null, // 每账号偏移 seed，避免多账号行为完全一致
          inputMode: options.inputMode,
          voteMode: options.voteMode,
        });
        results.push({
          serial: profile.serial,
          name: profile.name,
          profileId: profile.id,
          ...result,
        });
        const status = result.error ? '❌ ' + result.error : `✅ 浏览 ${result.visited} 板块 (阅读 ${result.postsRead} 帖), 逗留 ${result.dwellSeconds}s, 点赞 ${result.upvoted}`;
        console.log(`[${label}] ${profile.name}: ${status}\n`);
      } catch (error) {
        results.push({ serial: profile.serial, name: profile.name, profileId: profile.id, error: error.message });
        console.log(`[${label}] ${profile.name}: ❌ 失败 - ${error.message.slice(0, 80)}\n`);
      }
    }
  } finally {
    cleanup = summarizeCleanup(await manager.closeAll());
    if (!cleanup.ok) {
      const byProfile = new Map(cleanup.failures.map((item) => [item.profileId, item.reason]));
      for (const result of results) {
        if (byProfile.has(result.profileId)) result.cleanupError = byProfile.get(result.profileId);
      }
    }
  }

  // 生成报告
  const finishedAt = new Date();
  const report = {
    task: 'reddit-warmup',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationSec: Math.round((finishedAt - startedAt) / 1000),
    subs,
    machines: results,
    cleanup,
    summary: {
      total: results.length,
      ok: results.filter((r) => !r.error && !r.cleanupError).length,
      failed: results.filter((r) => r.error || r.cleanupError).length,
      totalUpvotes: results.reduce((sum, r) => sum + (r.upvoted || 0), 0),
      totalVisited: results.reduce((sum, r) => sum + (r.visited || 0), 0),
      totalPostsRead: results.reduce((sum, r) => sum + (r.postsRead || 0), 0),
      totalDwellSeconds: results.reduce((sum, r) => sum + (r.dwellSeconds || 0), 0),
    },
  };

  fs.mkdirSync(options.reportDir, { recursive: true });
  const reportFile = path.join(options.reportDir, `warmup-${startedAt.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

  // 同名 .md 摘要 (人读)
  const mdLines = [
    '# 养号报告',
    '',
    `- 开始: ${startedAt.toISOString()}`,
    `- 结束: ${finishedAt.toISOString()}`,
    `- 耗时: ${report.durationSec}s`,
    `- 板块: ${subs.join(', ')}`,
    '',
    '## 汇总',
    `- 机器: ${report.summary.ok}/${report.summary.total} 成功`,
    `- 浏览: ${report.summary.totalVisited} 板块 / 阅读 ${report.summary.totalPostsRead} 帖 / ${Math.round(report.summary.totalDwellSeconds / 60)}min`,
    `- 点赞: ${report.summary.totalUpvotes}`,
    `- Profile 清理: ${cleanup.ok ? '通过' : `失败 ${cleanup.failed} 台`}`,
    '',
    '## 机器明细',
    '',
    '| serial | 账号 | 浏览 | 阅读 | 点赞 | 逗留 | 状态 |',
    '|---|---|---|---|---|---|---|',
    ...results.map((r) => {
      const issue = r.error || r.cleanupError;
      const status = issue ? `❌ ${String(issue).slice(0, 60)}` : '✅';
      return `| ${r.serial ?? '-'} | ${r.name} | ${r.visited ?? '-'} | ${r.postsRead ?? '-'} | ${r.upvoted ?? '-'} | ${r.dwellSeconds ?? 0}s | ${status} |`;
    }),
    '',
    '## 点赞明细',
    '',
    ...results.flatMap((r) => [
      `### ${r.name} (serial ${r.serial ?? '-'})`,
      ...upvoteLines(r.upvotedPosts),
      '',
    ]),
  ];
  const mdFile = writeMdReport(reportFile, mdLines.join('\n'));

  console.log(`\n=== 汇总 ===`);
  console.log(`机器: ${report.summary.ok}/${report.summary.total} 成功`);
  console.log(`板块浏览: ${report.summary.totalVisited} 次, 阅读 ${report.summary.totalPostsRead} 帖, 逗留 ${Math.round(report.summary.totalDwellSeconds / 60)}min, 点赞: ${report.summary.totalUpvotes} 次`);
  console.log(`Profile 清理: ${cleanup.ok ? '通过' : `失败 ${cleanup.failed} 台`}`);
  console.log(`报告已保存: ${reportFile}`);
  if (mdFile) console.log(`MD 摘要已保存: ${mdFile}`);
  if (report.summary.failed > 0 || !cleanup.ok) process.exitCode = ENV_ERROR;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('出错:', error.message);
    process.exitCode = ENV_ERROR;
  });
}

module.exports = { warmUpMachine, pickSubs, detectChallenge, isLoggedIn, humanScroll, planReadingSession, openAndReadPost, voteOnPost, collectPostCandidates, collectCandidatesFromDom, summarizeCleanup, parseArgs, SUB_POOL };
