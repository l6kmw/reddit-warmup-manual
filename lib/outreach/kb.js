'use strict';
/**
 * kb.js — 客服知识库（简单结构化，无外部向量依赖）
 *
 * 用途：AI 客服回答业务问题时只能引用知识库内容，绝不编造。
 *
 * 存储：state/outreach-kb.json
 *   { schemaVersion: 1, items: [{ id, title, keywords[], content }] }
 *
 * v1 检索：关键词/子串打分（title/keywords/content 命中加权），topK 返回；
 *         不依赖 embedding 服务，后续可平滑升级为向量检索。
 *
 * CLI：
 *   node lib/outreach/kb.js --init            # 创建空库 + 模板示例（占位，供参考/删除）
 *   node lib/outreach/kb.js --list            # 列出全部条目
 *   node lib/outreach/kb.js --add "标题|关键词1,关键词2|内容"   # 添加一条
 *   node lib/outreach/kb.js --del <id>        # 删除一条
 *   node lib/outreach/kb.js --search "关键词"  # 检索
 */

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const STATE_DIR = process.env.OUTREACH_STATE_DIR || path.resolve(__dirname, '..', '..', 'state');
const KB_FILE = path.join(STATE_DIR, 'outreach-kb.json');

function makeId() {
  return `kb-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
}

function readKb() {
  try {
    const data = JSON.parse(fs.readFileSync(KB_FILE, 'utf8'));
    if (Array.isArray(data.items)) return data;
  } catch { /* ignore */ }
  return { schemaVersion: 1, items: [] };
}

function writeKb(kb) {
  fs.mkdirSync(path.dirname(KB_FILE), { recursive: true });
  const tmp = `${KB_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(kb, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, KB_FILE);
}

// ---- 纯函数：关键词规范化 / 打分检索 ----

function normalizeTokens(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5_-]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

/**
 * 条目-查询 相关度打分。
 * @param {object} item 知识库条目
 * @param {Array<string>} tokens 查询词（已规范化）
 * @returns {number}
 */
function scoreItem(item, tokens) {
  if (!item || !tokens || !tokens.length) return 0;
  const keywordSet = new Set((item.keywords || []).map((k) => String(k).toLowerCase()));
  const title = String(item.title || '').toLowerCase();
  const content = String(item.content || '').toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (keywordSet.has(token)) score += 10;
    if (title.includes(token)) score += 5;
    if (content.includes(token)) score += 1;
  }
  return score;
}

/**
 * 知识库检索：返回相关条目（按分数降序，topK）。
 * @param {Array<object>} items 条目列表
 * @param {string} query 查询文本（如对方消息）
 * @param {{topK?: number, minScore?: number}} [opts]
 * @returns {Array<object>}
 */
function searchItems(items, query, { topK = 3, minScore = 1, includeInactive = false } = {}) {
  const tokens = normalizeTokens(query);
  if (!tokens.length) return [];
  return (items || [])
    .filter((item) => includeInactive || String(item.status || 'active') === 'active')
    .map((item) => ({ item, score: scoreItem(item, tokens) }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((r) => r.item);
}

/** 把条目渲染成注入 system prompt 的文本块 */
function itemsToPromptText(items) {
  return (items || [])
    .map((item, i) => `### ${i + 1}. ${item.title || item.id}\n${item.content || ''}`)
    .join('\n\n');
}

// ---- 数据操作 ----

/** 添加一条（title/keywords/content）；keywords 接受数组或逗号分隔字符串 */
function addItem({ title, keywords = [], content = '' } = {}) {
  const kb = readKb();
  const item = {
    id: makeId(),
    title: String(title || '').trim(),
    keywords: Array.isArray(keywords)
      ? keywords.map((k) => String(k).trim()).filter(Boolean)
      : String(keywords || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    content: String(content || '').trim(),
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  if (!item.title) return { ok: false, error: '标题不能为空' };
  kb.items.push(item);
  writeKb(kb);
  return { ok: true, id: item.id, total: kb.items.length };
}

/** 删除一条 */
function removeItem(id) {
  const kb = readKb();
  const before = kb.items.length;
  kb.items = kb.items.filter((i) => i.id !== id);
  if (kb.items.length === before) return { ok: false, error: 'id 不存在' };
  writeKb(kb);
  return { ok: true, total: kb.items.length };
}

/**
 * 更新一条；未传字段保持原值。
 * @param {string} id
 * @param {{title?: string, keywords?: string[]|string, content?: string, status?: string}} patch
 */
function updateItem(id, patch = {}) {
  const kb = readKb();
  const item = kb.items.find((i) => i.id === id);
  if (!item) return { ok: false, error: 'id 不存在' };
  if (patch.title !== undefined) item.title = String(patch.title || '').trim();
  if (patch.keywords !== undefined) {
    item.keywords = Array.isArray(patch.keywords)
      ? patch.keywords.map((k) => String(k).trim()).filter(Boolean)
      : String(patch.keywords || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  }
  if (patch.content !== undefined) item.content = String(patch.content || '').trim();
  if (patch.status !== undefined) {
    const status = String(patch.status || '').trim();
    if (!['active', 'draft', 'disabled'].includes(status)) return { ok: false, error: 'status 必须是 active / draft / disabled' };
    item.status = status;
  }
  if (!item.title) return { ok: false, error: '标题不能为空' };
  if (!item.content) return { ok: false, error: '内容不能为空' };
  item.keywords = [...new Set(item.keywords || [])];
  item.updatedAt = new Date().toISOString();
  writeKb(kb);
  return { ok: true, item, total: kb.items.length };
}

/** 初始化：空库 + 模板示例（占位条目标记 TEMPLATE，供参考后删除） */
function initKb() {
  const kb = readKb();
  if (kb.items.length) return { ok: false, error: `知识库存有 ${kb.items.length} 条，拒绝覆盖；如需重置请先 --del` };
  const templates = [
    {
      id: makeId(),
      title: '[TEMPLATE] 产品示例：智能温控咖啡杯',
      keywords: ['coffee cup', 'mug', 'temperature', '智能杯', '保温杯'],
      content: '产品名：AeroTemp 智能温控杯（示例模板，请替换为真实产品资料）。\n卖点：App 控温、45–65°C 保温、USB-C 充电。\n价格：$49.99（不含税）。\n物流：US 5–8 工作日，免费送货。\n售后：30 天无理由退换。\n（TEMPLATE——正式使用前请删除或改写）',
      status: 'draft',
      createdAt: new Date().toISOString(),
    },
  ];
  kb.items = templates;
  writeKb(kb);
  return { ok: true, total: kb.items.length, template: true };
}

/** 检索入口（返回 items 或空数组） */
function search(query, opts) {
  const kb = readKb();
  return searchItems(kb.items, query, opts);
}

function listItems() {
  return readKb().items;
}

// ==================== CLI ====================

function parseArgs(argv) {
  const opts = { action: null, value: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--init') opts.action = 'init';
    else if (arg === '--list') opts.action = 'list';
    else if (arg === '--search') opts.action = 'search';
    else if (arg === '--add') { opts.action = 'add'; opts.value = argv[i + 1]; i += 1; }
    else if (arg === '--del') { opts.action = 'del'; opts.value = argv[i + 1]; i += 1; }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  switch (opts.action) {
    case 'init': {
      const r = initKb();
      console.log(r.ok ? `[kb] 已创建空知识库（${r.total} 条模板示例，请按需 --add / --del）` : `[kb] ${r.error}`);
      return;
    }
    case 'list': {
      const items = listItems();
      console.log(`[kb] 共 ${items.length} 条:`);
      for (const it of items) console.log(`  ${it.id} | ${it.title} | kw=${(it.keywords || []).join(',')}`);
      return;
    }
    case 'add': {
      if (!opts.value) { console.error('用法: --add "标题|关键词1,关键词2|内容"'); process.exit(2); }
      const [title, keywords = '', content = ''] = opts.value.split('|').map((s) => s.trim());
      const r = addItem({ title, keywords, content });
      console.log(r.ok ? `[kb] 已添加 ${r.id}（共 ${r.total} 条）` : `[kb] ${r.error}`);
      return;
    }
    case 'del': {
      if (!opts.value) { console.error('用法: --del <id>'); process.exit(2); }
      const r = removeItem(opts.value);
      console.log(r.ok ? `[kb] 已删除（剩余 ${r.total} 条）` : `[kb] ${r.error}`);
      return;
    }
    case 'search': {
      if (!opts.value) { console.error('用法: --search "关键词"'); process.exit(2); }
      const hits = search(opts.value, { topK: 5 });
      console.log(`[kb] “${opts.value}” 命中 ${hits.length} 条:`);
      for (const it of hits) console.log(`  ${it.title} | ${it.content.slice(0, 80)}…`);
      return;
    }
    default:
      console.log('用法: --init | --list | --add "标题|关键词|内容" | --del <id> | --search "词"');
  }
}

if (require.main === module) {
  main();
}

// ==================== 模块导出 ====================

module.exports = {
  KB_FILE,
  normalizeTokens,
  scoreItem,
  searchItems,
  itemsToPromptText,
  readKb,
  writeKb,
  addItem,
  updateItem,
  removeItem,
  initKb,
  search,
  listItems,
};