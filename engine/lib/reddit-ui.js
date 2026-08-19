'use strict';

const installed = new WeakSet();
const scriptCache = new Map();

function safeHeaders(headers) {
  return Object.fromEntries([...headers].filter(([key]) => ![
    'connection', 'content-encoding', 'content-length', 'transfer-encoding',
  ].includes(key.toLowerCase())));
}

/**
 * 23 号机的 SOCKS5 链路会间歇打断 redditstatic JS，导致新版 Web Components
 * 未注册、表单保持 SSR 隐藏状态。登录、页面数据、规则与写操作仍走 AdsPower；
 * 这里只把公开的 redditstatic.com 脚本用本机网络补给同一浏览器上下文。
 */
async function fetchScript(url) {
  if (scriptCache.has(url)) return scriptCache.get(url);
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = {
        status: response.status,
        headers: safeHeaders(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      };
      scriptCache.set(url, result);
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
    }
  }
  throw lastError;
}

async function installRedditStaticFallback(context) {
  if (installed.has(context)) return;
  installed.add(context);
  await context.route('https://www.redditstatic.com/**', async (route) => {
    if (route.request().resourceType() !== 'script') return route.continue();
    try {
      await route.fulfill(await fetchScript(route.request().url()));
    } catch {
      await route.continue().catch(() => {});
    }
  });
}

async function waitForModernUI(page, condition, label, timeout = 120000) {
  try {
    await page.waitForFunction(condition, null, { timeout });
  } catch {
    throw new Error(`${label}未加载: Reddit 新版界面静态组件不可用`);
  }
}

module.exports = { installRedditStaticFallback, waitForModernUI };
