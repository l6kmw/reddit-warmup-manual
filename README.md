# RedWarm 手动控制版

Reddit 养号的手动控制界面版：浏览器打开控制台，填参数、点启动，即可对指定账号跑养号任务。

与 `reddit-warmup-skills`（自动调度版）的关系：**复用其全部引擎**（AdsPower 连接、登录/karma 巡检、风险档位门控、拟人滚动/阅读/点赞、评论/发帖的完整门控），只新增了参数化控制层。

> ⚠️ 使用须知：本工具用于多账号养号，违反 Reddit 用户协议，有封号及指纹标记风险。写操作（评论/发帖）全程过档位门控 + AI 痕迹检查，但**后果自负**。

## 目录结构

```
reddit-warmup-manual/
├── server.js          # HTTP 服务入口（启动文件）
├── lib/runner.js      # 养号执行器（子进程，复用 reddit-warmup-skills 引擎）
├── public/index.html  # HTML 控制台
├── state/posts.json   # 近日发帖频率状态（自动生成）
└── logs/              # 运行报告 JSON（自动生成）
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
| 社区模式 | 指定多个社区随机选 / 完全随机从板块池抽 |
| 每账号板块数 | 每个账号本轮浏览几个板块 |
| 每板块时长 | 逗留时长区间（分钟），支持 1-180 分钟，可直接配置 20-30 分钟长时任务；拟人滚动 + 阅读 |
| 点赞比例 | 浏览列表收集的候选帖中，按比例随机点赞（真实点击 + API 降级） |
| 阅读详情比例 | 浏览过程中按概率打开帖子详情阅读（内容长度驱动节奏） |
| 评论比例 | 每个板块按概率触发一条评论（内容来自评论库，过档位/质量/AI 检查） |
| 发帖功能 | 开关 + 标题/正文 + 发帖社区列表；门控 = 档位 ≥ T2（karma≥50 + 注册≥30 天）+ 近 N 天发帖数 < 上限 |

### 发帖门控（新增，区别于自动版）

- **karma 门控**：复用 `assess-risk` 档位，`T2/T3` 才允许发帖（对应 comment karma ≥ 50、注册 ≥ 30 天）。
- **近日发帖频率门控**：手动版新增状态文件 `state/posts.json`，记录每账号发帖时间戳；近 `lookbackDays` 天内发帖数达到 `maxCount` 即拒绝。默认近 7 天 ≤ 2 篇，可在控制台调整。
- **多社区随机选**：`post.subs` 列表里随机挑一个板块发帖。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 控制台页面 |
| GET | `/api/status` | 当前任务状态 |
| GET | `/api/logs?since=N` | 增量日志 |
| GET | `/api/subs` | 板块池 |
| POST | `/api/run` | 启动任务（JSON 配置） |
| POST | `/api/stop` | 停止任务（SIGTERM 优雅关闭 profile） |

## 与自动版的差异

| | 自动版（reddit-warmup-skills） | 手动控制版（本目录） |
|---|---|---|
| 交互 | 命令行 / 定时调度 | HTML 控制台，手动点按钮 |
| 参数 | CLI flags | 表单实时配置 |
| 点赞/阅读/评论 | 固定区间 | 显式比例（0-100%） |
| 发帖频率门控 | 无（仅档位） | 新增近 N 天频率门控 |
| 报告 | reports/ 下 JSON+MD | logs/ 下 JSON + 控制台实时日志 |
