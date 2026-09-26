'use strict';
/**
 * ai-provider.test.js — 客服生成引擎测试（MockProvider + 工厂）
 */
const assert = require('node:assert/strict');
const ai = require('./ai-provider');

(async () => {
// ---- createProvider ----
{
  const p = ai.createProvider({ type: 'mock' });
  assert.ok(p instanceof ai.MockProvider);
  const p2 = ai.createProvider({});
  assert.strictEqual(p2.constructor.name, 'MockProvider', '缺省即 mock');
  assert.ok(ai.listProviders().includes('mock'));
  assert.throws(() => ai.createProvider({ type: 'nope' }), /未知 AI provider/);
}

// ---- MockProvider：寒暄自动回复 ----
{
  const p = ai.createProvider({ type: 'mock' });
  const r = await p.generateReply({ username: 'Bob', message: 'hi there!' });
  assert.strictEqual(r.decision, ai.DECISION.REPLY);
  assert.strictEqual(r.category, 'greeting');
  assert.ok(r.text.includes('Bob'), '模板渲染含用户名');
}

// ---- MockProvider：购买意向 → 人工 ----
{
  const p = ai.createProvider({ type: 'mock' });
  const r = await p.generateReply({ username: 'Bob', message: 'how much is shipping?' });
  assert.strictEqual(r.decision, ai.DECISION.NEEDS_HUMAN);
  assert.strictEqual(r.text, null, '转人工不生成回复文本');
  assert.match(r.reason, /purchase_intent/);
}

// ---- MockProvider：投诉 → 人工 ----
{
  const r = await ai.createProvider({}).generateReply({ username: 'C', message: 'I want a refund please' });
  assert.strictEqual(r.decision, ai.DECISION.NEEDS_HUMAN);
  assert.strictEqual(r.category, 'complaint');
}

// ---- MockProvider：致谢 / 小谈 ----
{
  const p = ai.createProvider({});
  const thanks = await p.generateReply({ username: 'D', message: 'thanks!' });
  assert.strictEqual(thanks.decision, ai.DECISION.REPLY);
  assert.strictEqual(thanks.category, 'thanks');
  assert.ok(thanks.text.length > 0);

  const small = await p.generateReply({ username: 'E', message: 'how are you' });
  assert.strictEqual(small.decision, ai.DECISION.REPLY);
  assert.strictEqual(small.category, 'smalltalk');
}

// ---- MockProvider：自定义模板覆盖 ----
{
  const p = ai.createProvider({ config: { templates: { greeting: 'Hi {username}, custom hello!' } } });
  const r = await p.generateReply({ username: 'F', message: 'hello' });
  assert.ok(r.text.includes('custom hello'));
  assert.ok(r.text.includes('F'));
}

// ---- MockProvider：空消息 ----
{
  const r = await ai.createProvider({}).generateReply({ username: 'G', message: '' });
  assert.strictEqual(r.decision, ai.DECISION.NEEDS_HUMAN);
}

// ---- 决策协议解析 ----
{
  const plain = ai.parseProviderResponse('Sure, happy to help!');
  assert.strictEqual(plain.decision, 'reply');
  assert.ok(plain.text.includes('Sure'));

  const esc = ai.parseProviderResponse('[NEEDS_HUMAN] refund request');
  assert.strictEqual(esc.decision, 'needs_human');
  assert.match(esc.reason, /refund/);
  assert.strictEqual(esc.text, null);

  assert.strictEqual(ai.parseProviderResponse('').decision, 'skip');
  assert.strictEqual(ai.parseProviderResponse(undefined).decision, 'skip');
}

// ---- 系统提示词 / 用户消息 ----
{
  const sp = ai.buildSystemPrompt({ username: 'Shop35', knowledge: 'Product: Mug, $19.99' });
  assert.match(sp, /Shop35/);
  assert.match(sp, /Mug, \$19\.99/);
  assert.match(sp, /NEVER invent/);
  assert.match(sp, /\[NEEDS_HUMAN\]/);

  const um = ai.buildUserMessage({
    history: [{ from: 'me', body: 'Hi' }, { from: 'them', body: 'hello' }],
    message: 'how much?',
  });
  assert.match(um, /You: Hi/);
  assert.match(um, /User \(newest\): how much\?/);
}

// ---- OpenAIProvider：无 key → 保守转人工 ----
{
  const p = new ai.OpenAIProvider({ apiKey: '' });
  const r = await p.generateReply({ message: 'how much' });
  assert.strictEqual(r.decision, 'needs_human');
  assert.match(r.reason, /LLM_API_KEY/);
}

// ---- OpenAIProvider：mock fetch 成功 ----
{
  let seen = null;
  const fetchImpl = async (url, options) => {
    seen = { url, options };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Hi! It costs $19.99.' } }] }) };
  };
  const p = new ai.OpenAIProvider({ apiKey: 'sk-test', fetchImpl });
  p.setKnowledge('Product: Mug, $19.99');
  const r = await p.generateReply({ username: 'Shop35', message: 'how much is the mug?' });
  assert.strictEqual(r.decision, 'reply');
  assert.match(r.text, /\$19\.99/);
  assert.match(seen.url, /\/v1\/chat\/completions/);
  assert.strictEqual(seen.options.headers.Authorization, 'Bearer sk-test');
  const body = JSON.parse(seen.options.body);
  assert.strictEqual(body.model, 'gpt-4o-mini');
  assert.ok(body.messages[0].content.includes('Mug, $19.99'), '知识库注入 system prompt');
}

// ---- OpenAIProvider：模型输出 [NEEDS_HUMAN] ----
{
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '[NEEDS_HUMAN] refund request from user' } }] }) });
  const p = new ai.OpenAIProvider({ apiKey: 'sk-test', fetchImpl });
  const r = await p.generateReply({ message: 'i want a refund' });
  assert.strictEqual(r.decision, 'needs_human');
  assert.match(r.reason, /refund/);
}

// ---- OpenAIProvider：HTTP 错误 → 保守转人工 ----
{
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
  const p = new ai.OpenAIProvider({ apiKey: 'sk-test', fetchImpl });
  const r = await p.generateReply({ message: 'hi' });
  assert.strictEqual(r.decision, 'needs_human');
  assert.match(r.reason, /429/);
}

// ---- OpenAIProvider：网络异常 → 保守转人工 ----
{
  const fetchImpl = async () => { throw new Error('ECONNRESET'); };
  const p = new ai.OpenAIProvider({ apiKey: 'sk-test', fetchImpl });
  const r = await p.generateReply({ message: 'hi' });
  assert.strictEqual(r.decision, 'needs_human');
  assert.match(r.reason, /ECONNRESET/);
}

// ---- createProvider('openai') ----
{
  const p = ai.createProvider({ type: 'openai', config: { apiKey: '' } });
  assert.ok(p instanceof ai.OpenAIProvider);
  assert.ok(ai.listProviders().includes('openai'));
}

// ---- MockProvider：过短/无特征消息也要回答（用户要求） ----
{
  const p = ai.createProvider({ type: 'mock' });
  const r = await p.generateReply({ username: 'u1', message: 'you' });
  assert.strictEqual(r.decision, 'reply', '短消息自动回');
  assert.ok(r.text && r.text.length > 0, '有回复内容');
  const r2 = await p.generateReply({ username: 'u1', message: 'hmm' });
  assert.strictEqual(r2.decision, 'reply', '无特征消息自动回');
}

console.log('ai-provider tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});