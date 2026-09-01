'use strict';
/**
 * kb.test.js — 客服知识库测试
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));
process.env.OUTREACH_STATE_DIR = TMP_DIR;

const kb = require('./kb');

// ---- 纯函数 ----
{
  assert.deepStrictEqual(kb.normalizeTokens('Coffee cup - 12oz'), ['coffee', 'cup', '12oz']);
  const item = { title: 'Smart Mug', keywords: ['coffee', 'mug'], content: 'Keeps coffee hot for 2 hours.' };
  assert.strictEqual(kb.scoreItem(item, ['mug']), 15, '关键词10 + 标题5');
  assert.strictEqual(kb.scoreItem(item, ['coffee']), 11, '关键词10 + 内容1（标题不含 coffee）');
  assert.strictEqual(kb.scoreItem(item, ['nope']), 0);
  const hits = kb.searchItems([item], 'coffee mug', { topK: 5 });
  assert.strictEqual(hits.length, 1);
  assert.match(kb.itemsToPromptText([item]), /Smart Mug/);
}

// ---- init：空库 + 模板 ----
{
  const r = kb.initKb();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.template, true);
  assert.ok(kb.listItems().length >= 1);
  // 已存在条目时不给覆盖
  const again = kb.initKb();
  assert.strictEqual(again.ok, false);
}

// ---- 添加/检索 ----
{
  const added = kb.addItem({ title: 'Shipping Policy', keywords: ['shipping', 'delivery', '物流'], content: 'Free shipping to US, 5-8 business days.' });
  assert.strictEqual(added.ok, true);
  const hit = kb.search('how long does shipping take', { topK: 3 });
  assert.ok(hit.some((i) => i.title === 'Shipping Policy'), '关键词命中物流条目');
  const noHit = kb.search('unrelated topic here', { topK: 3 });
  assert.strictEqual(noHit.length, 0);
  assert.strictEqual(kb.addItem({ title: '' }).ok, false, '空标题拒绝');
}

// ---- 删除 ----
{
  const list = kb.listItems();
  const one = list[0];
  const r = kb.removeItem(one.id);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(kb.removeItem('nope').ok, false);
  assert.strictEqual(kb.listItems().some((i) => i.id === one.id), false);
}

fs.rmSync(TMP_DIR, { recursive: true, force: true });
console.log('kb tests passed');