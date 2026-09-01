'use strict';
/**
 * personalize.test.js — 触达消息去模板化核心逻辑单测。
 * 覆盖：提示构造、校验、幂等、provider 失败/兜底、批量重写 dry-run 不落盘。
 */
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// STATE_DIR 在 require 时绑定：必须先设隔离目录再 require
const TEST_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'outreach-q-'));
process.env.OUTREACH_STATE_DIR = TEST_STATE_DIR;

const personalize = require('./personalize');

function pass(name) {
  console.log(`[personalize] ${name} passed`);
}

// ---- buildPersonalizePrompt ----
{
  const p = personalize.buildPersonalizePrompt({
    username: 'BobasLostBounty',
    sub: 'lawncare',
    postTitle: 'No sign of roots on sod after 23 days',
    commentSnippet: 'Jus got it installed last weekend',
  });
  assert.ok(p.includes('BobasLostBounty'), 'prompt 含 username');
  assert.ok(p.includes('lawncare'), 'prompt 含 sub');
  assert.ok(p.includes('No sign of roots on sod after 23 days'), 'prompt 含 postTitle');
  assert.ok(p.includes('Jus got it installed last weekend'), 'prompt 含 commentSnippet');
  assert.ok(p.toLowerCase().includes('marketing template'), 'prompt 含去模板指令');
  pass('buildPersonalizePrompt');
}

// ---- validatePersonalized ----
{
  const ok = personalize.validatePersonalized('Honestly the 23-day sod thing worries me too. Did your installer say anything about the root check? What does the vendor recommend?');
  assert.strictEqual(ok.ok, true, '正常文本通过');
  assert.deepStrictEqual(ok.errors, []);

  const empty = personalize.validatePersonalized('');
  assert.strictEqual(empty.ok, false);
  assert.ok(empty.errors.includes('empty'));

  const placeholder = personalize.validatePersonalized('Hi {username}, nice post');
  assert.ok(placeholder.errors.includes('leftover_placeholder'), '占位符残留被拦');

  const banned = personalize.validatePersonalized('Hi, I saw your comment and wanted to connect with you about lawn care.');
  assert.ok(banned.errors.some((e) => e.startsWith('banned_marker:')), '模板标记被拦');

  const short = personalize.validatePersonalized('Cool post.');
  assert.ok(short.errors.some((e) => e.startsWith('too_short:')), '过短被拦');

  const long = personalize.validatePersonalized(Array(120).fill('word').join(' '));
  assert.ok(long.errors.some((e) => e.startsWith('too_long:')), '过长被拦');
  pass('validatePersonalized');
}

// ---- isPersonalized ----
{
  assert.strictEqual(personalize.isPersonalized({ personalziedAt: 'x' }), false);
  assert.strictEqual(personalize.isPersonalized({ personalizedAt: '2026-09-01T00:00:00Z' }), true);
  assert.strictEqual(personalize.isPersonalized({}), false);
  pass('isPersonalized');
}

// ---- maybePersonalize：成功 / 校验失败兜底 / LLM 失败兜底 / provider 不支持 ----
const good = { ok: true, text: 'That 23-day sod situation sounds rough. Is the grass at least greening up anywhere? What did the contractor say when you asked?' };
{
  const providerOk = { completeText: async () => good };
  personalize.maybePersonalize('Hi {username}, I saw your comment', providerOk, { username: 'BobasLostBounty', postTitle: 'x', commentSnippet: 'y', sub: 'lawncare' }).then((r) => {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.draft, good.text);
    pass('maybePersonalize ok');
  }).catch((e) => { console.error(e); process.exit(1); });
}

setImmediate(() => {
  // 校验失败 → kept 原稿（不透传模板感文本）
  const providerBad = { completeText: async () => ({ ok: true, text: 'Hi, I saw your comment on this. Hope this finds you well.' }) };
  personalize.maybePersonalize('tmpl', providerBad, { username: 'u' }).then((r) => {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.kept, true);
    assert.ok(String(r.error || '').includes('banned_marker'), '模板句被校验拒绝');
  }).then(() => pass('maybePersonalize validation fallback'));

  // LLM 报错 → kept 原稿
  const providerErr = { completeText: async () => ({ ok: false, error: 'LLM HTTP 500' }) };
  personalize.maybePersonalize('tmpl', providerErr, { username: 'u' }).then((r) => {
    assert.strictEqual(r.kept, true);
    assert.ok(String(r.error || '').includes('500'));
  }).then(() => pass('maybePersonalize llm error fallback'));

  // provider 不支持 completeText（mock）→ kept
  personalize.maybePersonalize('tmpl', {}, { username: 'u' }).then((r) => {
    assert.strictEqual(r.kept, true);
    assert.strictEqual(r.error, 'provider_not_supported');
  }).then(() => pass('maybePersonalize mock fallback'));

  // 空草稿 → kept
  personalize.maybePersonalize('', { completeText: async () => good }, { username: 'u' }).then((r) => {
    assert.strictEqual(r.kept, true);
    assert.strictEqual(r.error, 'empty_draft');
  }).then(() => pass('maybePersonalize empty draft'));
});

// ---- rewriteQueueDrafts：dry-run 不落盘 + apply 落盘 + 幂等跳过 ----
{
  const q = {
    schemaVersion: 2,
    items: [
      { id: 'a', username: 'UserA', status: 'pending', draft: 'Hi {username} template A', postTitle: 'postA', commentSnippet: 'cA', sub: 's', personalizedAt: null },
      { id: 'b', username: 'UserB', status: 'pending', draft: 'Hi {username} template B', postTitle: 'postB', commentSnippet: 'cB', sub: 's', personalizedAt: null },
      { id: 'c', username: 'UserC', status: 'sent', draft: 'already sent', postTitle: 'postC', commentSnippet: 'cC', sub: 's', personalizedAt: null },
      { id: 'd', username: 'UserD', status: 'pending', draft: 'already personalized', postTitle: 'postD', commentSnippet: 'cD', sub: 's', personalizedAt: '2026-09-01T00:00:00Z' },
    ],
  };
  fs.writeFileSync(path.join(TEST_STATE_DIR, 'outreach-queue.json'), JSON.stringify(q), 'utf8');

  const goodText = (n) => ({ ok: true, text: `That ${n} post really got me thinking about your point. Do you still feel the same way now?` });
  const provider = { completeText: async ({ user }) => goodText(user.includes('postA') ? 'A' : 'B') };

  personalize.rewriteQueueDrafts({ provider, limit: 0, apply: false }).then((r) => {
    assert.strictEqual(r.scanned, 2, '只扫描 pending 未个性化（d 跳过、c 非 pending 跳过）');
    assert.strictEqual(r.rewritten, 2);
    assert.strictEqual(r.kept, 0);
    const after = JSON.parse(fs.readFileSync(path.join(TEST_STATE_DIR, 'outreach-queue.json'), 'utf8'));
    assert.strictEqual(after.items[0].draft, q.items[0].draft, 'dry-run 不落盘');
    return personalize.rewriteQueueDrafts({ provider, limit: 0, apply: true });
  }).then((r) => {
    assert.strictEqual(r.rewritten, 2);
    const after = JSON.parse(fs.readFileSync(path.join(TEST_STATE_DIR, 'outreach-queue.json'), 'utf8'));
    assert.notStrictEqual(after.items[0].draft, q.items[0].draft, 'apply 落盘');
    assert.ok(after.items[0].personalizedAt, '打 personalizedAt');
    return personalize.rewriteQueueDrafts({ provider, limit: 0, apply: true });
  }).then((r2) => {
    assert.strictEqual(r2.scanned, 0, '已个性化条目幂等跳过');
  }).then(() => {
    fs.rmSync(TEST_STATE_DIR, { recursive: true, force: true });
    pass('rewriteQueueDrafts dry-run/apply/idempotent');
  }).catch((e) => { console.error(e); process.exit(1); });
}