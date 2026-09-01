# Outreach 运行时阻塞与实机验证清单

> 日期：2026-08-31
> 关联：docs/outreach-design.md / README.md；修复记录见 git（未提交）

## 1. 当前阻塞（必须解决才能实机发送）

### 1.1 唯一可用 Profile 的代理 DNS 失效（硬阻塞）

- 当前 AdsPower Global 8.7.23 只有 **1 个 profile**：
  - serial `1251`｜name `222`｜id `k1gal3e3`
- 其代理配置：`socks5 gate.asia.mobiclound.com:8010`
- 实测结果：
  - `nc -z gate.asia.mobiclound.com 8010` → `getaddrinfo: nodename nor servname provided, or not known`（**域名无法解析**）
  - Playwright 打开 `https://www.reddit.com/` → `net::ERR_PROXY_CONNECTION_FAILED`
- 结论：该 profile **无法访问 Reddit**，discover 与 sender 都跑不了。

**处理选项（用户侧）**：
1. 在 AdsPower 编辑 profile 222，确认代理域名/端口是否过时或拼写错误（如 mobiclound 服务到期）；
2. 替换为其他可用 socks5 代理；
3. 或提供一个备用的、已登录 Reddit 的 profile（历史 serial 5/34 在当前客户端已不存在，勿再引用）。

### 1.2 运行目标 serial 说明（已更正）

- 全量 Profiles（`/api/v1/user/list?page_size=100`）共 **88 个**；之前列表接口只返回默认 1 条（serial 1251），
  导致误判多数 serial 不存在。**serial 34 存在**：name `Plane-Royal-1227`，id `k1f350ey`，代理 `socks5 38.106.42.92:43761`。
- **serial 34 已实测通过**（2026-08-31）：代理连通、Reddit 可访问、compose DOM 匹配新选择器、真实发送 2 条成功。

## 2. 已修复（本次）

| # | 问题 | 修复 |
|---|---|---|
| 1 | 队列 138 条全部不可发（124 skipped `daily_limit_reached` + 14 failed） | 新增 `lib/outreach/requeue.js`，已恢复全部 138 条 → `pending`（备份：`state/outreach-queue.json.bak-20260831102523`） |
| 2 | 旧版 sender 无失败诊断，选择器问题只能靠猜 | `sender.js` 失败时自动附加页面 DOM 诊断（`| DOM:{...}`，含 composeForm/textarea 名称/发送按钮 disabled/登录墙） |
| 3 | recipient 输入框会被键盘操作误触改写 | `sender.js` 收件人已包含目标用户名时跳过 Enter/Tab 确认序列 |
| 4 | 恢复到 pending 时残留旧 skipReason/sendResult | `queue.js` markStatus PENDING 分支清理 sendResult/skipReason |
| 5 | requeue 工具无测试 | 新增 `requeue.test.js`；`npm run check && npm test` 全绿 |
| 6 | 修复未实机验证 | **2026-08-31 18:38 已实机验证**：serial 34 发 2 条全部成功（`sent:2 failed:0`），审计 `outreach.sent` ok:true，接触名单已登记 |

## 3. 实机验证步骤（已跑通）

```bash
# ① 只读诊断：确认登录态 + compose DOM 与当前选择器匹配（不发消息）
node /tmp/outreach-diagnose.js 1251 <测试用户名>

# 期望输出：
#   - composeForm: true
#   - faceplateTextarea: true（shadowInputs 含 message-content）
#   - sendButtons: 非空且无 disabled 前缀
#   - loginWall: false
# 若 selectors 与输出不一致，按 DOM 输出修正 sender.js openComposeAndSend

# ② 真实发送 1 条冒烟测试
cat > /tmp/outreach-smoke.json <<'EOF'
{
  "target": {"type": "serial", "value": "1251"},
  "sub": "lawncare",
  "keywords": ["sod"],
  "template": "Hi {username}, I saw your comment on {post_title}. Would you be open to a quick chat about it?",
  "runLimit": 1,
  "sendIntervalMin": 5,
  "sendIntervalMax": 10
}
EOF
node lib/outreach/sender.js --config /tmp/outreach-smoke.json

# 期望：
#   - summary.sent = 1，队列对应项 status=sent
#   - logs/outreach-2026-08-31.jsonl 出现 outreach.sent 且 ok:true
#   - state/outreach-contacted.json 登记该用户名
```

## 4. 验证口径

- **成功**：`outreach.sent` 审计条目 `ok:true`（以 GraphQL 响应或页面确认任一为准）。
- **失败但不确定**：`outreach.unknown`（已提交但确认超时），条目状态 `unknown`，可人工复查后再 requeue。
- **环境问题**：错误信息中的 `DOM:` 字段直接指出页面实际结构，据此修选择器。

## 5. 注意事项

- 控制台“私信触达”Tab 保持 v1 只读监控，不增加人工审核；requeue 仅通过 CLI 使用。
- 队列已恢复 pending 的 138 条会从下一次 send 起按 runLimit 逐批处理（默认 20 条/次）。
- 发送前请再次确认：代理有效、profile 已登录 Reddit、本机可访问 Reddit。