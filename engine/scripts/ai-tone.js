/**
 * ai-tone.js — Reddit 英文评论/发帖的 AI 痕迹检查器
 *
 * 目标: 在评论/发帖前拦截"太像 AI"的内容, 降低被 Reddit 风控
 * (Poster Eligibility / CQS / Reputation Filter) 标记的概率。
 *
 * 方法论来源: humanizer skill 的 AI 写作特征清单 (维基百科 AI Cleanup),
 * 结合 Reddit 真人评论的语料特征。模式是跨语言的, 但本检查器针对英文。
 *
 * 设计: 非一票否决。多个 AI 特征叠加时判定"太像 AI", 单个特征偶尔出现
 * (真人也会用) 不拒绝。同时给"活人感"信号加分做参考, 不否决。
 *
 * 用法:
 *   const { aiToneCheck } = require('./ai-tone');
 *   const result = aiToneCheck("My comment text...");
 *   if (!result.passed) { reject with result.issues }
 */

// --- AI 高频词汇 (营销/模型腔, 真人 Reddit 评论很少用) ---
// 注意: 定义后统一去重（历史 bug: furthermore 重复导致一条评论重复计数直接触发强信号）
const AI_WORDS_RAW = [
  'delve', 'delve into', 'landscape', 'tapestry', 'testament', 'furthermore',
  'moreover', 'additionally', 'consequently', 'in conclusion', 'in summary',
  'to sum up', 'dive in', 'navigate the', 'robust', 'seamless', 'comprehensive',
  'innovative', 'cutting-edge', 'state-of-the-art', 'leverage', 'streamline',
  'utilize', "in today's", 'ever-evolving', 'it is important to note',
  "it's worth noting", 'pivotal', 'crucial', 'holistic', 'elevate', 'unlock',
  'supercharge', 'game-changer', 'paradigm', 'synergy', 'a treasure trove',
  'wealth of', 'myriad', 'plethora', 'facilitate', 'commence', 'endeavor',
  'foster', 'underscore', 'highlight the importance', 'embark on',
  'in the realm of', 'a wide range of', 'when it comes to', 'plays a vital role',
  'plays a crucial role', 'it should be noted', 'needless to say', 'furthermore',
  'let\'s dive', 'take a deep dive', 'pro tip', 'game-changing', 'revolutionize',
  'transformative', 'unparalleled', 'best-in-class', 'turnkey', 'end-to-end',
  'low-hanging fruit', 'move the needle', 'on the same page', 'think outside the box',
];

// 去重（规范化: 小写 + trim；保持首现顺序）
function dedupe(words) {
  const seen = new Set();
  const out = [];
  for (const w of words) {
    const norm = String(w).trim().toLowerCase();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(w);
  }
  return out;
}

const AI_WORDS = dedupe(AI_WORDS_RAW);

// --- 学术/正式过渡词 (真人 Reddit 评论少用; 过多说明是 AI 排比) ---
const TRANSITION_WORDS = dedupe([
  'however', 'moreover', 'furthermore', 'additionally', 'consequently',
  'therefore', 'nevertheless', 'nonetheless', 'in addition', 'as a result',
  'in contrast', 'on the other hand', 'in order to', 'thus',
]);

// --- 空洞营销形容词 ---
const HOLLOW_ADJ = dedupe([
  'robust', 'seamless', 'comprehensive', 'innovative', 'cutting-edge',
  'user-friendly', 'easy-to-use', 'intuitive', 'powerful', 'flexible',
  'scalable', 'efficient', 'streamlined', 'optimized', 'best-in-class',
]);

// --- 活人感信号 (加分参考, 不否决) ---
const HUMAN_SIGNALS = [
  /\b(i|i'm|i've|i'd|i'll|my|me)\b/i,       // 第一人称
  /\b(actually|honestly|tbh|imo|imho|personally|fwiw|realistically)\b/i, // 口语立场词
  /\b(gonna|kinda|sorta|dunno|yeah|nah|okay|btw|afaik|idk|ngl)\b/i,     // 口语缩写
  /\b(we|our|us)\b/i,                        // 复数经验
  /\d/,                                      // 具体数字
  /\b(i think|i found|i tried|i used|i ran into|in my case|from my experience)\b/i, // 经验句式
];

const MAX_EM_DASH = 2;          // 真人几乎不用 em dash
const AI_WORD_THRESHOLD = 2;    // >=2 个 AI 词汇 → 强信号
const TRANSITION_THRESHOLD = 3; // >=3 个过渡词 → 强信号
const HOLLOW_THRESHOLD = 2;     // >=2 个空洞形容词 → 强信号
const SLANG_MAX = 3;            // P2-7 U 型修正: 口语标记最多 3 个, 超过即扣分

// P2-7 U 型修正: 口语标记词表（对应 HUMAN_SIGNALS 里的口语类信号）
// 真人会偶尔用 1-2 个口语词, 但 AI 模仿人味时系统性过度使用——太多本身就是机器信号
const SLANG_WORDS = ['gonna', 'kinda', 'sorta', 'dunno', 'yeah', 'nah', 'okay', 'btw', 'afaik', 'idk', 'ngl', 'tbh', 'imo', 'imho', 'fwiw'];

/**
 * 语言探测：CJK（中日韩）字符占比 > 20% 判为非目标语言（中文/日文/韩文）
 * 本检查器的英文规则（AI 词汇/em dash/过渡词/营销词）不适用于中文——
 * 中文的破折号是正常语法，真人中文评论也会用"此外/总之"等词。
 * @param {string} text
 * @returns {'zh'|'en'|'mixed'} zh=中文为主, en=英文为主, mixed=中英混合
 */
function detectLanguage(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const total = s.replace(/\s/g, '').length;
  if (!total) return 'en';
  const ratio = cjk / total;
  if (ratio > 0.20) return 'zh';
  if (ratio > 0.05) return 'mixed';
  return 'en';
}

/**
 * 检查文本的 AI 痕迹
 * @param {string} text 待检查文本
 * @param {object} [opts]
 * @param {string} [opts.forceLang] 强制指定语言（'en'|'zh'），跳过探测（调试用）
 * @returns {{passed: boolean, issues: string[], score: number, humanSignals: string[], language: string, applied: boolean}}
 */
function aiToneCheck(text, opts = {}) {
  const lower = String(text || '').toLowerCase();
  const issues = [];
  let score = 0;

  // 语言探测：中文为主时跳过英文规则（只保留通用规则）
  const language = opts.forceLang || detectLanguage(text);
  const isEnglishTarget = language !== 'zh'; // mixed 也走英文规则（英文部分仍可能暴露 AI 痕迹）

  // 1. AI 词汇（仅英文目标）
  if (isEnglishTarget) {
    const aiHits = AI_WORDS.filter((word) => lower.includes(word));
    if (aiHits.length >= AI_WORD_THRESHOLD) {
      score += 2;
      issues.push(`AI 高频词汇 ${aiHits.length} 个: ${aiHits.join(', ')}`);
    }
  }

  // 2. em dash / en dash 滥用（仅英文目标——中文破折号是正常语法）
  if (isEnglishTarget) {
    const emDashes = (text.match(/[—–]/g) || []).length;
    if (emDashes > MAX_EM_DASH) {
      score += 2;
      issues.push(`破折号 ${emDashes} 个 (真人手写几乎不用 em dash)`);
    }
  }

  // 3. "not only... but also" 排比模板（仅英文目标）
  if (isEnglishTarget && /not only[^.!?]{0,80}but also/i.test(text)) {
    score += 2;
    issues.push('"not only... but also" 模板排比 (强信号)');
  }

  // 4. 过度过渡词（仅英文目标）
  if (isEnglishTarget) {
    const transHits = TRANSITION_WORDS.filter((word) => {
      const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      return re.test(lower);
    });
    if (transHits.length >= TRANSITION_THRESHOLD) {
      score += 1;
      issues.push(`学术过渡词过多 ${transHits.length} 个: ${transHits.join(', ')}`);
    }
  }

  // 5. 空洞营销形容词（仅英文目标）
  if (isEnglishTarget) {
    const hollowHits = HOLLOW_ADJ.filter((word) => new RegExp(`\\b${word}\\b`, 'i').test(lower));
    if (hollowHits.length >= HOLLOW_THRESHOLD) {
      score += 1;
      issues.push(`空洞营销形容词 ${hollowHits.length} 个: ${hollowHits.join(', ')}`);
    }
  }

  // 6. 完美对称/金句检测: 引号包裹的"可引用"短句 + 感叹号堆叠（语言无关）
  const quotedPunchlines = (text.match(/"[^"]{5,40}"/g) || []).filter((q) => /^"[a-z].*[.!?]"$/.test(q));
  if (quotedPunchlines.length >= 2) {
    score += 1;
    issues.push(`引号金句 ${quotedPunchlines.length} 处 (AI 爱写可引用短句)`);
  }
  const exclaim = (text.match(/!/g) || []).length;
  if (exclaim >= 3) {
    score += 1;
    issues.push(`感叹号 ${exclaim} 个 (过多显营销腔)`);
  }

  // 7. P2-7 U 型修正: 口语标记过度使用本身就是机器信号
  // 真人偶尔用 1-2 个口语词是活人感; AI 模仿人味时系统性堆口语词, 超过阈值即扣分
  if (isEnglishTarget) {
    const slangHits = SLANG_WORDS.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(lower));
    if (slangHits.length > SLANG_MAX) {
      score += 2;
      issues.push(`口语标记过多 ${slangHits.length} 个 (AI 模仿人味时系统性过度使用口语词)`);
    }
  }

  // 活人感信号 (参考)
  const humanSignals = HUMAN_SIGNALS.filter((re) => re.test(text)).map((re) => re.source);

  // 判定: score >= 2 → 太像 AI; 单个弱信号 (score=1) 放行
  const passed = score < 2;
  if (!passed) {
    issues.unshift(`AI 痕迹得分 ${score}/10, 疑似机器生成`);
  }
  return {
    passed,
    issues,
    score,
    humanSignals,
    language,
    applied: isEnglishTarget,
  };
}

/**
 * 给出改写建议 (供提示词/日志使用)
 */
function rewriteHints(issues) {
  const hints = [
    '换成第一人称具体经验: "I tried X and ran into Y"',
    '加入具体数字/时间/场景, 而不是泛泛道理',
    '删掉过渡词排比, 直接说事; 允许口语化 (gonna/kinda/tbh)',
    '不要追求完美对称的句子和金句式结尾',
    '参考 r/NewToReddit: 评论要有实际补充 (经验/纠错/提问), 空话拉低 CQS',
  ];
  return hints;
}

module.exports = { aiToneCheck, rewriteHints, detectLanguage, AI_WORDS, TRANSITION_WORDS, HOLLOW_ADJ, SLANG_WORDS };
