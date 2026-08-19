'use strict';
/**
 * md-report.js — 报告双写: JSON (机器可解析) + 同名 .md 摘要 (人读)
 *
 * 各脚本写 JSON 报告后, 用 writeMdReport() 生成同目录同名的 .md 文件:
 *   daily-2026-08-10-....json  →  daily-2026-08-10-....md
 *   warmup-...json             →  warmup-....md
 *   comment-...json            →  comment-....md
 *
 * JSON 保留给历史回放对比/批量统计, MD 给人快速浏览。
 */
const fs = require('fs');

/** 把 JSON 报告路径转成同名 .md 并写入, 返回 md 路径; 失败返回 null (不阻塞主流程) */
function writeMdReport(jsonPath, mdContent) {
  try {
    const mdPath = jsonPath.replace(/\.json$/, '.md');
    fs.writeFileSync(mdPath, mdContent);
    return mdPath;
  } catch {
    return null;
  }
}

/** 点赞明细 → md 列表行 (帖子 id 带链接) */
function upvoteLines(upvotedPosts) {
  if (!upvotedPosts || !upvotedPosts.length) return ['- （无点赞）'];
  return upvotedPosts.map((p) => {
    const title = p.title ? `「${p.title.slice(0, 60)}」` : '';
    const link = p.id ? `[${p.id}](https://www.reddit.com/comments/${p.id}/)` : '-';
    return `- r/${p.sub} ${link} ${title}`.trimEnd();
  });
}

module.exports = { writeMdReport, upvoteLines };
