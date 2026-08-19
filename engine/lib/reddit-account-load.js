'use strict';

// AdsPower profile 启动后 Reddit 的账号导航通常晚于 DOMContentLoaded 渲染。
// 登录判断前固定留出完整加载窗口，避免把仍在恢复 cookie/session 的账号误判为未登录。
const REDDIT_ACCOUNT_LOAD_MS = 10_000;

async function waitForRedditAccountLoad(page) {
  await page.waitForTimeout(REDDIT_ACCOUNT_LOAD_MS);
}

module.exports = { REDDIT_ACCOUNT_LOAD_MS, waitForRedditAccountLoad };
