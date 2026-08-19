'use strict';
/**
 * upvote.js — E2 点赞双轨
 *
 * 现状问题：voteOnPost 纯 fetch /api/vote——稳定，但所有账号所有点赞同一
 * 路径 = 行为模式雷同（P2 点名的关联检测风险），且无视觉核验。
 *
 * E2 方案：click-first 主路径（真实悬停+点击 shadow DOM 内 upvote 按钮 →
 * 直接回读 aria-pressed，不 reload）+ api fallback。mixed 模式（点击/API
 * 混合比例）默认关，A/B 验证后再开（R3）。
 *
 * 关键决策：
 * - R1：点击后直接读 shadow DOM aria-pressed，不 reload（点击后 DOM 即时
 *   更新；reload 每帖刷新反而是异常模式）。reload 仅作点击疑似失败后的
 *   fallback 复验。
 * - 浏览器侧纯函数（countActiveUpvotesInPost / findUpvoteButtonInPost）
 *   定义为无闭包普通函数，Node 侧可注入 fake DOM 单测；真实运行经
 *   evalWith 序列化注入页面执行，单份源码不漂移。
 * - 点击后等待 800-1200ms 用 lognormalInt 采样（E0 校准点：upvoteGapMs
 *   分布落地后回炉校准参数）。
 */

const { lognormalInt, chance } = require('./rng');

// 点击后等待区间（E0 校准点）
const CLICK_CONFIRM_PARAMS = { mu: 6.85, sigma: 0.15 }; // 中位≈947ms，区间约 [800, 1200]

/**
 * 浏览器侧纯函数：统计帖元素内 aria-pressed=true 的按钮数（含 shadow DOM 嵌套）。
 * 从 verify-real 步骤 4 抽公共；无闭包，可注入 fake DOM 单测。
 * @param {object|null} postEl shreddit-post DOM 元素（或其 fake 等价物）
 * @returns {number} active upvote 按钮数
 */
function countActiveUpvotesInPost(postEl) {
  if (!postEl) return 0;
  let active = 0;
  const walk = (root) => {
    if (!root) return;
    for (const b of (root.querySelectorAll ? [...root.querySelectorAll('button')] : [])) {
      if ((b.getAttribute('aria-pressed') || '') === 'true') active += 1;
    }
    for (const c of (root.querySelectorAll ? root.querySelectorAll('*') : [])) if (c.shadowRoot) walk(c.shadowRoot);
  };
  walk(postEl.shadowRoot || postEl);
  return active;
}

/**
 * 浏览器侧纯函数：在帖元素 shadow DOM 内定位 upvote 按钮。
 * 匹配优先：aria-label/title 含 "upvote" 的 [aria-pressed] 按钮；否则取第一个
 * [aria-pressed] 按钮（downvote 也有 aria-pressed，label 匹配优先避免误点）。
 * @param {object|null} postEl shreddit-post DOM 元素（或其 fake 等价物）
 * @returns {object|null} 按钮元素
 */
function findUpvoteButtonInPost(postEl) {
  if (!postEl) return null;
  const buttons = [];
  const walk = (root) => {
    if (!root) return;
    for (const b of (root.querySelectorAll ? [...root.querySelectorAll('button')] : [])) {
      if (b.hasAttribute('aria-pressed')) buttons.push(b);
    }
    for (const c of (root.querySelectorAll ? root.querySelectorAll('*') : [])) if (c.shadowRoot) walk(c.shadowRoot);
  };
  walk(postEl.shadowRoot || postEl);
  const labelMatch = buttons.find((b) => /upvote/i.test(`${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''}`));
  return labelMatch ?? buttons[0] ?? null;
}

/**
 * 把无闭包浏览器函数序列化注入页面执行（单份源码共享：Node 单测直接调用
 * 纯函数本体，真实运行经此注入）。fns 为 {name: fn} 集合，main 为入口。
 * 用 new Function 构造统一作用域：main 内可自由引用同批 helper 函数名
 * （eval 逐条注入会丢失闭包引用，实测 ReferenceError）。
 * 内部用注释标记 CONFIRM_VOTE / API_VOTE 供单测 mock 区分调用。
 */
async function evalWith(page, fns, arg) {
  const defs = {};
  for (const [key, value] of Object.entries(fns)) defs[key] = String(value);
  const body = `${Object.entries(defs).map(([k, code]) => `const ${k} = (${code});`).join('\n')}\nreturn main(arg);`;
  return page.evaluate(({ src, arg }) => {
    // eslint-disable-next-line no-new-func
    const run = new Function('arg', src);
    return run(arg);
  }, { src: body, arg });
}

/**
 * 对 Reddit 官方投票 API (/api/vote) 发起点赞（api-only 主路径 / click 降级路径）。
 * 必须放在页面上下文内 fetch（TLS 指纹，安全轮教训：Node 侧请求被挂起）。
 */
async function voteOnPostApi(page, postId) {
  try {
    return await page.evaluate(async (postId) => {
      try {
        // API_VOTE
        const csrf = (document.cookie.match(/(?:^|; )csrf_token=([^;]+)/) || [])[1] || '';
        const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
        if (csrf) headers['X-CSRFToken'] = csrf;
        const res = await fetch('/api/vote', {
          method: 'POST',
          headers,
          body: new URLSearchParams({ id: `t3_${postId}`, dir: '1', rank: '0' }),
        });
        return res.ok;
      } catch {
        return false;
      }
    }, postId);
  } catch {
    return false;
  }
}

/**
 * 点击后直接回读：在对应 shreddit-post 的 shadow DOM 内统计 aria-pressed=true
 * 按钮数（不 reload，R1）。
 * @returns {Promise<{found: boolean, activeUpvotes: number, score: string|null}>}
 */
async function confirmUpvote(page, postId) {
  try {
    return await evalWith(page, {
      countActiveUpvotesInPost,
      main: ({ postId }) => {
        // CONFIRM_VOTE
        const el = [...document.querySelectorAll('shreddit-post')].find((p) => (p.id || '') === `t3_${postId}`);
        return {
          found: Boolean(el),
          activeUpvotes: countActiveUpvotesInPost(el),
          score: el ? (el.getAttribute('score') || null) : null,
        };
      },
    }, { postId });
  } catch {
    return { found: false, activeUpvotes: 0, score: null };
  }
}

/**
 * 定位帖子的 upvote 按钮（返回 ElementHandle，可 hover/click；找不到返回 null）。
 */
async function findUpvoteButton(page, postId) {
  try {
    return await page.evaluateHandle(({ src, postId }) => {
      const find = eval(`(${src.findUpvoteButtonInPost})`);
      const el = [...document.querySelectorAll('shreddit-post')].find((p) => (p.id || '') === `t3_${postId}`);
      return find(el);
    }, { src: { findUpvoteButtonInPost: String(findUpvoteButtonInPost) }, postId });
  } catch {
    return null;
  }
}

/**
 * 真实悬停 + 点击 upvote 按钮（合成鼠标，走输入管线）。
 * 点击后等待 lognormalInt 采样 800-1200ms（E0 校准点）。
 * @returns {Promise<boolean>} 点击动作是否成功派发（不保证服务端生效，需 confirmUpvote 回读）
 */
async function clickUpvote(page, postId, rng = Math.random) {
  const btn = await findUpvoteButton(page, postId);
  if (!btn) return false;
  try {
    await btn.hover();
    await btn.click();
    await page.waitForTimeout(lognormalInt(rng, 800, 1200, CLICK_CONFIRM_PARAMS));
    return true;
  } catch {
    return false;
  }
}

/**
 * E2 点赞双轨入口。
 * @param {import('playwright').Page} page
 * @param {string} postId
 * @param {object} [opts]
 * @param {'click-first'|'api-only'|'mixed'} [opts.mode='click-first'] 双轨模式
 * @param {function} [opts.rng=Math.random] 随机源（可播种）
 * @param {number} [opts.clickRatio=0.6] mixed 模式点击比例（默认 60/40，R3 A/B 校准）
 * @returns {Promise<{ok: boolean, path: 'click'|'api', fallback: boolean, detail: string|null}>}
 */
async function voteOnPostDual(page, postId, { mode = 'click-first', rng = Math.random, clickRatio = 0.6 } = {}) {
  const clickPath = async () => {
    // 主路径：真实点击 → 直接回读（无 reload）
    const clicked = await clickUpvote(page, postId, rng);
    if (!clicked) {
      // 按钮定位/点击失败 → 直接降级 api（可审计）
      const apiOk = await voteOnPostApi(page, postId);
      return { ok: apiOk, path: 'api', fallback: true, detail: apiOk ? 'upvote 按钮不可用，降级 /api/vote' : '按钮与 api 均失败' };
    }
    let readback = await confirmUpvote(page, postId);
    if (readback.found && readback.activeUpvotes > 0) {
      return { ok: true, path: 'click', fallback: false, detail: null };
    }
    // reload 仅作点击疑似失败后的复验（R1）
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500).catch(() => {});
    readback = await confirmUpvote(page, postId);
    if (readback.found && readback.activeUpvotes > 0) {
      return { ok: true, path: 'click', fallback: false, detail: 'reload 后回读确认' };
    }
    // 点击链路失败 → 降级 api（可审计）
    const apiOk = await voteOnPostApi(page, postId);
    return { ok: apiOk, path: 'api', fallback: true, detail: apiOk ? 'click 回读失败，降级 /api/vote' : 'click 与 api 均失败' };
  };

  if (mode === 'api-only') {
    const ok = await voteOnPostApi(page, postId);
    return { ok, path: 'api', fallback: false, detail: ok ? null : '/api/vote 未返回 ok' };
  }
  if (mode === 'mixed') {
    return chance(rng, clickRatio) ? clickPath() : { ok: await voteOnPostApi(page, postId), path: 'api', fallback: false, detail: null };
  }
  // click-first（默认）
  return clickPath();
}

module.exports = {
  countActiveUpvotesInPost,
  findUpvoteButtonInPost,
  voteOnPostApi,
  confirmUpvote,
  findUpvoteButton,
  clickUpvote,
  voteOnPostDual,
};
