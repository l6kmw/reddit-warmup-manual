'use strict';
/**
 * human-input.js — 拟人化输入层（实施计划 E1：真实滚轮）
 *
 * 借鉴：ego-browser（citrolabs/ego-lite）的真实滚轮 wheel 手法。
 * 现状缺口：`window.scrollBy` 是瞬时/平滑跳，不走浏览器合成器，
 * 与真人滚轮的输入事件形态不一致（懒加载触发、scroll 节流行为不同）。
 *
 * 本模块提供：
 *   1. `findScrollContainer(page)` — 探测页面滚动结构（window vs 自定义容器）。
 *      Reddit 新版 UI（shreddit）可能有自定义滚动容器；容器选择器
 *      以 E1a 探针（scripts/scroll-probe.js）实测为准，不留未验证假设（R5）。
 *   2. `wheelScroll(page, { dy, rng, scrollTarget })` — 真实 wheel 事件分步派发：
 *      先 mouse.move 到滚动容器上方（合成器需要指针位置），再
 *      `page.mouse.wheel(0, delta)` 分步滚动；步长/步间停顿用 lognormalInt 采样。
 *   3. `planToWheelSteps(plan, rng)` — 把 planReadingSession 已有的阅读计划
 *      steps[{offset, pauseMs}] 映射为 wheel 子步序列（复用节奏建模，不重写）。
 *
 * 设计约束（评审 R2/R3）：
 *   - 所有随机走 rng（可播种、每账号 seed 偏移），不新增不可复现随机源
 *   - 随机参数一律 lognormalInt 采样；以下常量是 E0 基线校准点
 *     （E0 采集真实分布后回填，见 ego-humanization-plan.md §E0）
 *   - 子步分解保证总 delta 精确等于目标（误差 0），供"总 delta 与目标
 *     误差 <15%"的验收断言直接通过
 *   - wheel 抛错由调用方 catch 降级 legacy（本模块不吞错）
 */

const { lognormalInt } = require('./rng');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- E0 基线校准点 ----
// 单步 wheel 增量（px）：真人滚轮每次滚动的典型量
const WHEEL_STEP_PARAMS = { mu: 5.0, sigma: 0.3 }; // lognormal 中位 ≈ 148px，区间 [60, 260]
// 步间停顿（ms）：滚轮连续事件的间隔
const WHEEL_PAUSE_PARAMS = { mu: 5.6, sigma: 0.35 }; // 中位 ≈ 270ms，区间 [120, 700]
const WHEEL_STEP_MIN = 60;
const WHEEL_STEP_MAX = 260;
const WHEEL_MAX_STEPS = 24;

/**
 * 页面注入的滚动结构探测（自包含纯函数，供 findScrollContainer 注入 + 单测）。
 * 判定规则：
 *   - 候选自定义容器中第一个 scrollHeight > clientHeight 的即为滚动容器
 *     （shreddit 新版 UI 用自定义滚动容器；旧版/异常回退 window）
 *   - 无任何可滚动目标时返回 { kind: 'unknown' }
 * 注意：此函数在浏览器上下文执行，必须自包含（不能闭包引用外部变量）。
 * 单测通过注入 globalThis.document / window 模拟。
 */
function detectScrollContainerDom() {
  const win = window;
  const doc = document;
  const vw = win.innerWidth || 1280;
  const vh = win.innerHeight || 800;
  const candidates = ['shreddit-app', 'shreddit-feed', 'main', '#main-content', 'body'];
  for (const selector of candidates) {
    const el = doc.querySelector(selector);
    if (!el) continue;
    const overflowY = (win.getComputedStyle(el).overflowY || '').toLowerCase();
    const scrollable = el.scrollHeight > el.clientHeight + 10;
    if (scrollable) {
      return { kind: 'element', selector, overflowY, viewportWidth: vw, viewportHeight: vh };
    }
  }
  const root = doc.documentElement;
  if (root && root.scrollHeight > root.clientHeight + 10) {
    return { kind: 'window', viewportWidth: vw, viewportHeight: vh };
  }
  return { kind: 'unknown', viewportWidth: vw, viewportHeight: vh };
}

/**
 * 探测当前页面的滚动结构（薄包装：evaluate 注入纯函数）
 * @param {import('playwright').Page} page
 * @returns {Promise<{kind: 'element'|'window'|'unknown', selector?: string, viewportWidth: number, viewportHeight: number}>}
 */
async function findScrollContainer(page) {
  try {
    return await page.evaluate(detectScrollContainerDom);
  } catch {
    return { kind: 'unknown', viewportWidth: 1280, viewportHeight: 800 };
  }
}

/**
 * 把一段目标滚动量分解为 wheel 子步（正数），保证总和精确等于 absDy。
 * 最后一步吸收剩余（可能 < 最小值），保证总 delta 与目标误差为 0。
 * @param {function} rng 随机源（可播种）
 * @param {number} absDy 目标滚动量（绝对值，px）
 * @param {object} [stepParams] lognormal 参数（E0 校准点）
 * @param {number} [maxSteps=WHEEL_MAX_STEPS] 上限，防止死循环
 * @returns {number[]} 正数子步数组
 */
function splitWheelSteps(rng, absDy, stepParams = WHEEL_STEP_PARAMS, maxSteps = WHEEL_MAX_STEPS) {
  const out = [];
  let remaining = Math.max(0, Math.round(absDy));
  while (remaining > 0 && out.length < maxSteps) {
    const isLast = out.length === maxSteps - 1;
    const step = isLast
      ? remaining
      : Math.min(remaining, lognormalInt(rng, WHEEL_STEP_MIN, WHEEL_STEP_MAX, stepParams));
    out.push(step);
    remaining -= step;
  }
  if (remaining > 0 && out.length) out[out.length - 1] += remaining; // 理论上不会触发（isLast 吸收）
  return out;
}

/**
 * 把 planReadingSession 的阅读计划映射为 wheel 子步序列。
 * 每个计划步的 offset 展开为多个 wheel 子步（方向保留），pauseMs/cursor 原样保留。
 * @param {object} plan planReadingSession 的返回值（含 steps）
 * @param {function} [rng] 随机源
 * @param {object} [stepParams] lognormal 参数
 * @returns {Array<{offset: number, pauseMs: number, cursorX: number, cursorY: number, subSteps: number[], totalDelta: number}>}
 */
function planToWheelSteps(plan, rng = Math.random, stepParams = WHEEL_STEP_PARAMS) {
  const wheelSteps = [];
  for (const step of (plan && plan.steps) || []) {
    const direction = step.offset < 0 ? -1 : 1;
    const subs = splitWheelSteps(rng, Math.abs(step.offset), stepParams);
    wheelSteps.push({
      offset: step.offset,
      pauseMs: step.pauseMs,
      cursorX: step.cursorX,
      cursorY: step.cursorY,
      subSteps: subs.map((s) => direction * s),
      totalDelta: direction * subs.reduce((acc, s) => acc + s, 0),
    });
  }
  return wheelSteps;
}

/**
 * 计算 wheel 派发时鼠标应处的位置（真实滚轮需要指针在滚动容器上方）。
 * element 容器取 boundingBox 中心偏上；window 滚动取视口中心偏上。
 * @param {import('playwright').Page} page
 * @param {object|null} scrollTarget findScrollContainer 的结果
 * @returns {Promise<{x: number, y: number}>}
 */
async function wheelPointerPosition(page, scrollTarget = null) {
  const vw = scrollTarget?.viewportWidth || 1280;
  const vh = scrollTarget?.viewportHeight || 800;
  if (scrollTarget && scrollTarget.kind === 'element' && page.locator) {
    const box = await page.locator(scrollTarget.selector).boundingBox().catch(() => null);
    if (box) {
      return {
        x: Math.round(box.x + box.width * 0.5),
        y: Math.round(box.y + Math.min(box.height * 0.35, 500)),
      };
    }
  }
  return { x: Math.round(vw * 0.5), y: Math.round(vh * 0.3) };
}

/**
 * 真实滚轮：一次"滚动动作"，内部拆成多个 wheel 事件分步派发。
 * 先 mouse.move 到滚动容器上方，再 page.mouse.wheel 分步滚动。
 * 返回实际派发的总 delta（绝对值等于 |dy|，符号保留）。
 *
 * @param {import('playwright').Page} page
 * @param {object} opts
 * @param {number} opts.dy 目标滚动量（px，负数为向上）
 * @param {function} [opts.rng] 随机源（可播种）
 * @param {object|null} [opts.scrollTarget] findScrollContainer 结果（null 时按 window 处理）
 * @returns {Promise<number>} 实际总 delta
 */
async function wheelScroll(page, { dy, rng = Math.random, scrollTarget = null }) {
  const direction = dy < 0 ? -1 : 1;
  const subs = splitWheelSteps(rng, Math.abs(dy));
  if (!subs.length) return 0;

  // 指针先移到滚动容器上方（合成器只把 wheel 派发给指针所在元素链）
  if (page.mouse) {
    const pos = await wheelPointerPosition(page, scrollTarget);
    await page.mouse.move(pos.x, pos.y).catch(() => {});
  }

  let actual = 0;
  for (const s of subs) {
    const delta = direction * s;
    await page.mouse.wheel(0, delta);
    actual += delta;
    await sleep(lognormalInt(rng, 120, 700, WHEEL_PAUSE_PARAMS));
  }
  return actual;
}

module.exports = {
  WHEEL_STEP_PARAMS,
  WHEEL_PAUSE_PARAMS,
  WHEEL_STEP_MIN,
  WHEEL_STEP_MAX,
  WHEEL_MAX_STEPS,
  detectScrollContainerDom,
  findScrollContainer,
  splitWheelSteps,
  planToWheelSteps,
  wheelPointerPosition,
  wheelScroll,
};
