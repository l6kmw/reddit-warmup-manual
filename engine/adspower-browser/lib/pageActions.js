function requirePage(page) {
  if (!page) throw new Error('page 不能为空');
  return page;
}

async function goto(page, url, options = {}) {
  // 代理/网络波动时重试 (默认 2 次尝试): 只有 throw 才重试
  // (超时/导航中断/崩溃), HTTP 4xx/5xx 不 throw 不会误重试。
  const { attempts = 3, ...rest } = options;
  const gotoOptions = { waitUntil: 'domcontentloaded', timeout: 30000, ...rest };
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requirePage(page).goto(url, gotoOptions);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
    }
  }
  throw lastError;
}

async function waitForElement(page, selector, options = {}) {
  return requirePage(page).waitForSelector(selector, { state: 'visible', ...options });
}

async function click(page, selector, options = {}) {
  await waitForElement(page, selector, options.waitFor);
  return page.click(selector, options.click);
}

async function fillForm(page, fields, options = {}) {
  for (const [selector, value] of Object.entries(fields)) {
    await waitForElement(page, selector, options.waitFor);
    if (value === null || value === undefined) continue;
    await page.fill(selector, String(value), options.fill);
  }
}

async function getText(page, selector, options = {}) {
  await waitForElement(page, selector, options.waitFor);
  const text = options.all
    ? await page.locator(selector).allTextContents()
    : await page.textContent(selector);
  return Array.isArray(text) ? text.map((item) => item.trim()) : text?.trim() ?? null;
}

async function getAttribute(page, selector, name, options = {}) {
  await waitForElement(page, selector, options.waitFor);
  if (options.all) {
    return page.locator(selector).evaluateAll(
      (elements, attribute) => elements.map((element) => element.getAttribute(attribute)),
      name
    );
  }
  return page.getAttribute(selector, name);
}

async function screenshot(page, path, options = {}) {
  if (!path) throw new Error('截图 path 不能为空');
  return requirePage(page).screenshot({ path, fullPage: true, ...options });
}

module.exports = { goto, waitForElement, click, fillForm, getText, getAttribute, screenshot };
