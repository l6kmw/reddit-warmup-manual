#!/usr/bin/env node
/**
 * post.js — Reddit 发帖（高风险写操作，需风险档位门控）
 *
 * 门控规则（references/risk-tiers.md）:
 *   T0/T1 禁止发帖; T2 每周最多 2 条且仅文字帖; T3 可发帖 + 文末放链接（需 sub 允许）。
 *
 * 用法:
 *   node scripts/post.js --serial 4 --sub AmazonSeller --title "标题" --text "正文"
 *   node scripts/post.js --serial 4 --sub ecommerce --title "..." --file body.txt
 *   node scripts/post.js --serial 4 --sub AmazonSeller --title "..." --text "..." --link "https://..."
 *
 * 测试模式: --force-tier T2|T3 仅绕过档位门控 (供真实账号联调), 其余门控
 * (账号安全/链接/AI 痕迹/社区规则) 全部保留, 社区规则 ack 仍必须匹配。
 *
 * 安全边界: 帖子必须原创有实质内容; T2 禁止链接; 不在首段放链接; 不发纯推广帖。
 */
const fs = require('fs');
const path = require('path');
const { loadAdsModules } = require('../lib/resolve-ads');
const { machineManager } = loadAdsModules();
const { MachineManager } = machineManager;
const { pageActions } = loadAdsModules();
const { assessTier, parseRedditorFor, parseKarma } = require('./assess-risk');
const { extractAccountInfo } = require('./healthcheck');
const { aiToneCheck, rewriteHints } = require('./ai-tone');
const { writeBlockReason } = require('../lib/account-safety');
const { detectChallenge } = require('./warmup');
const { writeMdReport } = require('../lib/md-report');
const { BLOCKED } = require('../lib/exit-codes');
const {
  extractSignals, fetchCommunityRules, reviewContent, writeRulesSnapshot, writeRulesReview,
} = require('../lib/community-rules');
const { installRedditStaticFallback, waitForModernUI } = require('../lib/reddit-ui');

const POST_TIER_ALLOWED = { T0: false, T1: false, T2: true, T3: true };
const LINK_TIER_ALLOWED = { T0: false, T1: false, T2: false, T3: true };
const REPORT_DIR = path.join(__dirname, '..', 'reports');

function writePostReport(entry, reportDir = REPORT_DIR) {
  try {
    fs.mkdirSync(reportDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.T]/g, '-').replace(/Z$/, '');
    const file = path.join(reportDir, `post-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify({ task: 'reddit-post', at: new Date().toISOString(), ...entry }, null, 2));
    writeMdReport(file, [
      '# 发帖审计',
      '',
      `- 状态: ${entry.status}`,
      `- 账号: serial ${entry.serial ?? '-'} ${entry.name ?? ''}`,
      `- 板块: ${entry.sub ?? '-'}`,
      `- 档位: ${entry.tier ?? '-'}`,
      `- 门控: ${entry.gate ?? '-'}`,
      `- 理由: ${entry.reason ?? '-'}`,
      ...(entry.communityRules ? [
        `- 规则来源: ${entry.communityRules.rules?.source ?? '-'}`,
        `- 规则抓取时间: ${entry.communityRules.rules?.fetchedAt ?? '-'}`,
        `- 规则 Hash: ${entry.communityRules.rules?.hash ?? '-'}`,
        `- 规则命中: ${entry.communityRules.hits?.length ?? 0}`,
        `- 规则未决: ${entry.communityRules.unresolved?.length ?? 0}`,
        `- Ack 匹配: ${entry.communityRules.confirmations?.hashMatches ? '是' : '否'}`,
      ] : []),
      '',
      '## 内容',
      '',
      `### ${entry.title || '-'}`,
      '',
      entry.text || '-',
      '',
    ].join('\n'));
    return file;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const options = {
    profileIds: [], serialNumbers: [], groupName: undefined, sub: null, title: null, text: null,
    file: null, link: null, flair: null, rulesAck: null, confirmedUnresolved: [], forceTier: null,
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
    } else if (arg === '--title') {
      options.title = argv[++index];
    } else if (arg === '--text') {
      options.text = argv[++index];
    } else if (arg === '--file') {
      options.file = argv[++index];
    } else if (arg === '--link') {
      options.link = argv[++index];
    } else if (arg === '--flair') {
      options.flair = argv[++index];
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
  if (!options.title || options.title.length < 5) throw new Error('--title 必填且至少 5 字');
  if (!options.text && !options.file) throw new Error('--text 或 --file 必填');
  if (options.file) {
    options.text = fs.readFileSync(path.resolve(options.file), 'utf8').trim();
    if (!options.text) throw new Error(`帖子正文为空: ${options.file}`);
  }
  if (!options.text || options.text.length < 100) {
    throw new Error('帖子正文过短 (至少 100 字), 低质量帖会拉低 CQS');
  }
  if (options.forceTier && !['T0', 'T1', 'T2', 'T3'].includes(options.forceTier)) {
    throw new Error('--force-tier 必须是 T0|T1|T2|T3');
  }
  return options;
}

function isPostSuccessUrl(value) {
  try {
    const url = new URL(value);
    return /reddit\.com\/r\/[^/]+\/comments\//.test(url.href)
      || /^t3_[a-z0-9]+$/i.test(url.searchParams.get('created') || '');
  } catch {
    return false;
  }
}

// 发帖后读取验证信号: 是否风控页 / 是否已跳转到帖子页
async function readPostVerify(page) {
  const currentUrl = page.url();
  const result = await page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    // 只认真实风控特征 (正文/评论里的 verify 单词不算)
    const url = (location.href || '').toLowerCase();
    const hasCaptchaEl = !!document.querySelector('.captcha, #captcha, input[name="id_captcha"], [data-testid*="captcha" i]');
    return {
      challenge: hasCaptchaEl
        || /(?:are you a human|verify your identity|unusual activity)/i.test(text)
        || /(?:^|\/)(?:captcha|verify|challenge)(?:\/|$|\?)/.test(url),
    };
  });
  return { ...result, onPostPage: isPostSuccessUrl(currentUrl) };
}

// 验证信号 → 判定 (纯函数, 便于测试)
function postVerification({ challenge, onPostPage }) {
  if (challenge) return { status: 'maybe-blocked', reason: '触发风控页' };
  if (onPostPage) return { status: 'posted', reason: null };
  return { status: 'maybe-blocked', reason: '未跳转到帖子页, 发帖可能未生效' };
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
      console.log(`⛔ 拒绝发帖: ${accountBlock.reason} (${accountBlock.code})`);
      writePostReport({
        status: 'rejected', gate: accountBlock.code, reason: accountBlock.reason,
        serial: profile.serial, name: profile.name, profileId: profile.id,
        sub: options.sub, title: options.title, text: options.text,
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

    if (!POST_TIER_ALLOWED[assessment.tier]) {
      console.log(`⛔ 拒绝发帖: 档位 ${assessment.tier} (${assessment.reason})`);
      console.log(`   发帖至少需要 T2 (注册 30 天 + 50 comment karma)。`);
      writePostReport({
        status: 'rejected', gate: 'tier', tier: assessment.tier, reason: assessment.reason,
        serial: profile.serial, name: profile.name, profileId: profile.id,
        sub: options.sub, title: options.title, text: options.text,
      });
      process.exitCode = BLOCKED;
      return;
    }

    // 3. 链接门控 (T2 禁止链接)：同时扫描正文，省略 --link 不能绕过。
    const postSignals = extractSignals({ action: 'post', title: options.title, text: options.text, link: options.link });
    if (postSignals.links.length && !LINK_TIER_ALLOWED[assessment.tier]) {
      console.log(`⛔ 拒绝带链接发帖: 档位 ${assessment.tier} 不允许链接 (仅 T3 可放链接且需 sub 允许)`);
      writePostReport({
        status: 'rejected', gate: 'link-tier', tier: assessment.tier,
        reason: `档位 ${assessment.tier} 不允许链接（含正文 URL）`,
        serial: profile.serial, name: profile.name, profileId: profile.id,
        sub: options.sub, title: options.title, text: options.text,
      });
      process.exitCode = BLOCKED;
      return;
    }

    // 3b. AI 痕迹检查 (太像 AI 的帖子会被 Poster Eligibility 过滤)
    const tone = aiToneCheck(options.title + ' ' + options.text);
    if (!tone.passed) {
      console.log(`⛔ 拒绝发帖: 内容太像 AI 生成 (得分 ${tone.score})`);
      for (const issue of tone.issues) console.log(`   - ${issue}`);
      console.log('   改写建议:');
      for (const hint of rewriteHints(tone.issues)) console.log(`   - ${hint}`);
      writePostReport({
        status: 'rejected', gate: 'ai-tone', tier: assessment.tier,
        reason: `AI 痕迹得分 ${tone.score}/10`, issues: tone.issues,
        serial: profile.serial, name: profile.name, profileId: profile.id,
        sub: options.sub, title: options.title, text: options.text,
      });
      process.exitCode = BLOCKED;
      return;
    }

    // 4. 社区规则门控：实时规则 hash 必须与显式 ack 一致，明确限制和未决项全部通过。
    // 此前不打开发帖页、不填写任何表单。
    let snapshot;
    try {
      snapshot = await fetchCommunityRules(page, options.sub);
      writeRulesSnapshot(snapshot);
    } catch (error) {
      const reason = `${error.message}; 规则无法获取时禁止发帖`;
      console.log(`⛔ 拒绝发帖: ${reason}`);
      writePostReport({
        status: 'rejected', gate: 'rules_fetch_failed', tier: assessment.tier, reason,
        communityRules: { rules: { subreddit: options.sub, source: null, fetchedAt: null, hash: null }, hits: [], unresolved: [], confirmations: { rulesAck: options.rulesAck, hashMatches: false, confirmedUnresolved: options.confirmedUnresolved, unconfirmed: [] }, fetchAttempts: error.attempts || [] },
        serial: profile.serial, name: profile.name, profileId: profile.id,
        sub: options.sub, title: options.title, text: options.text,
      });
      process.exitCode = BLOCKED;
      return;
    }
    const rulesReview = reviewContent(snapshot, {
      action: 'post', title: options.title, text: options.text, link: options.link, flair: options.flair,
      aiDetected: !tone.passed,
    }, { rulesAck: options.rulesAck, confirmedUnresolved: options.confirmedUnresolved });
    writeRulesReview(rulesReview, { action: 'post', title: options.title, text: options.text, link: options.link, flair: options.flair });
    if (!rulesReview.allowed) {
      console.log(`⛔ 拒绝发帖: ${rulesReview.reason}`);
      console.log(`   当前规则 hash: ${snapshot.hash}`);
      if (rulesReview.confirmations.unconfirmed.length) console.log(`   未确认项: ${rulesReview.confirmations.unconfirmed.join(', ')}`);
      writePostReport({
        status: 'rejected', gate: rulesReview.gate, tier: assessment.tier,
        reason: rulesReview.reason, communityRules: rulesReview,
        serial: profile.serial, name: profile.name, profileId: profile.id,
        sub: options.sub, title: options.title, text: options.text,
      });
      process.exitCode = BLOCKED;
      return;
    }

    // 5. 新版 Reddit 发帖页 (Web Components)
    await pageActions.goto(page, `https://www.reddit.com/r/${encodeURIComponent(options.sub)}/submit/`, {
      timeout: 120000,
    });
    await waitForModernUI(page, () => {
      const form = document.querySelector('r-post-composer-form');
      if (!customElements.get('r-post-composer-form') || !form) return false;
      const r = form.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }, '发帖表单');

    const titleInput = page.locator('post-composer-title textarea').first();
    const bodyInput = page.locator('shreddit-composer [contenteditable="true"][role="textbox"]').first();
    await titleInput.waitFor({ state: 'visible', timeout: 30000 });
    await bodyInput.waitFor({ state: 'visible', timeout: 30000 });
    await titleInput.fill(options.title);
    await bodyInput.fill(options.text + (options.link ? `\n\n${options.link}` : ''));
    await page.waitForTimeout(800);

    // r/ecommerce 当前强制 post flair。调用方未给 flair 时直接拒绝，不猜选项。
    const flairRequired = await page.locator('r-post-flairs-modal[flairs-required]').count() > 0;
    if (flairRequired && !options.flair) throw new Error('该社区要求 --flair，未提交');
    if (options.flair) {
      await page.locator('r-post-flairs-modal button').first().click();
      await page.waitForTimeout(600);
      let option = page.locator('faceplate-radio-input').filter({ hasText: options.flair }).first();
      if (!await option.isVisible().catch(() => false)) {
        const all = page.getByRole('button', { name: /Voir tous les flairs|Show all flairs/i }).first();
        if (await all.isVisible().catch(() => false)) {
          await all.click();
          await page.waitForTimeout(500);
          option = page.locator('faceplate-radio-input').filter({ hasText: options.flair }).first();
        }
      }
      if (!await option.isVisible().catch(() => false)) throw new Error(`未找到 flair: ${options.flair}，未提交`);
      await option.click();
      const add = page.getByRole('button', { name: /^(Ajouter|Add)$/i }).first();
      await add.waitFor({ state: 'visible', timeout: 10000 });
      await add.click();
      await page.waitForTimeout(500);
    }

    const submit = page.locator('r-post-form-submit-button#submit-post-button button').first();
    await submit.waitFor({ state: 'visible', timeout: 30000 });
    await submit.click();

    // 6. 等待并验证
    // 成功必须同时满足: 无风控页 + 已跳转到帖子页 (/comments/)。停留在 /submit
    // 说明提交未生效, 不能报成功。
    let verify = { challenge: false, onPostPage: false };
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await page.waitForTimeout(5000); // 新版 post-check + CreatePost 可能耗时 17–30 秒
      verify = await readPostVerify(page);
      if (verify.challenge || verify.onPostPage) break;
    }
    const verdict = postVerification(verify);
    if (verdict.status !== 'posted') {
      console.log(`⚠️ 发帖可能未成功 (${verdict.reason})。档位 ${assessment.tier}。`);
      process.exitCode = 1;
      return;
    }

    console.log(`✅ [${label}] ${profile.name}: 帖子已提交到 r/${options.sub}`);
    console.log(`   档位 ${assessment.tier} (${assessment.reason})${options.link ? ', 含链接 (T3)' : ''}`);
    console.log(`   标题: ${options.title}`);
    writePostReport({
      status: 'posted', tier: assessment.tier, reason: assessment.reason,
      serial: profile.serial, name: profile.name, profileId: profile.id,
      sub: options.sub, title: options.title, text: options.text, communityRules: rulesReview,
    });
  } finally {
    await manager.closeAll();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('出错:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, postVerification, isPostSuccessUrl, writePostReport, POST_TIER_ALLOWED, LINK_TIER_ALLOWED };
