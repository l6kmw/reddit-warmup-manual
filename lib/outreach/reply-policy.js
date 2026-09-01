'use strict';
/**
 * reply-policy.js — 客服回复决策策略（纯函数，可单测）
 *
 * 对单条入站消息做分类，输出：
 *   - category：greeting / smalltalk / interest / complaint / toxic /
 *               question / thanks / other / unclear
 *   - needsHuman：是否必须转人工（不自动回）
 *   - replyable：是否适合自动回复（needsHuman=false 且分类有明确话术）
 *
 * 策略（用户已确认：寒暄 + 业务混合）：
 *   - 寒暄/闲聊/致谢 → 自动回复
 *   - 购买意向（价格/购买/链接/物流等）→ 转人工（v1 Mock 无产品知识；接真实
 *     LLM + 知识库后再由 AI 应答）
 *   - 投诉/退款/负面 → 转人工
 *   - 辱骂/威胁 → 转人工
 *   - 一般疑问 → 转人工（v1 保守，避免 AI 答错）
 *   - 过短/无特征（可读）→ 通用接话（自动回，保持不冷场；用户要求短消息也要答）
 *   - 乱码/空 → 转人工（无法组织合理回复）
 *   - 无明显特征 → 通用接话模板（自动回，保持礼貌不冷场）
 */

'use strict';

const CATEGORY = {
  GREETING: 'greeting',
  SMALLTALK: 'smalltalk',
  THANKS: 'thanks',
  INTEREST: 'interest',
  QUESTION: 'question',
  COMPLAINT: 'complaint',
  TOXIC: 'toxic',
  OTHER: 'other',
  UNCLEAR: 'unclear',
};

const INTEREST_PATTERN = /(price|cost|how much|\bbuy\b|purchase|order|where.*\b(buy|find|get)\b|link|\bshipping\b|ship to|discount|coupon|product|availability|in stock|delivery|tracking)/i;
const COMPLAINT_PATTERN = /(complaint|complain|refund|return|broken|defective|damaged|\bscam\b|fraud|\bworse\b|terrible|worst|\bunhappy|not working|doesn'?t work|never arrived)/i;
const TOXIC_PATTERN = /(fuck|shit|stupid|idiot|dumb|scumbag|asshole|gtfo|loser|hate you|screw you)/i;
const QUESTION_PATTERN = /(\?|what|which|how|why|when|where|who|can you|could you|would you|do you|are you|is it|will you)/i;
const GREETING_PATTERN = /^(hi|hello|hey|yo|howdy|hiya|good (morning|afternoon|evening)|greetings)\b/i;
const THANKS_PATTERN = /(thanks|thank you|thx|ty|appreciate|grateful)/i;
const SMALLTALK_PATTERN = /(how are you|how's it going|how r u|how do you do|what's up|whats up|fine|good|ok|okay|great|nice|awesome|sure|same|haha|lol|lmao|nice to|glad)/i;

/** 消息是否“可读”：字母/数字占比过低视为乱码 */
function readableRatio(message) {
  if (!message) return 0;
  const chars = message.replace(/\s/g, '');
  if (!chars.length) return 0;
  const alphaNum = chars.replace(/[^a-zA-Z0-9]/g, '');
  return alphaNum.length / chars.length;
}

/**
 * 分类单条消息。
 * @param {string} message 对方最新消息（原文）
 * @returns {{category: string, needsHuman: boolean, replyable: boolean, reason?: string}}
 */
function classify(message) {
  const text = String(message || '').trim();
  if (!text) return { category: CATEGORY.UNCLEAR, needsHuman: true, replyable: false, reason: 'empty_message' };

  if (TOXIC_PATTERN.test(text)) {
    return { category: CATEGORY.TOXIC, needsHuman: true, replyable: false, reason: 'toxic_language' };
  }
  if (COMPLAINT_PATTERN.test(text)) {
    return { category: CATEGORY.COMPLAINT, needsHuman: true, replyable: false, reason: 'complaint_or_refund' };
  }
  if (INTEREST_PATTERN.test(text)) {
    return { category: CATEGORY.INTEREST, needsHuman: true, replyable: false, reason: 'purchase_intent' };
  }
  if (QUESTION_PATTERN.test(text)) {
    // 简短问候带问号的先按问候处理（how are you? 等）
    if (GREETING_PATTERN.test(text) || SMALLTALK_PATTERN.test(text)) {
      return { category: CATEGORY.SMALLTALK, needsHuman: false, replyable: true };
    }
    return { category: CATEGORY.QUESTION, needsHuman: true, replyable: false, reason: 'general_question' };
  }
  if (GREETING_PATTERN.test(text)) {
    return { category: CATEGORY.GREETING, needsHuman: false, replyable: true };
  }
  if (THANKS_PATTERN.test(text)) {
    return { category: CATEGORY.THANKS, needsHuman: false, replyable: true };
  }
  if (SMALLTALK_PATTERN.test(text)) {
    return { category: CATEGORY.SMALLTALK, needsHuman: false, replyable: true };
  }
  // 过短（<=2 词）且可读 → 通用接话（用户要求：短/无特征消息也要回答）；
  // 乱码（可读性过低）仍转人工，无法组织合理回复
  if (text.split(/\s+/).filter(Boolean).length <= 2) {
    if (readableRatio(text) < 0.5) {
      return { category: CATEGORY.UNCLEAR, needsHuman: true, replyable: false, reason: 'unreadable' };
    }
    return { category: CATEGORY.UNCLEAR, needsHuman: false, replyable: true, reason: 'too_short' };
  }
  if (readableRatio(text) < 0.5) {
    return { category: CATEGORY.UNCLEAR, needsHuman: true, replyable: false, reason: 'unreadable' };
  }
  return { category: CATEGORY.OTHER, needsHuman: false, replyable: true };
}

/**
 * 是否为可自动回复分类（供调用方快速判断）。
 * @param {string} category
 * @returns {boolean}
 */
function isAutoReplyCategory(category) {
  return [CATEGORY.GREETING, CATEGORY.SMALLTALK, CATEGORY.THANKS, CATEGORY.OTHER].includes(category);
}

// ==================== 模块导出 ====================

module.exports = {
  CATEGORY,
  INTEREST_PATTERN,
  COMPLAINT_PATTERN,
  TOXIC_PATTERN,
  QUESTION_PATTERN,
  GREETING_PATTERN,
  THANKS_PATTERN,
  SMALLTALK_PATTERN,
  classify,
  isAutoReplyCategory,
  readableRatio,
};