/**
 * connector.js — CDP 连接管理
 *
 * connectWithRetry(port) 通过 playwright 的 connectOverCDP 附加到
 * AdsPower 已启动的指纹浏览器进程上。
 *
 * 注意: 绝不调用 chromium.launch() —— 那会丢失指纹/代理。
 * 指纹浏览器启动可能需要几秒, 所以这里带轮询重试。
 *
 * 依赖: playwright 为可选安装 —— 安装本 skill 后需在 skill 目录
 * 执行 `npm install playwright`（或全局安装）。缺依赖时给出可执行指引。
 */

let _chromium = null;
function getChromium() {
  if (_chromium) return _chromium;
  try {
    _chromium = require('playwright').chromium;
    return _chromium;
  } catch (err) {
    const msg = [
      '缺少 playwright 依赖。请先安装:',
      '  cd <skill目录> && npm install playwright   # 或全局: npm install -g playwright',
      '',
      '安装后重试本命令。',
    ].join('\n');
    throw new Error(msg);
  }
}

const DEFAULT_RETRY = 12;   // 次数
const DEFAULT_INTERVAL = 1000; // 毫秒

/**
 * 连接 AdsPower 指纹浏览器 (带重试)
 * @param {number} port CDP debug 端口
 * @param {object} options
 * @param {number} [options.retries=DEFAULT_RETRY] 重试次数
 * @param {number} [options.interval=DEFAULT_INTERVAL] 重试间隔 ms
 * @param {number} [options.timeout] 单次 connectOverCDP 超时 ms
 * @returns {Promise<import('playwright').Browser>} 已连接的 browser 实例
 */
async function connectWithRetry(port, { retries = DEFAULT_RETRY, interval = DEFAULT_INTERVAL, timeout } = {}) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      const browser = await getChromium().connectOverCDP(`http://127.0.0.1:${port}`, timeout ? { timeout } : {});
      return browser;
    } catch (err) {
      lastErr = err;
      // 最后一次重试不再等待
      if (i < retries) {
        await new Promise((r) => setTimeout(r, interval));
      }
    }
  }
  const error = new Error(`连接 AdsPower profile 的 CDP endpoint 失败 (重试 ${retries} 次)`);
  error.cause = lastErr;
  throw error;
}

/**
 * 获取当前 browser 对应的默认 context
 * AdsPower 指纹浏览器的页面都在 contexts[0] 里
 */
function getContext(browser) {
  const contexts = browser.contexts();
  if (!contexts.length) {
    throw new Error('浏览器没有可用 context (确认 open_tabs 启动方式或手动开个页面)');
  }
  return contexts[0];
}

/**
 * 断开连接 (不关浏览器进程, AdsPower 里的浏览器还能继续用)
 */
async function disconnect(browser) {
  try {
    await browser.close();
  } catch {
    // 忽略关闭异常 —— 可能已经断开
  }
}

/**
 * Ask Chromium itself to terminate, rather than merely detaching Playwright.
 * This is only a fallback for a profile that the current MachineManager owns:
 * the normal shutdown path remains AdsPower's /browser/stop API.
 */
async function closeProcess(browser) {
  if (!browser || typeof browser.newBrowserCDPSession !== 'function') {
    throw new Error('当前 CDP 连接不支持 Browser.close');
  }
  let session;
  try {
    session = await browser.newBrowserCDPSession();
    await session.send('Browser.close');
  } catch (error) {
    // Chromium commonly tears down the transport before acknowledging
    // Browser.close. A disconnected browser means the command took effect.
    if (typeof browser.isConnected === 'function' && !browser.isConnected()) return;
    throw error;
  } finally {
    if (session) await session.detach().catch(() => {});
  }
}

module.exports = {
  connectWithRetry,
  getContext,
  disconnect,
  closeProcess,
};
