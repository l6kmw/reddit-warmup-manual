#!/usr/bin/env node
/**
 * comment.js — Reddit 评论（高风险写操作，需风险档位门控）
 *
 * 门控规则（references/risk-tiers.md）:
 *   T0 禁止评论; T1 每天最多 1 条; T2+ 可评论但需控制频率。
 *
 * 用法:
 *   node scripts/comment.js --serial 4 --sub AmazonSeller --text "评论内容"
 *   node scripts/comment.js --serial 4 --sub AmazonSeller --text "..." --post-url "..."
 *   node scripts/comment.js --serial 4 --sub ecommerce --file comment.txt
 *
 * 测试模式: --force-tier T1|T2|T3 仅绕过档位门控 (供真实账号联调), 其余门控
 * (账号安全/内容质量/AI 痕迹/社区规则) 全部保留, 社区规则 ack 仍必须匹配。
 *
 * 评论必须是原创、有实质内容; 禁止复制模板/空话。
 */
const fs = require('fs');
const path = require('path');
const { loadAdsModules } = require('../lib/resolve-ads');
const { machineManager } = loadAdsModules();
const { MachineManager } = machineManager;
const { pageActions } = loadAdsModules();
const { writeMdReport } = require('../lib/md-report');
const { assessTier, parseRedditorFor, parseKarma } = require('./assess-risk');
const { extractAccountInfo } = require('./healthcheck');
const { aiToneCheck, rewriteHints } = require('./ai-tone');
const { OK, BLOCKED, ENV_ERROR } = require('../lib/exit-codes');
const { loadDailyCounter, bumpDaily, getDailyCount, readState, writeState } = require('../lib/state');
const { writeBlockReason } = require('../lib/account-safety');
const { detectChallenge } = require('./warmup');
const {
  fetchCommunityRules, readPostContext, reviewContent, writeRulesSnapshot, writeRulesReview,
} = require('../lib/community-rules');
const { installRedditStaticFallback, waitForModernUI } = require('../lib/reddit-ui');

// 每日评论上限 (按档位)
const DAILY_LIMITS = { T0: 0, T1: 1, T2: 3, T3: 10 };
const REPORT_DIR = path.join(__dirname, '..', 'reports');

// 评论审计报告: 成功与拒绝都落盘, 便于回答"今天评了哪些帖子、为什么没评"
// 同时生成同名 .md 摘要供人读。
function writeCommentReport(entry, reportDir = REPORT_DIR) {
  try {
    fs.mkdirSync(reportDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.T]/g, '-').replace(/Z$/, '');
    const file = path.join(reportDir, `comment-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify({ task: 'reddit-comment', at: new Date().toISOString(), ...entry }, null, 2));

    const statusText = {
      posted: '✅ 已发布',
      rejected: '⛔ 拒绝',
      'maybe-blocked': '⚠️ 可能被拦截',
    }[entry.status] ?? entry.status;
    const mdLines = [
      '# 评论审计',
      '',
      `- 时间: ${new Date().toISOString()}`,
      `- 状态: ${statusText}`,
      `- 账号: serial ${entry.serial ?? '-'} ${entry.name ?? ''} (${entry.profileId ?? '-'})`,
      `- 板块: ${entry.sub ?? '-'}`,
      ...(entry.postUrl ? [`- 帖子: ${entry.postUrl}`] : []),
      ...(entry.tier ? [`- 档位: ${entry.tier} (${entry.tierReason ?? ''})`] : []),
      ...(entry.reason ? [`- 理由: ${entry.reason}`] : []),
      ...(entry.communityRules ? [
        `- 规则来源: ${entry.communityRules.rules?.source ?? '-'}`,
        `- 规则抓取时间: ${entry.communityRules.rules?.fetchedAt ?? '-'}`,
        `- 规则 Hash: ${entry.communityRules.rules?.hash ?? '-'}`,
        `- 规则命中: ${entry.communityRules.hits?.length ?? 0}`,
        `- 规则未决: ${entry.communityRules.unresolved?.length ?? 0}`,
        `- Ack 匹配: ${entry.communityRules.confirmations?.hashMatches ? '是' : '否'}`,
      ] : []),
      ...(entry.issues?.length ? [`- AI 命中: ${entry.issues.join('; ')}`] : []),
      '',
      '## 内容',
      '',
      entry.text || '-',
      '',
    ];
    writeMdReport(file, mdLines.join('\n'));
  } catch {
    // 报告写入失败不阻塞主流程
  }
}

function parseArgs(argv) {
  const options = {
    profileIds: [], serialNumbers: [], groupName: undefined, sub: null, text: null, file: null,
    postUrl: null, rulesAck: null, confirmedUnresolved: [], forceTier: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--force-tier') {
      options.forceTier = argv[++index];
    } else if (arg === '--serial') {
      options.serialNumbers.push(...String(argv[++index] ?? '').split(','));
    } else if (arg === '--profiles') {
      options.profileIds.push(...String(argv[++index] ?? '').split(','));
    } else if (arg === '--group') {
      options.groupName = argv[++index];
    } else if (arg === '--sub') {
      options.sub = argv[++index];
    } else if (arg === '--text') {
      options.text = argv[++index];
    } else if (arg === '--file') {
      options.file = argv[++index];
    } else if (arg === '--post-url') {
      options.postUrl = argv[++index];
    } else if (arg === '--rules-ack') {
      options.rulesAck = argv[++index];
    } else if (arg === '--confirm-unresolved') {
      options.confirmedUnresolved.push(...String(argv[++index] ?? '').split(',').filter(Boolean));
    } else if (arg.startsWith('--')) {
      throw new Error(`未知参数: ${arg}`);
    } else {
      options.profileIds.push(arg);
    }
  }
  if (options.profileIds.length + options.serialNumbers.length !== 1) {
    throw new Error('请恰好指定一个账号: --serial N 或 --profile id');
  }
  if (!options.sub) throw new Error('--sub 必填');
  if (!options.text && !options.file) throw new Error('--text 或 --file 必填');
  if (options.file) {
    options.text = fs.readFileSync(path.resolve(options.file), 'utf8').trim();
    if (!options.text) throw new Error(`评论文件为空: ${options.file}`);
  }
  if (!options.text || options.text.length < 30) {
    throw new Error('评论内容过短 (至少 30 字), 避免空话被标记为低质量互动');
  }
  if (options.forceTier && !['T0', 'T1', 'T2', 'T3'].includes(options.forceTier)) {
    throw new Error('--force-tier 必须是 T0|T1|T2|T3');
  }
  return options;
}

// 高质量评论检查: 拒绝模板化/空话
function isQualityComment(text) {
  const lower = text.toLowerCase();
  const junk = ['good post', 'thanks for sharing', 'great post', 'nice post', 'agree', '+1', '收藏了', '好文', '谢谢分享'];
  if (junk.some((j) => lower.includes(j))) return false;
  // 需要有一个具体的信息点 (数字/问句/经验词)
  return /\d|\?|？|经验|问题|为什么|如何|我|你|you|your|how|what|why/.test(text);
}

// 提交后从页面读取验证信号: 是否风控页 / 评论是否已渲染 / 文本是否仍留在输入框。
// 页面 innerText 会包含 textarea/contenteditable 里未提交的文本, 因此先克隆 DOM
// 并移除输入控件, 避免把"还留在输入框的内容"误判为已发布。
async function readCommentVerify(page, fragment) {
  return page.evaluate((frag) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const clone = document.body?.cloneNode(true);
    if (!clone) return { challenge: false, visible: false, stillInBox: false };
    for (const control of clone.querySelectorAll('textarea, input, [contenteditable]')) {
      control.remove();
    }
    const bodyText = norm(clone.innerText);
    const boxText = norm(
      [...document.querySelectorAll('textarea, [contenteditable]')]
        .map((el) => (el.tagName === 'TEXTAREA' ? el.value : el.textContent))
        .join(' ')
    );
    const target = norm(frag);
    // 只认真实风控特征: captcha 控件 / 风控 URL / 明确标题文案
    // (正文/评论里出现 verify 单词不算风控, 曾误报)
    const url = (location.href || '').toLowerCase();
    const hasCaptchaEl = !!document.querySelector('.captcha, #captcha, input[name="id_captcha"], [data-testid*="captcha" i]');
    const challenge = hasCaptchaEl
      || /(?:are you a human|verify your identity|unusual activity)/i.test(bodyText)
      || /(?:^|\/)(?:captcha|verify|challenge)(?:\/|$|\?)/.test(url);
    return {
      challenge,
      visible: Boolean(target) && bodyText.includes(target),
      stillInBox: Boolean(target) && boxText.includes(target),
    };
  }, fragment);
}

// 验证信号 → 判定 (纯函数, 便于测试)
function commentVerification({ challenge, visible, stillInBox }) {
  if (challenge) return { status: 'maybe-blocked', reason: '触发风控页' };
  if (visible) return { status: 'posted', reason: null };
  if (stillInBox) return { status: 'maybe-blocked', reason: '提交未生效, 内容仍留在输入框' };
  return { status: 'maybe-blocked', reason: '评论未在页面出现, 可能被过滤或延迟' };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manager = new MachineManager({ concurrency: 1 });
  try {
    const profiles = await manager.resolveProfiles(options);
    if (!profiles.length) throw new Error('没有匹配的机器');
    const profile = profiles[0];
    const label = profile.serial ? `serial ${profile.serial}` : profile.id;

    // 1. 连接 + 抓取账号信息
    const machine = await manager.connectMachine(profile.id);
    await installRedditStaticFallback(machine.context);
    const page = await manager.getMainPage(machine);
    const accKey = profile.serial != null ? `serial:${profile.serial}` : `id:${profile.id}`;
    const info = await extractAccountInfo(page, machine, { skipShadowProbe: true, accountKey: accKey });
    const challenge = await detectChallenge(page);
    const accountBlock = writeBlockReason({ ...info, challenge: challenge.challenge });
    if (accountBlock) {
      console.log(`⛔ 拒绝评论: ${accountBlock.reason} (${accountBlock.code})`);
      writeCommentReport({
        status: 'rejected', gate: accountBlock.code, reason: `${accountBlock.reason} (${accountBlock.code})`,
        serial: profile.serial, name: profile.name, profileId: profile.id, sub: options.sub, text: options.text,
      });
      process.exitCode = BLOCKED;
      return;
    }

    // 2. 风险档位门控
    const createdDays = parseRedditorFor(info.created);
    const commentKarma = parseKarma(info.commentKarma);
    const realAssessment = assessTier({ createdDays, commentKarma });
    const assessment = options.forceTier
      ? { tier: options.forceTier, reason: `测试模式强制档位 (实际 ${realAssessment.tier}: ${realAssessment.reason})` }
      : realAssessment;
    if (options.forceTier) {
      console.log(`⚠️ 测试模式: --force-tier ${options.forceTier} 绕过档位门控 (实际 ${realAssessment.tier}, ${realAssessment.reason})`);
    }
    const limit = DAILY_LIMITS[assessment.tier] ?? 0;
    if (limit === 0) {
      console.log(`⛔ 拒绝评论: 档位 ${assessment.tier} (${assessment.reason})`);
      console.log(`   T0 账号禁止一切评论; 请继续浏览/点赞养号。`);
      writeCommentReport({
        status: 'rejected', gate: 'tier', tier: assessment.tier,
        reason: `档位 ${assessment.tier} 禁止评论 (${assessment.reason})`,
        serial: profile.serial, name: profile.name, profileId: profile.id, sub: options.sub, text: options.text,
      });
      process.exitCode = BLOCKED;
      return;
    }

    // 3. 内容质量检查 (模板/空话)
    if (!isQualityComment(options.text)) {
      console.log(`⛔ 拒绝评论: 内容疑似模板/空话 (${options.text.slice(0, 40)}...)`);
      console.log(`   请提供具体经验、问题或观点 (至少 30 字)。`);
      writeCommentReport({
        status: 'rejected', gate: 'content-quality', tier: assessment.tier,
        tierReason: assessment.reason, reason: '内容疑似模板/空话',
        serial: profile.serial, name: profile.name, profileId: profile.id, sub: options.sub, text: options.text,
      });
      process.exitCode = BLOCKED;
      return;
    }

    // 3b. AI 痕迹检查 (太像 AI 的内容会被 Reddit 风控标记)
    const tone = aiToneCheck(options.text);
    if (!tone.passed) {
      console.log(`⛔ 拒绝评论: 内容太像 AI 生成 (得分 ${tone.score})`);
      for (const issue of tone.issues) console.log(`   - ${issue}`);
      console.log('   改写建议:');
      for (const hint of rewriteHints(tone.issues)) console.log(`   - ${hint}`);
      writeCommentReport({
        status: 'rejected', gate: 'ai-tone', tier: assessment.tier,
        tierReason: assessment.reason, reason: `AI 痕迹得分 ${tone.score}/10`, issues: tone.issues,
        serial: profile.serial, name: profile.name, profileId: profile.id, sub: options.sub, text: options.text,
      });
      process.exitCode = BLOCKED;
      return;
    }

    // 3c. 频率门控（SKILL.md 承诺"每天 ≤N 条"，此前 DAILY_LIMITS 是死代码从未执行）
    // 按 serial 键记录当日评论数；跨天自动重置；达到上限即拒绝（BLOCKED，不重试）
    const todayComments = getDailyCount(accKey, 'comments');
    if (todayComments >= limit) {
      const reason = `今日已评论 ${todayComments} 条, 达到档位 ${assessment.tier} 上限 ${limit} 条`;
      console.log(`⛔ 拒绝评论: ${reason}`);
      console.log(`   频率门控: 每天最多 ${limit} 条, 明天再试。`);
      writeCommentReport({
        status: 'rejected', gate: 'frequency', tier: assessment.tier,
        tierReason: assessment.reason, reason,
        serial: profile.serial, name: profile.name, profileId: profile.id,
        sub: options.sub, text: options.text, tier: assessment.tier,
      });
      process.exitCode = BLOCKED;
      return;
    }

    // 4. 社区规则门控：实时抓取 -> 快照 -> 当前 hash ack -> 明确限制/未决逐条确认。
    // 此前不触碰评论输入框；无 postUrl 也在这里安全拒绝，不再盲选第一个帖子。
    let snapshot;
    try {
      snapshot = await fetchCommunityRules(page, options.sub);
      writeRulesSnapshot(snapshot);
    } catch (error) {
      const reason = `${error.message}; 规则无法获取时禁止评论`;
      console.log(`⛔ 拒绝评论: ${reason}`);
      writeCommentReport({
        status: 'rejected', gate: 'rules_fetch_failed', tier: assessment.tier,
        tierReason: assessment.reason, reason,
        communityRules: { rules: { subreddit: options.sub, source: null, fetchedAt: null, hash: null }, hits: [], unresolved: [], confirmations: { rulesAck: options.rulesAck, hashMatches: false, confirmedUnresolved: options.confirmedUnresolved, unconfirmed: [] }, fetchAttempts: error.attempts || [] },
        serial: profile.serial, name: profile.name, profileId: profile.id,
        sub: options.sub, postUrl: options.postUrl, text: options.text,
      });
      process.exitCode = BLOCKED;
      return;
    }

    let postContext = {};
    if (options.postUrl) {
      try {
        postContext = await readPostContext(page, options.postUrl, options.sub);
      } catch (error) {
        postContext = { error: error.message };
      }
    }
    const rulesReview = reviewContent(snapshot, {
      action: 'comment', text: options.text, postUrl: options.postUrl,
      postContext: postContext.error ? {} : postContext,
    }, { rulesAck: options.rulesAck, confirmedUnresolved: options.confirmedUnresolved });
    writeRulesReview(rulesReview, { action: 'comment', text: options.text, postUrl: options.postUrl });
    if (!rulesReview.allowed) {
      const reason = postContext.error ? `${rulesReview.reason}; ${postContext.error}` : rulesReview.reason;
      console.log(`⛔ 拒绝评论: ${reason}`);
      console.log(`   当前规则 hash: ${snapshot.hash}`);
      if (rulesReview.confirmations.unconfirmed.length) console.log(`   未确认项: ${rulesReview.confirmations.unconfirmed.join(', ')}`);
      writeCommentReport({
        status: 'rejected', gate: rulesReview.gate, tier: assessment.tier,
        tierReason: assessment.reason, reason, communityRules: rulesReview,
        serial: profile.serial, name: profile.name, profileId: profile.id,
        sub: options.sub, postUrl: options.postUrl, text: options.text,
      });
      process.exitCode = BLOCKED;
      return;
    }

    const postHref = postContext.url || options.postUrl;
    // readPostContext 已导航到帖子页, 避免对同一 URL 二次 goto (偶发超时)
    if (page.url().split('?')[0] !== postHref.split('?')[0]) {
      await pageActions.goto(page, postHref, { timeout: 120000 });
    }
    await page.waitForTimeout(4000);

    // 新版 Reddit 评论器是 Web Components；等待组件注册后，通过可见控件输入/提交。
    await waitForModernUI(page, () => {
      const host = document.querySelector('comment-composer-host');
      if (!customElements.get('comment-composer-host') || !host) return false;
      const r = host.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }, '评论器');
    const host = page.locator('comment-composer-host').first();
    await host.click();
    const editor = host.locator('shreddit-composer [contenteditable="true"][role="textbox"]').first();
    await editor.waitFor({ state: 'visible', timeout: 30000 });
    await editor.fill(options.text);
    await page.waitForTimeout(800);
    const submit = host.locator('shreddit-composer button[type="submit"]').first();
    await submit.waitFor({ state: 'visible', timeout: 30000 });
    await submit.click();

    // 5. 等待提交完成并验证
    // 只检查"没有风控页"不足以确认成功: 评论可能被静默过滤或仍留在输入框。
    // 用内容片段在页面中(排除输入框)查找, 找不到则如实记为 maybe-blocked。
    await page.waitForTimeout(8000);
    const probeText = options.text.length <= 40 ? options.text : options.text.slice(12, 42);
    let verify = await readCommentVerify(page, probeText);
    if (!verify.challenge && !verify.visible) {
      await page.waitForTimeout(8000); // 慢网下评论渲染可能延迟, 再确认一次
      verify = await readCommentVerify(page, probeText);
    }
    const verdict = commentVerification(verify);
    if (verdict.status !== 'posted') {
      console.log(`⚠️ 评论可能未成功 (${verdict.reason})。档位 ${assessment.tier} 每日上限 ${limit} 条。`);
      writeCommentReport({
        status: 'maybe-blocked', reason: verdict.reason, communityRules: rulesReview,
        serial: profile.serial, name: profile.name, profileId: profile.id,
        sub: options.sub, postUrl: postHref, text: options.text,
      });
      process.exitCode = BLOCKED;
      return;
    }

    console.log(`✅ [${label}] ${profile.name}: 评论已提交到 r/${options.sub}`);
    console.log(`   档位 ${assessment.tier} (${assessment.reason}), 每日上限 ${limit} 条`);
    console.log(`   内容: ${options.text.slice(0, 80)}${options.text.length > 80 ? '...' : ''}`);
    // 频率门控计数（成功提交后递增）
    const bumped = bumpDaily(accKey, 'comments', 1);
    if (!bumped.ok) {
      console.log(`   ⚠️ 频率计数写入失败（不影响评论结果，但下次可能超发）`);
    } else {
      console.log(`   今日评论 ${bumped.count}/${limit} 条`);
    }
    // P2-5: 记录写操作基线（供 recall.js 48h 后回采结果变量）
    try {
      const outcomes = readState('outcomes', { schemaVersion: 1, accounts: {} }) || { schemaVersion: 1, accounts: {} };
      const acc = outcomes.accounts[accKey] || { writes: [], latest: null };
      const base = {
        commentId: options.commentId || null,
        baseKarma: commentKarma,
        baseTier: assessment.tier,
        at: new Date().toISOString(),
      };
      acc.latest = base;
      outcomes.accounts[accKey] = acc;
      writeState('outcomes', outcomes);
    } catch {
      // 基线记录失败不影响评论结果
    }
    writeCommentReport({
      status: 'posted',
      serial: profile.serial, name: profile.name, profileId: profile.id,
      tier: assessment.tier, reason: assessment.reason,
      sub: options.sub, postUrl: postHref, text: options.text, communityRules: rulesReview,
    });
  } finally {
    await manager.closeAll();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('出错:', error.message);
    process.exitCode = ENV_ERROR;
  });
}

module.exports = { parseArgs, isQualityComment, commentVerification, writeCommentReport, DAILY_LIMITS };
