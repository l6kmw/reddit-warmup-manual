'use strict';
/**
 * ai-provider.js — 客服 AI 生成引擎（provider 抽象）
 *
 * 用户决策（2026-09-01）：AI 提供商先搭框架、key 后补。本模块定义统一接口：
 *
 *   createProvider({ type, config }) -> provider
 *   provider.generateReply(context) -> Promise<{
 *     decision: 'reply' | 'needs_human' | 'skip',
 *     category, reason?, text?
 *   }>
 *
 * v1 内置 MockProvider（规则 + 模板，不依赖任何 API Key）：
 *   - 寒暄/闲聊/致谢 → 生成礼貌模板回复
 *   - 购买意向/投诉/辱骂/疑问/乱码 → needs_human（转人工）
 * 后续接入真实 LLM（openai / deepseek 等）时扩展 PROVIDERS 注册表，
 * config 中携带 apiKey 等凭据（凭据建议走环境变量，勿入库）。
 *
 * 生成上下文 context：
 *   {
 *     username: string,              // Reddit 用户名
 *     message: string,               // 对方最新一条消息
 *     history: Array<{from,body,ts}>,// 最近对话（含本机发送）
 *     userProfile: object,           // 该用户来源上下文（sub/postTitle/commentSnippet）
 *   }
 */

'use strict';

const replyPolicy = require('./reply-policy');

const DECISION = {
  REPLY: 'reply',
  NEEDS_HUMAN: 'needs_human',
  SKIP: 'skip',
};

// ---- Mock 模板（按分类；不推销、不承诺、简短礼貌） ----

const MOCK_TEMPLATES = {
  greeting: 'Hi {username}! Thanks for the message — how are you doing today?',
  smalltalk: "Glad to hear it! Hope everything's going well on your end.",
  thanks: "You're welcome! Happy to help anytime.",
  unclear: 'Ha, fair enough! What else is on your mind?',
  other: 'Thanks for reaching out! Let me know if there is anything you would like to chat about.',
};

/** 模板渲染（{username} 占位） */
function renderTemplate(template, ctx) {
  return String(template || '').split('{username}').join(String(ctx && ctx.username || 'friend'));
}

/**
 * MockProvider：规则分类 + 模板回复（离线可用）。
 */
class MockProvider {
  /**
   * @param {{templates?: object, maxReplyLength?: number}} [config]
   */
  constructor(config = {}) {
    this.templates = { ...MOCK_TEMPLATES, ...(config.templates || {}) };
    this.maxReplyLength = Number(config.maxReplyLength || 300);
  }

  /**
   * Mock 不提供通用文本生成（个性化需要真实 LLM）。
   * @returns {Promise<{ok: boolean, error: string}>}
   */
  async completeText() {
    return { ok: false, error: 'mock provider 不提供个性化生成（请配置 openai 等真实 LLM）' };
  }

  /**
   * 生成回复决策。
   * @param {object} context 见模块头注释
   * @returns {Promise<{decision: string, category?: string, reason?: string, text?: string}>}
   */
  async generateReply(context) {
    const ctx = context || {};
    const message = String(ctx.message || '').trim();
    const username = String(ctx.username || '').trim();
    const { category, needsHuman, replyable, reason } = replyPolicy.classify(message);

    if (needsHuman || !replyable) {
      return { decision: DECISION.NEEDS_HUMAN, category, reason: reason || 'manual_review', text: null };
    }
    const template = this.templates[category] || this.templates.other;
    let text = renderTemplate(template, ctx);
    if (text.length > this.maxReplyLength) text = `${text.slice(0, this.maxReplyLength - 1)}…`;
    return { decision: DECISION.REPLY, category, text };
  }
}

// ==================== 真实 LLM（OpenAI 兼容） ====================

/** 转人工决策前缀：模型以该前缀开头时，整条回复视为“需人工”，前缀后为原因 */
const NEEDS_HUMAN_PREFIX = '[NEEDS_HUMAN]';

/**
 * 客服系统提示词：人格 + 知识库 + 规则（仅知识库可答业务，禁止编造）。
 * @param {{username?: string, knowledge?: string}} [opts]
 * @returns {string}
 */
function buildSystemPrompt({ username = '', knowledge = '' } = {}) {
  const kb = String(knowledge || '').trim();
  return [
    'You are a friendly AI customer-service assistant on Reddit. Be natural, warm, and concise (1-3 short sentences).',
    `Your assistant profile: ${username || 'our shop'}. A Reddit user replied to our outreach message.`,
    '',
    '## Rules',
    '1. Answer product/business questions ONLY from the knowledge base below. NEVER invent prices, shipping times, features, or policies.',
    '2. If a question is not covered by the knowledge base, say you will check and get back instead of guessing.',
    `3. Start your reply with "${NEEDS_HUMAN_PREFIX} " and a short reason (nothing else) ONLY for: complaints/refunds, abuse, threats, personal/legal/account questions, or anything you cannot answer from the knowledge base.`,
    '4. For casual chat (greetings, small talk, thanks) answer naturally without the prefix.',
    '5. Vary your wording every time. Never reuse the same greeting, opener, or sentence verbatim across conversations — a real person does not repeat themselves word-for-word.',
    '6. For very short or vague messages ("you", "ok", "hi", "hmm"), respond naturally with a short casual follow-up question — never escalate these to human.',
    '',
    '## Knowledge base',
    kb || '(knowledge base is empty)',
  ].join('\n');
}

/**
 * 构造用户消息：最近对话历史 + 最新消息。
 * @param {{history?: Array, message?: string}} [ctx]
 * @returns {string}
 */
function buildUserMessage(ctx = {}) {
  const history = Array.isArray(ctx.history) ? ctx.history.slice(-8) : [];
  const lines = ['## Conversation so far'];
  for (const h of history) {
    const who = h.from === 'me' ? 'You' : 'User';
    lines.push(`${who}: ${String(h.body || '').slice(0, 400)}`);
  }
  lines.push(`User (newest): ${String(ctx.message || '').slice(0, 800)}`);
  lines.push('', 'Reply text only (no prefix unless escalating per rules).');
  return lines.join('\n');
}

/**
 * 解析 LLM 回复 → 客服决策。
 * @param {string} text 模型输出
 * @returns {{decision: string, category?: string, reason?: string, text?: string|null}}
 */
function parseProviderResponse(text) {
  const t = String(text || '').trim();
  if (!t) return { decision: 'skip', category: 'empty' };
  // 前缀是字面量，必须转义正则特殊字符（[ ] 等），否则会被当作字符类
  const escaped = NEEDS_HUMAN_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = t.match(new RegExp(`^${escaped}\\s*(.*)`, 'i'));
  if (m) {
    return { decision: 'needs_human', category: 'llm_escalate', reason: String(m[1] || 'llm_escalated').slice(0, 200), text: null };
  }
  return { decision: 'reply', category: 'llm', text: t.slice(0, 500) };
}

/**
 * OpenAI 兼容客服生成引擎（888api.vip / OpenAI / 任意兼容端点）。
 * 读取凭据优先级：config.apiKey > 环境变量 LLM_API_KEY > OPENAI_API_KEY。
 */
class OpenAIProvider {
  /**
   * @param {{baseURL?: string, apiKey?: string, model?: string, maxTokens?: number,
   *          temperature?: number, fetchImpl?: Function, timeoutMs?: number,
   *          knowledge?: string}} [config]
   */
  constructor(config = {}) {
    this.baseURL = String(config.baseURL || process.env.LLM_BASE_URL || 'https://www.888api.vip/v1').replace(/\/+$/, '');
    this.apiKey = config.apiKey || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';
    this.model = String(config.model || 'gpt-5.6-sol');
    this.maxTokens = Number(config.maxTokens || 300);
    this.temperature = Number(config.temperature === undefined ? 0.7 : config.temperature);
    this.fetchImpl = config.fetchImpl || globalThis.fetch;
    this.timeoutMs = Number(config.timeoutMs || 60000);
    this.knowledgeText = config.knowledge || '';
  }

  /** 注入知识库文本（replier 在轮询时按消息检索后调用） */
  setKnowledge(text) {
    this.knowledgeText = String(text || '');
  }

  /**
   * 通用文本生成（个性化初信等非决策用途；不解析 [NEEDS_HUMAN] 协议）。
   * @param {{system?: string, user?: string, maxTokens?: number, temperature?: number}} [opts]
   * @returns {Promise<{ok: boolean, text?: string, error?: string}>}
   */
  async completeText({ system = '', user = '', maxTokens = 200, temperature = 0.8 } = {}) {
    if (!this.apiKey) return { ok: false, error: 'LLM_API_KEY 未配置（环境变量或 config.apiKey）' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: String(system || '') },
            { role: 'user', content: String(user || '') },
          ],
          temperature: Number(temperature === undefined ? 0.8 : temperature),
          max_tokens: Number(maxTokens || 200),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return { ok: false, error: `LLM HTTP ${response.status}: ${body.slice(0, 120)}` };
      }
      const json = await response.json();
      const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
      if (!content) return { ok: false, error: 'empty_llm_response' };
      return { ok: true, text: String(content).trim().replace(/^["'“”\s]+|["'“”\s]+$/g, '') };
    } catch (error) {
      const aborted = error && error.name === 'AbortError';
      return { ok: false, error: `${aborted ? 'LLM timeout' : 'LLM error'}: ${error && error.message || error}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 生成回复决策。
   * @param {object} context 见模块头（username/message/history/userProfile）
   * @returns {Promise<{decision: string, category?: string, reason?: string, text?: string|null}>}
   */
  async generateReply(context) {
    if (!this.apiKey) {
      return { decision: DECISION.NEEDS_HUMAN, category: 'llm_no_key', reason: 'LLM_API_KEY 未配置（环境变量或 config.apiKey）', text: null };
    }
    const system = buildSystemPrompt({ username: context && context.username, knowledge: this.knowledgeText });
    const userMessage = buildUserMessage(context);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userMessage },
          ],
          temperature: this.temperature,
          max_tokens: this.maxTokens,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return { decision: DECISION.NEEDS_HUMAN, category: 'llm_http_error', reason: `LLM HTTP ${response.status}: ${body.slice(0, 120)}`, text: null };
      }
      const json = await response.json();
      const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
      return parseProviderResponse(content);
    } catch (error) {
      const aborted = error && error.name === 'AbortError';
      return {
        decision: DECISION.NEEDS_HUMAN,
        category: aborted ? 'llm_timeout' : 'llm_error',
        reason: `${aborted ? 'LLM timeout' : 'LLM error'}: ${error && error.message || error}`,
        text: null,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

// 预留注册表：接入真实 LLM 时在此登记
const PROVIDERS = {
  mock: (config) => new MockProvider(config),
  openai: (config) => new OpenAIProvider(config),
  // deepseek: (config) => new DeepSeekProvider(config), // TODO: 如需要走同构 OpenAI 兼容端点
};

/**
 * 创建生成引擎。
 * @param {{type?: string, config?: object}} [opts]
 * @returns {object} provider
 */
function createProvider({ type = 'mock', config = {} } = {}) {
  const factory = PROVIDERS[String(type || 'mock').toLowerCase()];
  if (!factory) throw new Error(`未知 AI provider: ${type}（当前支持: ${Object.keys(PROVIDERS).join(', ')}）`);
  return factory(config);
}

/** 支持引擎列表 */
function listProviders() {
  return Object.keys(PROVIDERS);
}

// ==================== 模块导出 ====================

module.exports = {
  DECISION,
  MOCK_TEMPLATES,
  renderTemplate,
  MockProvider,
  NEEDS_HUMAN_PREFIX,
  buildSystemPrompt,
  buildUserMessage,
  parseProviderResponse,
  OpenAIProvider,
  PROVIDERS,
  createProvider,
  listProviders,
};