# Reddit 评论者私信触达（Outreach）设计文档

> 状态：设计中（v1 范围已确认）
> 日期：2026-08-31
> 关联：README.md / docs/architecture.svg（本功能作为 RedWarm 的独立模块扩展，不改动养号引擎）

## 1. 目标

在指定 Reddit 社区内，自动发现「标题命中关键词」的帖子，收集其近期评论者，
筛选出潜在相关用户，生成私信候选队列，**全自动**通过 AdsPower 真实浏览器逐条发送私信，并完整留存审计记录。

v1 明确**不做**：AI 智能客服、自动应答、知识库（已确认搁置，仅在数据结构上预留扩展字段）；
不做人工审核环节（控制台仅监控）。

## 2. 已确认决策

| 决策项 | 选择 |
|---|---|
| 帖子筛选 | 标题关键词匹配（配置化关键词表） |
| 私信对象 | 目标帖子的**所有评论者**（帖子标题命中关键词即可；不做评论内容二次过滤，仅做硬排除） |
| 发送模式 | **全自动发送**（规则+风控参数兜底，无需人工确认；控制台仅监控） |
| 发送间隔 | 60–120s 随机 |
| 数据来源 | 通过 AdsPower 已登录 Profile 访问 Reddit（复用现有浏览器层） |
| 发送通道 | 浏览器真实发私信（与养号同指纹、同节奏） |
| 单次执行上限 | 默认 20 条/次，可按运行配置调整；不设置跨天发送上限 |
| 发送间隔 | 60–120s 随机 |

## 3. 数据流

```
① posts.discover   ② comments.collect   ③ candidates.filter
subreddit+关键词   →  每帖评论树(≤50)  →  仅硬排除（不做评论内容过滤）
New 排序 limit100     近48h/分数≥1       OP/版主/机器人/已联系
                       作者去重
                          ↓
④ queue.build     ⑤ sender.send(全自动)   ⑥ audit
模板+变量渲染   →  AdsPower 浏览器    →  JSONL+MD 报告
打分排序            限频20/天 失败暂停     contact dedup
```

## 4. 新增模块（lib/outreach/）

### 4.1 discover.js —— 帖子发现 + 评论收集
- 通过 MachineManager 连接目标 Profile（复用 `resolveProfiles/targetQuery` 模式）
- 访问 `https://www.reddit.com/r/{sub}/new.json?limit=100`（带登录 cookie；失败回退页面 DOM）
- 过滤：标题命中 `keywords`（大小写不敏感）、非置顶、非已被处理过（`postId` 去重）
- 对每个候选帖拉评论 `.json`，取近 `commentHours`(默认48) 内的评论，score ≥ `minScore`(默认1)，每帖最多 `maxCommentsPerPost`(默认50)
- 按作者名去重，聚合 `{username, postTitle, postUrl, commentSnippet, score, commentTime}`
- **范围口径**：目标帖子的所有评论者全部进入候选，不按评论内容二次筛选（评论内容仅用于草稿上下文与后续参考）
- 输出：`{ok, items[], skipped[], errors[]}`

### 4.2 queue.js —— 候选队列 + 状态机
- 状态文件：`state/outreach-queue.json`
- **范围口径**：目标帖子的所有评论者均进入候选；此处**不做评论内容相关性过滤**（硬排除见下）
- 每条记录：`{id, username, postTitle, postUrl, commentSnippet, reason, score, status, draft, createdAt, queuedAt, sentAt, sendResult}`
- 状态机：`pending → sent / failed / skipped`（全自动，无 approve 环节；`skipped` 仅用于规则性跳过，如超限、黑名单）
- 去重：写入前检查 `state/outreach-contacted.json`（永久黑名单，跨运行生效）
- 排除名单：帖主本人、版主、`AutoModerator`、用户名含 `_bot|auto|mod` 等
- 草稿模板渲染：`{username}` `{post_title}` `{comment_snippet}` `{sub}`

### 4.3 sender.js —— 发送器（全自动）
- 队列中 `pending` 项直接按规则发送；不再需要人工 approve
- 逐条经 AdsPower 打开 `https://www.reddit.com/message/compose/?to={username}` 真实填写发送
- 发送节奏：间隔随机 60–120s；**单次执行上限 `runLimit`（默认20）**，未选中的 `pending` 留待下一次执行
- 失败不自动重试同一条，标记 `failed` 并暂停等待人工介入
- 与养号任务互斥：`state/outreach.lock`，运行中禁止同时跑 warmup/comment/post

### 4.4 audit —— 审计与报告
- `logs/outreach-YYYY-MM-DD.jsonl`：结构化逐条发送记录（时间/目标/内容/结果/错误，含脱敏）
- 每次运行结束生成 Markdown 报告：候选数、发送数、失败数、命中关键词统计

## 5. 服务端与控制台扩展（server.js / public/index.html）

新增 API：
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/outreach/discover` | 启动发现：{sub, keywords, profile 目标, 时间窗...} |
| GET | `/api/outreach/queue` | 拉取候选队列（含发送状态，只读） |
| POST | `/api/outreach/send` | 启动全自动发送（发送 pending 队列） |
| POST | `/api/outreach/stop` | 停止当前发送 |
| GET | `/api/outreach/report?date=` | 审计报告 |

控制台新增「私信触达」Tab：配置区（社区/关键词/账号/参数）+ 发现按钮 +
**监控面板**（候选列表只读、发送进度、每日剩余额度）+ 报告区。
审核操作（批准/修改/跳过）v1 不做，全自动发送。

## 6. 风控参数（全部收敛到 lib/config.js）

| 参数 | 默认 | 说明 |
|---|---|---|
| `runLimit` | 20 | 单次执行最多发送条数，未选中的 pending 保留 |
| `sendIntervalMin/Max` | 60 / 120 | 发送间隔秒（随机） |
| `maxPosts` | 100 | 每次发现扫描帖子数 |
| `maxCommentsPerPost` | 50 | 每帖最多取评论数 |
| `commentHours` | 48 | 评论时间窗（小时） |
| `minScore` | 1 | 评论最低分数 |
| `subjects` | [] | 允许的社区白名单（空=任意） |
| `contactCooldownDays` | 30 | 同一用户两次联系最小间隔 |
| `lockFile` | state/outreach.lock | 养号互斥锁 |

## 7. 后续扩展预留（当前不做）

- 客服回复：`state/outreach-contacted.json` 升级为会话表（contact 增加 `threadStatus/replyHistory/needsHuman` 字段即可，不破坏现有结构）
- 自动应答：发送器之后增加收信轮询器（轮询消息/新回复），v1 不实现

## 8. 落地清单

- [ ] `lib/outreach/discover.js`（含测试）
- [ ] `lib/outreach/queue.js`（含测试）
- [ ] `lib/config.js` 新增 outreach 配置段
- [ ] `server.js` 新增 `/api/outreach/*`
- [ ] `public/index.html` 私信触达 Tab（监控面板）
- [ ] `lib/outreach/sender.js` + 互斥锁
- [ ] 审计报告 + README 更新
- [ ] `npm run check && npm test` 全绿