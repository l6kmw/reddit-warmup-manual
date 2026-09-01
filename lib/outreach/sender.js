'use strict';
/**
 * sender.js — 私信触达：全自动发送器 + 限频 + 互斥锁
 *
 * 职责（对应 docs/outreach-design.md §4.3）：
 *   - 从队列取 pending 项，逐条经 AdsPower 浏览器真实发送 Reddit 私信
 *   - 发送节奏：间隔随机 sendIntervalMin~sendIntervalMax；单次执行上限 runLimit
 *   - 失败不自动重试同一条，标记 failed 并暂停等待人工介入
 *   - 互斥锁 state/outreach.lock：与养号（warmup/comment/post）互斥，
 *     防止同一 Profile 并发操作
 *   - 发送成功后把用户名登记进 state/outreach-contacted.json（永久去重）
 *
 * 模块结构：
 *   - 纯函数层（可单测）：
 *     acquireLock / releaseLock / runRemaining / selectPendingBatch /
 *     shouldPauseAfterFailure / renderDelayMs
 *   - 浏览器层：openComposeAndSend / runSender
 *   - CLI 入口：node lib/outreach/sender.js --config <json>
 *     （@@STATUS@@ 事件 + JSON 结果，与 runner.js 协议一致）
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const STATE_DIR = process.env.OUTREACH_STATE_DIR || path.join(ROOT, 'state');

const LOCK_FILE = path.join(STATE_DIR, 'outreach.lock');
const AUDIT_DIR = process.env.OUTREACH_AUDIT_DIR || path.join(ROOT, 'logs');
const queueModule = require('./queue');
const discoverModule = require('./discover');
const matrixChat = require('./matrix-chat');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 追加一行审计 JSONL（logs/outreach-YYYY-MM-DD.jsonl），失败不阻塞发送 */
function appendAudit(entry) {
  try {
    const date = new Date().toISOString().slice(0, 10);
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.appendFileSync(path.join(AUDIT_DIR, `outreach-${date}.jsonl`), JSON.stringify(entry) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

// ==================== 互斥锁（原子 mkdir 实现，防同 Profile 并发） ====================

/**
 * 尝试获取互斥锁。
 * @param {{lockFile?: string, timeoutMs?: number}} [opts] timeoutMs<=0 表示只尝试一次（非阻塞）
 * @returns {Promise<{ok: boolean, lockFile: string, waitedMs: number, reason?: string, holder?: object}>}
 */
async function acquireLock({ lockFile = LOCK_FILE, timeoutMs = 0 } = {}) {
  const startedAt = Date.now();
  const deadline = timeoutMs > 0 ? startedAt + timeoutMs : 0;
  while (true) {
    try {
      fs.mkdirSync(lockFile);
      return { ok: true, lockFile, waitedMs: Date.now() - startedAt };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const now = Date.now();
      // 非阻塞（timeoutMs<=0）：立即返回失败；带超时：超时后返回失败
      if (deadline === 0 || now >= deadline) {
        const holder = readLockHolder(lockFile);
        return { ok: false, lockFile, waitedMs: now - startedAt, reason: 'lock_held', holder };
      }
      await sleep(Math.min(500, deadline - now));
    }
  }
}

function readLockHolder(lockFile) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockFile, 'holder.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** 释放互斥锁。 */
function releaseLock({ lockFile = LOCK_FILE } = {}) {
  try {
    fs.rmSync(lockFile, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** 写入锁持有者信息（诊断用，不影响锁语义） */
function writeLockHolder(lockFile, holder) {
  try {
    fs.mkdirSync(lockFile, { recursive: true });
    fs.writeFileSync(path.join(lockFile, 'holder.json'), JSON.stringify({ ...holder, acquiredAt: new Date().toISOString() }, null, 2), 'utf8');
  } catch {
    // holder 信息写失败不阻塞持锁流程
  }
}

// ==================== 纯函数：限频与批次选取 ====================

/**
 * @param {number} runLimit 本次执行最多发送条数
 * @returns {number} 本次执行剩余额度（>=0）
 */
function runRemaining(runLimit) {
  return Math.max(0, Number(runLimit));
}

/**
 * 从队列选取本次可发送批次。
 * @param {Array<object>} pendingItems listQueue({status: pending}) 结果
 * @param {{runLimit?: number}} [opts]
 * @returns {{toSend: Array<object>, remaining: number}}
 */
function selectPendingBatch(pendingItems, { runLimit = 20 } = {}) {
  const remaining = runRemaining(runLimit);
  const items = pendingItems || [];
  return {
    toSend: items.slice(0, remaining),
    // 未选中的 pending 必须留在队列，等待下一次执行
    remaining: Math.max(0, items.length - remaining),
  };
}

/**
 * 失败后是否需要暂停整个发送流程。
 * 规则：单条失败标记 failed；连续失败 >= maxConsecutiveFailures 时整体暂停。
 * @param {Array<{ok: boolean}>} results 本轮发送结果
 * @param {{maxConsecutiveFailures?: number}} [opts]
 * @returns {boolean}
 */
function shouldPauseAfterFailure(results, { maxConsecutiveFailures = 3 } = {}) {
  let consecutive = 0;
  for (const r of results || []) {
    consecutive = r && r.ok ? 0 : consecutive + 1;
  }
  return consecutive >= maxConsecutiveFailures;
}

/**
 * 计算两次发送间的随机间隔（毫秒）。
 * @param {{min?: number, max?: number, rng?: () => number}} [opts]
 * @returns {number}
 */
function renderDelayMs({ min = 60, max = 120, rng = Math.random } = {}) {
  const lo = Math.max(0, Number(min));
  const hi = Math.max(lo, Number(max));
  return Math.round(lo + rng() * (hi - lo)) * 1000;
}

// ==================== 浏览器层：真实发送私信 ====================

/**
 * 收集 compose 页面诊断信息（失败时附加到 error，帮助远程定位选择器问题）。
 * 不抛错：页面已崩溃/关闭时返回 null，不影响主流程。
 * @param {object} page Playwright page
 * @returns {Promise<object|null>}
 */
async function collectPageDiagnostics(page) {
  try {
    return await page.evaluate(() => {
      const has = (sel) => Boolean(document.querySelector(sel));
      const shadowInputNames = [...document.querySelectorAll('faceplate-textarea-input, faceplate-text-input')]
        .map((host) => {
          const el = host.shadowRoot && (host.shadowRoot.querySelector('textarea') || host.shadowRoot.querySelector('input'));
          return el ? `${host.tagName.toLowerCase()}[${el.getAttribute('name') || ''}]` : `${host.tagName.toLowerCase()}[]`;
        })
        .filter(Boolean)
        .slice(0, 6);
      const sendBtns = [...document.querySelectorAll('compose-message-form button[type="submit"], button[type="submit"]')]
        .filter((b) => /send|发送/i.test((b.innerText || '').trim()))
        .map((b) => `${b.disabled ? 'disabled:' : ''}${(b.innerText || '').trim().slice(0, 16)}`)
        .slice(0, 4);
      return {
        url: location.href.slice(0, 110),
        composeForm: has('compose-message-form'),
        faceplateTextarea: has('faceplate-textarea-input'),
        legacyTextarea: has('textarea[name="text"]'),
        shadowInputs: shadowInputNames,
        sendButtons: sendBtns,
        loginWall: /log in|continue to log|登录/i.test(document.body.innerText || '') && !has('compose-message-form'),
        bodyHead: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 120),
      };
    });
  } catch {
    return null;
  }
}

/**
 * 从 GraphQL data 对象中提取错误信号（data 内部可能携带 error/errors 字段
 * 或返回 null/空对象，顶层 data 存在不等于操作成功）。
 * 注意：`"errors": null` 与 `"errors": []` 是“无错误”的正常响应，
 * 只有非空错误才是失败信号，避免把成功响应误判为失败。
 * @param {object|null} data GraphQL payload.data
 * @returns {Array<object>|null} 错误信号列表；无错误返回 null
 */
function graphqlDataErrors(data) {
  if (data == null) return [{ signal: 'empty_data' }];
  const found = [];
  for (const [key, value] of Object.entries(data)) {
    if (value == null) {
      found.push({ field: key, signal: 'null_value' });
    } else if (Array.isArray(value) && value.length === 0) {
      found.push({ field: key, signal: 'empty_array' });
    } else if (typeof value === 'object') {
      // 递归扫描 error/errors 字段；null 与空数组视为无错误
      const scan = (obj, pathName) => {
        if (!obj || typeof obj !== 'object') return;
        for (const [k, v] of Object.entries(obj)) {
          if (k === 'error' || k === 'errors') {
            if (v == null) continue; // {"errors":null} 成功
            if (Array.isArray(v) && v.length === 0) continue; // {"errors":[]} 成功
            found.push({ field: `${pathName}.${k}`, signal: 'nonempty_error', snippet: JSON.stringify(v).slice(0, 200) });
          } else if (typeof v === 'object' && v !== null) {
            scan(v, `${pathName}.${k}`);
          }
        }
      };
      scan(value, key);
    }
  }
  return found.length ? found : null;
}

/**
 * 打开 compose 页面并真实填写发送 Reddit 私信。
 * @param {object} page Playwright page（已登录 Reddit）
 * @param {object} item 队列记录（含 username/draft）
 * @returns {Promise<{ok: boolean, sentAt?: string, error?: string, url?: string}>}
 */
async function openComposeAndSend(page, item) {
  const username = String(item.username || '').trim();
  const body = String(item.draft || '').trim();
  if (!username) return { ok: false, error: 'empty_username' };
  if (!body) return { ok: false, error: 'empty_draft' };

  const url = `https://www.reddit.com/message/compose/?to=${encodeURIComponent(username)}`;
  let submitted = false;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    // Reddit 新版 compose 表单由 Web Component 异步挂载；
    // 仅看到页面文案不代表 Shadow DOM 内的输入控件已经就绪。
    await page.waitForSelector('compose-message-form', { state: 'visible', timeout: 30000 });
    const messageBox = page.locator('faceplate-textarea-input textarea[name="message-content"]')
      .or(page.locator('textarea[name="text"]')).first();
    await messageBox.waitFor({ state: 'visible', timeout: 45000 });

    // 填写正文：新版 Reddit 位于 faceplate-textarea-input 的 Shadow DOM 内。
    await messageBox.fill(body);

    // 新版收件人控件需要一次键盘确认，URL 中的 ?to= 只填充初始值，
    // 不一定会触发 compose 表单内部的 recipient-valid 状态更新。
    const recipientBox = page.locator('faceplate-text-input input[name="message-recipient-input"]')
      .or(page.locator('input[name="to"]')).first();
    if (await recipientBox.count()) {
      // 防误触：URL 预填的收件人已就位时跳过键盘操作，避免回车触发收件人
      // 自动建议/组件校验，把已填好的目标改成别的用户。
      const currentValue = String(await recipientBox.inputValue().catch(() => '')).trim();
      const targetAlreadySet = username && currentValue.toLowerCase().includes(username.toLowerCase());
      if (!targetAlreadySet) {
        await recipientBox.click();
        await recipientBox.press('End');
        await recipientBox.press('Enter');
        await recipientBox.press('Tab');
      }
    }

    // 新版标题位于 faceplate-text-input 内；保留旧版选择器作为回退。
    const subjectBox = page.locator('faceplate-text-input input[name="message-title"]')
      .or(page.locator('input[name="subject"]')).first();
    if (await subjectBox.count()) {
      await subjectBox.fill(`Re: your comment on ${String(item.postTitle || 'Reddit').slice(0, 60)}`);
    }

    // 发送按钮位于 compose-message-form 内，避免误点导航栏中的 submit 按钮。
    const sendButton = page.locator('compose-message-form button[type="submit"]:has-text("Send")')
      .or(page.locator('compose-message-form button[type="submit"]:has-text("发送")'))
      .or(page.locator('compose-message-form button[type="submit"]')).first();
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll('compose-message-form button[type="submit"]')]
        .find((candidate) => /send|发送/i.test(candidate.innerText || ''));
      return Boolean(button && !button.disabled);
    }, { timeout: 10000 }).catch(() => {});
    if (await sendButton.isDisabled()) {
      const validation = await page.evaluate(() => [...document.querySelectorAll('faceplate-text-input,faceplate-textarea-input')]
        .map((host) => ({
          name: host.getAttribute('name'),
          validity: host.getAttribute('faceplate-validity'),
          value: host.shadowRoot?.querySelector('input,textarea')?.value || host.getAttribute('value') || '',
        })));
      return { ok: false, error: `send_button_disabled: ${JSON.stringify(validation)}`, url };
    }
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes('/svc/shreddit/graphql') && response.request().method() === 'POST',
      { timeout: 30000 },
    ).catch(() => null);
    submitted = true;
    await sendButton.click();

    // 以 Reddit GraphQL 响应作为主要证据；页面提示只作兼容回退。
    // 这样不会把“点击后确认提示超时”误报成普通失败。
    const apiResponse = await responsePromise;
    if (apiResponse) {
      let payload = null;
      try { payload = await apiResponse.json(); } catch { /* 非 JSON 响应交给页面确认判断 */ }
      if (Array.isArray(payload?.errors) && payload.errors.length) {
        return { ok: false, error: `reddit_graphql_error: ${JSON.stringify(payload.errors).slice(0, 1000)}`, url };
      }
      if (apiResponse.ok && payload && Object.prototype.hasOwnProperty.call(payload, 'data')) {
        // 加固：GraphQL 顶层有 data 不代表发送成功——data 内部可能携带 error/errors
        // 或返回空值（sendMessage:null）。发现任何错误信号即判失败，避免将
        // “后端静默拒绝”误报为发送成功。
        const dataErrors = graphqlDataErrors(payload.data);
        if (dataErrors) {
          return { ok: false, error: `reddit_graphql_data_error: ${JSON.stringify(dataErrors).slice(0, 800)}`, url };
        }
        return {
          ok: true,
          sentAt: new Date().toISOString(),
          url,
          evidence: 'graphql_response',
          graphql: { status: apiResponse.status, bodyHead: JSON.stringify(payload).slice(0, 300) },
        };
      }
    }

    // Reddit 发送成功后不一定销毁编辑器；新版会更新隐藏的确认节点。
    // 同时兼容旧版的文本提示和表单消失。
    await page.waitForFunction(() => {
      const t = document.body ? document.body.innerText : '';
      const confirmation = document.querySelector('compose-message-form .message-sent-confirmation-text');
      const editor = document.querySelector('faceplate-textarea-input')?.shadowRoot?.querySelector('textarea')
        || document.querySelector('textarea[name="text"]');
      const confirmationVisible = confirmation && !confirmation.hasAttribute('hidden') && (confirmation.innerText || '').trim();
      return Boolean(confirmationVisible)
        || /message sent|sent to|your message has been sent|消息已发送|发送成功/i.test(t)
        || !editor;
    }, { timeout: 30000 });

    return { ok: true, sentAt: new Date().toISOString(), url, evidence: 'page_confirmation' };
  } catch (error) {
    // 失败时附加页面 DOM 诊断信息：下次修选择器不再靠猜
    const diagnostics = await collectPageDiagnostics(page).catch(() => null);
    const errorText = String(error && error.message || error);
    return {
      ok: false,
      uncertain: submitted,
      error: diagnostics ? `${errorText} | DOM:${JSON.stringify(diagnostics)}` : errorText,
      url,
    };
  }
}

/**
 * Matrix 通道单条发送（对齐 Reddit 最新版 Chat；纯 API，不依赖页面 DOM）。
 * @param {string} token Matrix access token
 * @param {object} item 队列记录（username/draft）
 * @returns {Promise<{ok: boolean, sentAt?: string, url?: string, evidence?: string, roomId?: string, eventId?: string, error?: string}>}
 */
async function sendViaMatrix(token, item) {
  try {
    const r = await matrixChat.sendChatToUsername(
      token,
      String(item.username || '').trim(),
      String(item.draft || '').trim(),
    );
    if (r.ok) {
      return {
        ok: true,
        sentAt: new Date().toISOString(),
        url: `matrix:room/${r.roomId}`,
        evidence: 'matrix_chat',
        roomId: r.roomId,
        eventId: r.eventId,
      };
    }
    return { ok: false, error: `matrix_${r.stage || 'send'}_error: ${String(r.error || '')}` };
  } catch (error) {
    return { ok: false, error: `matrix_exception: ${error && error.message || error}` };
  }
}

/**
 * 全自动发送流程：锁定 → 循环批次发送 → 解锁。
 * @param {object} page Playwright page
 * @param {object} cfg 规范化 outreach 配置（lib/config.js parseOutreachConfig）
 * @param {{emit?: (event: string, payload: object) => void, lockTimeoutMs?: number}} [svc]
 * @returns {Promise<object>} 运行摘要
 */
async function runSender(page, cfg, { emit = () => {}, lockTimeoutMs = 0 } = {}) {
  const sentDay = new Date().toISOString().slice(0, 10);
  const lock = await acquireLock({ timeoutMs: lockTimeoutMs });
  if (!lock.ok) {
    return {
      ok: false,
      reason: lock.reason || 'lock_not_acquired',
      holder: lock.holder,
      summary: { attempted: 0, sent: 0, failed: 0, unknown: 0, skipped: 0, runLimit: cfg.runLimit, sentToday: queueModule.dailySentCount() },
    };
  }
  writeLockHolder(LOCK_FILE, { pid: process.pid, service: 'outreach-sender', target: cfg.target });

  let sent = 0;
  let failed = 0;
  const failures = [];
  const sendResults = [];
  try {
    const pending = queueModule.listQueue({ status: queueModule.STATUS.PENDING });
    const { toSend, remaining } = selectPendingBatch(pending, {
      runLimit: cfg.runLimit,
    });
    emit('outreach.status', {
      phase: 'send_run', batchSize: toSend.length, runLimit: cfg.runLimit,
      pendingBefore: pending.length, pendingAfter: remaining, channel: cfg.channel,
    });

    // 通道解析：默认 compose（实测不受 Reddit Chat 24h 房间创建限额影响）；
    // matrix 为可选通道（Reddit Matrix homeserver 对 createRoom 有 24h 限额）。
    const channel = cfg.channel === 'matrix' ? 'matrix' : 'compose';
    let matrixToken = null;
    if (channel === 'matrix') {
      const tokenRead = await matrixChat.readAccessTokenFromPage(page);
      if (!tokenRead.ok) {
        emit('outreach.status', { phase: 'aborted', reason: 'matrix_token_missing' });
        return {
          ok: false,
          reason: 'matrix_token_missing',
          summary: { attempted: 0, sent: 0, failed: 0, unknown: 0, skipped: 0, runLimit: cfg.runLimit, sentToday: queueModule.dailySentCount() },
          reportFile: null,
        };
      }
      matrixToken = tokenRead.token;
    }

    for (const [index, item] of toSend.entries()) {
      const result = channel === 'matrix'
        ? await sendViaMatrix(matrixToken, item)
        : await openComposeAndSend(page, item);
      sendResults.push(result);
      if (result.ok) {
        sent += 1;
        queueModule.markStatus([item.id], queueModule.STATUS.SENT, {
          sendResult: {
            ok: true,
            sentAt: result.sentAt,
            url: result.url,
            evidence: result.evidence,
            ...(result.graphql ? { graphql: result.graphql } : {}),
            ...(result.roomId ? { roomId: result.roomId } : {}),
            ...(result.eventId ? { eventId: result.eventId } : {}),
          },
        });
        discoverModule.recordContactedUsers([item.username]);
        appendAudit({
          ts: result.sentAt, event: 'outreach.sent', id: item.id, username: item.username,
          postTitle: item.postTitle, postUrl: item.postUrl, draft: item.draft, ok: true, url: result.url,
          channel,
          ...(result.roomId ? { roomId: result.roomId } : {}),
          ...(result.eventId ? { eventId: result.eventId } : {}),
        });
        emit('outreach.send', { id: item.id, username: item.username, ok: true, channel, progress: `${index + 1}/${toSend.length}` });
      } else if (result.uncertain) {
        queueModule.markStatus([item.id], queueModule.STATUS.UNKNOWN, { error: result.error });
        appendAudit({
          ts: new Date().toISOString(), event: 'outreach.unknown', id: item.id, username: item.username,
          postTitle: item.postTitle, postUrl: item.postUrl, ok: null, error: result.error,
        });
        emit('outreach.send', { id: item.id, username: item.username, ok: null, uncertain: true, error: result.error, progress: `${index + 1}/${toSend.length}` });
      } else {
        failed += 1;
        failures.push({ id: item.id, username: item.username, error: result.error });
        queueModule.markStatus([item.id], queueModule.STATUS.FAILED, { error: result.error });
        appendAudit({
          ts: new Date().toISOString(), event: 'outreach.failed', id: item.id, username: item.username,
          postTitle: item.postTitle, postUrl: item.postUrl, ok: false, error: result.error,
        });
        emit('outreach.send', { id: item.id, username: item.username, ok: false, error: result.error, progress: `${index + 1}/${toSend.length}` });
      }

      // 连续失败达到阈值，暂停本次执行，剩余 pending 保留
      if (shouldPauseAfterFailure(sendResults, { maxConsecutiveFailures: 3 })) {
        emit('outreach.status', { phase: 'paused', reason: 'consecutive_failures', failures });
        break;
      }

      if (index < toSend.length - 1) {
        await sleep(renderDelayMs({ min: cfg.sendIntervalMin, max: cfg.sendIntervalMax }));
      }
    }
  } finally {
    releaseLock({ lockFile: LOCK_FILE });
  }

  const reportPath = writeRunReport({
    sent, failed, failures, cfg,
    stats: queueModule.queueStats(),
  });

  return {
    ok: failed === 0 && queueModule.queueStats()[queueModule.STATUS.UNKNOWN] === 0,
    day: sentDay,
    summary: {
      attempted: sent + failed,
      sent,
      failed,
      unknown: queueModule.queueStats()[queueModule.STATUS.UNKNOWN],
      skipped: queueModule.queueStats()[queueModule.STATUS.SKIPPED],
      runLimit: cfg.runLimit,
      sentToday: queueModule.dailySentCount(),
    },
    failures,
    reportFile: reportPath,
  };
}

/** 生成运行 Markdown 报告（logs/outreach-run-*.md），失败返回 null */
function writeRunReport({ sent, failed, failures, cfg, stats }) {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const file = path.join(AUDIT_DIR, `outreach-run-${stamp}.md`);
    const lines = [
      '# Reddit 私信触达运行报告',
      '',
      `- 时间：${new Date().toLocaleString('zh-CN')}`,
      `- 社区：r/${cfg.sub}`,
      `- 目标账号：${cfg.target.type}=${cfg.target.value}`,
      `- 本次执行上限：${cfg.runLimit}｜本次已发送：${sent}｜执行后 pending：${Math.max(0, (stats.pending || 0))}`,
      `- 本次：发送 ${sent}，失败 ${failed}，跳过（含历史）${stats[queueModule.STATUS.SKIPPED] || 0}`,
      '',
      '| 结果 | 用户 | 错误 |',
      '|---|---|---|',
      ...failures.map((f) => `| 失败 | ${f.username} | ${String(f.error).replace(/\n/g, ' ')} |`),
      failures.length ? '' : '_无失败_',
      '',
    ];
    fs.writeFileSync(file, lines.join('\n'), 'utf8');
    return path.relative(ROOT, file);
  } catch {
    return null;
  }
}

// ==================== CLI 入口 ====================

const { loadAdsModules } = require(path.join(ROOT, 'engine', 'lib', 'resolve-ads'));

function parseArgs(argv) {
  const options = { config: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config') options.config = argv[i + 1];
  }
  return options;
}

function emitStatus(payload) {
  console.log(`@@STATUS@@${JSON.stringify(payload)}`);
}

function emitJson(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

async function main() {
  const { config: configPath } = parseArgs(process.argv.slice(2));
  if (!configPath) {
    console.error('用法: node lib/outreach/sender.js --config <config.json>');
    process.exit(2);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.error(`[sender] 配置读取失败: ${error.message}`);
    process.exit(2);
  }
  const { parseOutreachConfig } = require(path.join(ROOT, 'lib', 'config.js'));
  try {
    cfg = parseOutreachConfig(cfg);
  } catch (error) {
    console.error(`[sender] 配置无效: ${error.message}`);
    process.exit(2);
  }

  const { machineManager } = loadAdsModules();
  const { MachineManager } = machineManager;
  const manager = new MachineManager({ concurrency: 1, stopStartedProfiles: true });
  try {
    const profiles = await manager.resolveProfiles(targetQuery(cfg.target));
    if (!profiles.length) throw new Error('没有匹配的 AdsPower profile');
    const machine = await manager.connectMachine(profiles[0].id);
    const page = await manager.getMainPage(machine);

    // Matrix 通道：预热 Chat 页确保 rs-matrix-client 初始化出 token；compose 走首页
    const warmupUrl = cfg.channel === 'compose' ? 'https://www.reddit.com/' : 'https://www.reddit.com/chat/';
    await page.goto(warmupUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    if (cfg.channel !== 'compose') {
      const tokenReady = await matrixChat.waitForToken(page, { timeoutMs: 60000 });
      if (!tokenReady) {
        console.error('[sender] Matrix Chat token 未就绪（profile 可能从未打开过 Chat 页）');
        emitJson({ ok: false, error: 'matrix_token_not_ready' });
        return;
      }
    }

    const result = await runSender(page, cfg, { emit: emitStatus });
    emitJson({ ...result, profile: { serial: profiles[0].serial, id: profiles[0].id, name: profiles[0].name } });
  } finally {
    await manager.closeAll().catch(() => {});
  }
}

function targetQuery(target) {
  if (target.type === 'serial') return { serialNumbers: String(target.value).split(',').map((s) => s.trim()).filter(Boolean) };
  if (target.type === 'profiles') return { profileIds: String(target.value).split(',').map((s) => s.trim()).filter(Boolean) };
  return { groupName: String(target.value).trim() };
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[sender] 失败: ${error.message}`);
    emitJson({ ok: false, error: error.message });
    process.exitCode = 1;
  });
}

module.exports = {
  acquireLock,
  releaseLock,
  writeLockHolder,
  runRemaining,
  selectPendingBatch,
  shouldPauseAfterFailure,
  renderDelayMs,
  openComposeAndSend,
  runSender,
  appendAudit,
  writeRunReport,
  graphqlDataErrors,
  LOCK_FILE,
};