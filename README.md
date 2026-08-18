# RedWarm 手动控制版

Reddit 养号的手动控制界面版：浏览器打开控制台，填参数、点启动，即可对指定账号跑养号任务。

与 `reddit-warmup-skills`（自动调度版）的关系：**复用其全部引擎**（AdsPower 连接、登录/karma 巡检、风险档位门控、拟人滚动/阅读/点赞、评论/发帖的完整门控），只新增了参数化控制层。

> ⚠️ 使用须知：本工具用于多账号养号，违反 Reddit 用户协议，有封号及指纹标记风险。写操作（评论/发帖）全程过档位门控 + AI 痕迹检查，但**后果自负**。

## 目录结构

```
reddit-warmup-manual/
├── server.js          # HTTP 服务入口（启动文件）
├── lib/runner.js      # 养号执行器（子进程，复用 reddit-warmup-skills 引擎）
├── lib/logger.js      # 结构化日志（环形缓冲、JSONL 持久化、敏感字段脱敏）
├── public/index.html  # HTML 控制台
├── state/posts.json   # 近日发帖频率状态（自动生成）
└── logs/              # 运行报告 JSON/Markdown + 服务日志 JSONL（自动生成）
```

## 启动

```bash
cd /Users/xskj/Ai/reddit-warmup-manual
node server.js                 # 默认端口 8787
node server.js --port 9000     # 或 PORT=9000 指定端口
```

浏览器打开 `http://127.0.0.1:8787`。

依赖：Node ≥ 18，且 `../reddit-warmup-skills/reddit-warmup` 已装好依赖（`npm install` 过），AdsPower 客户端在运行。

## 控制台可配置项

| 配置 | 说明 |
|---|---|
| 目标账号 | serial 序号 / AdsPower profile ID / AdsPower 分组名，支持多个（逗号分隔） |
| 社区模式 | 指定多个社区随机选 / 完全随机从板块池抽；遇到 banned 时，单个指定社区直接返回结果，多个指定社区或完全随机会自动换一个未确认封禁的社区 |
| 每账号板块数 | 每个账号本轮实际浏览次数；指定社区数量不足时随机循环补足（例如只填 1 个社区、设置 4 次，会浏览该社区 4 次），完成后才切换下一账号 |
| 每板块时长 | 逗留时长区间（分钟），支持 1-180 分钟，可直接配置 20-30 分钟长时任务；拟人滚动 + 阅读 |
| 点赞比例 | 浏览列表收集的候选帖中，按比例随机点赞（真实点击 + API 降级） |
| 阅读详情比例 | 浏览过程中按概率打开帖子详情阅读（内容长度驱动节奏） |
| 评论比例 | 每个板块按概率触发一条评论（内容来自评论库，过账号安全/档位/质量/AI/实时社区规则门控） |
| 评论规则确认 | 执行前自动读取当前规则 hash；仅在预审出现未决项时人工填写确认项 |
| 发帖功能 | 开关 + 标题/正文 + 社区列表 + 每社区规则确认/flair；门控 = 档位 ≥ T2 + 频率 + 实时社区规则 |

### 发帖门控（新增，区别于自动版）

- **karma 门控**：复用 `assess-risk` 档位，`T2/T3` 才允许发帖（对应 comment karma ≥ 50、注册 ≥ 30 天）。
- **近日发帖频率门控**：手动版新增状态文件 `state/posts.json`，记录每账号发帖时间戳；近 `lookbackDays` 天内发帖数达到 `maxCount` 即拒绝。默认近 7 天 ≤ 2 篇，可在控制台调整。
- **多社区随机选**：`post.subs` 列表里随机挑一个板块发帖。
- **实时规则门控**：评论执行前自动读取目标社区当前规则并使用实时 `ack`，无需手填 hash。发帖可点“读取社区规则”预填 hash。`confirmedUnresolved` 与发帖 `flair` 不会自动猜测，仍需按 `scripts/preflight.js` 结果人工填写。评论必须提供明确帖子 URL；手控版会把这些确认透传给最新版 `comment.js` / `post.js`。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 控制台页面 |
| GET | `/api/status` | 当前任务状态 |
| GET | `/api/logs?since=N&level=warn` | 增量结构化日志；`level` 可选，返回该等级及以上日志 |
| GET | `/api/subs` | 板块池 |
| POST | `/api/rules` | 用目标列表第一个账号实时读取社区规则 Hash |
| POST | `/api/run` | 启动任务（JSON 配置） |
| POST | `/api/stop` | 停止任务（SIGTERM 优雅关闭 profile） |

## 与自动版的差异

| | 自动版（reddit-warmup-skills） | 手动控制版（本目录） |
|---|---|---|
| 交互 | 命令行 / 定时调度 | HTML 控制台，手动点按钮 |
| 参数 | CLI flags | 表单实时配置 |
| 点赞/阅读/评论 | 固定区间 | 显式比例（0-100%） |
| 社区规则门控 | 实时规则 hash + 未决项确认 | 复用同一门控，控制台按社区传入确认 |
| 发帖频率门控 | 无（仅档位） | 新增近 N 天频率门控 |
| 报告 | reports/ 下 JSON+MD | logs/ 下完整 JSON + 人类可读 Markdown + 控制台实时日志 |

## 日志设计

服务日志同时写入内存环形缓冲和 `logs/server-YYYY-MM-DD.jsonl`。控制台通过 `/api/logs` 增量拉取内存日志，磁盘 JSONL 用于长期留存与故障排查。

每条日志至少包含：

- `n`：服务进程内单调递增序号，用作增量游标。
- `t`：ISO 8601 时间。
- `level`：`debug` / `info` / `warn` / `error`。
- `source`、`event`：日志来源与稳定事件名，例如 `server/job.started`、`runner/runner.stderr`。
- `runId`：一次任务的关联 ID，串联启动、runner 输出、停止和退出事件。
- `line`：供人阅读、与旧控制台兼容的文本。
- 其他上下文字段：如 `pid`、`exitCode`、`signal`、`config`。

对象上下文中名称匹配 password、token、secret、cookie、authorization、proxy 的字段会在持久化前替换为 `[REDACTED]`。可通过环境变量 `LOG_LEVEL=debug|info|warn|error` 调整最低记录等级，默认 `info`。日志持久化失败只写入 stderr，不中断养号任务。
