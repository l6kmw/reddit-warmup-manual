'use strict';
/**
 * reply-policy.test.js — 回复决策策略测试
 */
const assert = require('node:assert/strict');
const policy = require('./reply-policy');

// ---- 分类 ----
{
  assert.strictEqual(policy.classify('hi there!').category, policy.CATEGORY.GREETING);
  assert.strictEqual(policy.classify('Hello').category, policy.CATEGORY.GREETING);
  assert.strictEqual(policy.classify('how are you').category, policy.CATEGORY.SMALLTALK);
  assert.strictEqual(policy.classify('thanks for replying!').category, policy.CATEGORY.THANKS);
  assert.strictEqual(policy.classify('ok good to know').category, policy.CATEGORY.SMALLTALK);
}

// ---- 敏感/业务 → 人工 ----
{
  const interest = policy.classify('how much does it cost?');
  assert.strictEqual(interest.category, policy.CATEGORY.INTEREST);
  assert.strictEqual(interest.needsHuman, true);
  assert.match(interest.reason, /purchase_intent/);

  const buy = policy.classify("where can I buy this?");
  assert.strictEqual(buy.needsHuman, true);

  const productQ = policy.classify('What is this product made of?');
  assert.strictEqual(productQ.category, policy.CATEGORY.INTEREST, '产品类咨询归入业务意向（保守转人工）');
  assert.strictEqual(productQ.needsHuman, true);

  const complaint = policy.classify('I want a refund, it never arrived');
  assert.strictEqual(complaint.category, policy.CATEGORY.COMPLAINT);
  assert.strictEqual(complaint.needsHuman, true);

  const toxic = policy.classify('you are a fucking scam');
  assert.strictEqual(toxic.category, policy.CATEGORY.TOXIC);
  assert.strictEqual(toxic.needsHuman, true);

  const question = policy.classify('Do you like Reddit?');
  assert.strictEqual(question.category, policy.CATEGORY.QUESTION);
  assert.strictEqual(question.needsHuman, true);
}

// ---- 边界 ----
{
  // how are you? 带问号 → 小谈（自动回，不误判成一般疑问）
  const hy = policy.classify('how are you?');
  assert.strictEqual(hy.category, policy.CATEGORY.SMALLTALK);
  assert.strictEqual(hy.needsHuman, false);

  assert.strictEqual(policy.classify('').needsHuman, true, '空消息转人工');
  assert.strictEqual(policy.classify('hmm').needsHuman, true, '过短且无特征转人工');
  assert.strictEqual(policy.classify('!!!???###').needsHuman, true, '乱码转人工');
  assert.strictEqual(policy.classify('yo').category, policy.CATEGORY.GREETING, '"yo" 是口语问候，自动回');
  assert.strictEqual(policy.classify('yo').needsHuman, false);

  const generic = policy.classify('I saw your message and wanted to respond');
  assert.strictEqual(generic.category, policy.CATEGORY.OTHER);
  assert.strictEqual(generic.needsHuman, false, '通用内容自动回（保持不冷场）');
  assert.strictEqual(generic.replyable, true);
}

// ---- isAutoReplyCategory ----
{
  assert.strictEqual(policy.isAutoReplyCategory(policy.CATEGORY.GREETING), true);
  assert.strictEqual(policy.isAutoReplyCategory(policy.CATEGORY.INTEREST), false);
  assert.strictEqual(policy.isAutoReplyCategory(policy.CATEGORY.COMPLAINT), false);
}

// ---- readableRatio ----
{
  assert.strictEqual(policy.readableRatio('hello world'), 1);
  assert.ok(policy.readableRatio('!!!!???###') < 0.5);
  assert.strictEqual(policy.readableRatio(''), 0);
}

console.log('reply-policy tests passed');