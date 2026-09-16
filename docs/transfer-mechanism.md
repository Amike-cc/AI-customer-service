# 转移会话机制（Transfer to Agent）知识库

> 本文档记录 AI 客服「智能路由到指定专员」功能的机制、配置规范与各平台差异。
> 最后更新：2026-07-20

## 1. 功能概述

当 AI 判定当前会话需要人工客服处理时（如售后问题、物流纠纷、情绪激动的买家等），
调用 `TransferHumanTool` 触发 `onTransferHuman` 回调，进入 `executeTransfer` 流程。

### 触发条件
- **AI Function Calling**：Orchestrator 中的 Agent 调用 `transfer_human` 工具
- **Escalation Manager**：情绪检测到买家高度不满、多次重复问题、复杂多问题场景
- **规则匹配**：`rule:human_service` 等规则命中（仅返回话术，不触发 transfer 工具）
- **人工手动**：UI 中点击「人工接管」按钮

### AgentRole 角色枚举
```typescript
type AgentRole = 'after_sales' | 'logistics' | 'pre_sales' | 'general';
```
- `after_sales`：售后专员（退换货、质量问题、错发漏发）
- `logistics`：物流专员（快递查询、催件、物流丢失）
- `pre_sales`：售前专员（产品细节、规格咨询）
- `general`：通用客服（其他问题）

## 2. 平台分发逻辑（2026-07-20 优化后）

### 核心原则：仅飞鸽支持页面级 transferToAgent

`WebviewClient.transferToAgent` 的 8 步流程使用飞鸽专用选择器：
- `[class*="i-icon-transfer"]`（飞鸽 transfer 图标）
- `"转接到客服"` 文本（飞鸽抽屉标题）
- `auxo-btn`、`primary` 按钮（飞鸽 UI 框架）

在其他平台调用此方法会因找不到 `i-icon-transfer` 图标而返回 `no-transfer-icon` 失败。
因此 `executeTransfer` 在方法开头添加平台分发：

```typescript
// src/shop/ShopSupervisor.ts executeTransfer
if (platform !== 'feige') {
  // 直接降级为通用人工接管，不调用 transferToAgent
  await this.manualTakeover();
  this.emit('transfer:failed', { reason: 'platform-not-supported', platform });
  return;
}
```

### 各平台支持情况

| 平台 | transferToAgent | 实际行为 |
|------|-----------------|----------|
| feige（飞鸽） | ✅ 支持 | 查 agentMappings → 调用 transferToAgent 8 步流程 |
| pinduoduo（拼多多） | ❌ 不支持 | 直接降级为 manualTakeover（切换状态机到 ManualMode） |
| kuaishou（快手） | ❌ 不支持 | 直接降级为 manualTakeover |
| weixin（微信小店） | ❌ 不支持 | 直接降级为 manualTakeover |

### 降级行为说明

`manualTakeover()` 切换状态机到 `ManualMode`，暂停 AI 自动回复，等待人工客服接管。
- 不会操作任何平台页面
- AI 仍然会向买家发送"已为您转接人工客服"的话术（由 Agent 的 prompt 决定）
- 状态机切换后，新消息不再触发 AI 回复，直到人工 `manualRelease` 恢复

## 3. 飞鸽 transferToAgent 8 步流程

### 源码位置
`src/cdp/WebviewClient.ts` L3234-3508

### 步骤详解

| 步骤 | 操作 | 失败原因 | 超时 |
|------|------|----------|------|
| 1 | 检查 transfer 图标存在（`[class*="i-icon-transfer"]`） | `no-transfer-icon`（留言会话）/ `icon-not-visible` | - |
| 2 | 点击 transfer 图标（onclick 祖先 / parentElement / 坐标点击） | - | - |
| 3 | 等待抽屉加载（查找"转接到客服"文本） | `drawer-load-timeout` | 8s（每 500ms 轮询） |
| 4 | 在搜索框输入客服账号名（React 兼容赋值） | `search-input-failed` / `no-search-input` | - |
| 5 | 等待搜索结果并点击匹配项 | `agent-not-found`（账号名不存在） | 1.5s |
| 6 | 填写转接备注（可选，失败不阻断） | `no-remark-input`（不阻断） | 800ms |
| 7 | 点击确认按钮（primary / 文本匹配"确认转接"/"确定"） | `confirm-failed` / `no-confirm-button` | 600ms |
| 8 | 验证抽屉关闭（最多 5s） | `verify-failed` / `drawer-still-open` | 5s |

### 失败原因汇总
- `webContents-unavailable`：webContents 已销毁
- `not-connected`：CDP 未连接
- `invalid-agent-name`：agentName 为空
- `no-transfer-icon`：留言会话不支持转接
- `icon-not-visible`：图标尺寸为 0
- `drawer-load-timeout`：抽屉加载超时
- `search-input-failed`：搜索框输入失败
- `agent-not-found`：目标客服账号在飞鸽系统中不存在
- `confirm-failed`：确认按钮点击失败
- `verify-failed`：抽屉未关闭，转接未成功
- `exception`：未预期异常

## 4. agentMappings 配置规范

### 数据库表
`shop_business_config.agent_mappings` (TEXT, JSON 字符串)

### 数据结构
```json
{
  "after_sales": "飞鸽客服账号名1",
  "logistics": "飞鸽客服账号名2",
  "pre_sales": "飞鸽客服账号名3",
  "general": "飞鸽客服账号名4"
}
```

### 源码位置
- 表结构：`src/db/repos/ShopBusinessConfigRepo.ts` L33
- 校验逻辑：`src/db/repos/ShopBusinessConfigRepo.ts` L79-90
  - 最多 4 个角色
  - key 必须是 `after_sales` / `logistics` / `pre_sales` / `general`
  - value 必须是非空字符串
- 读取逻辑：`src/shop/ShopSupervisor.ts` `executeTransfer` L1380-1391

### 配置方式
1. **UI 配置**：在「店铺业务配置」对话框中填写（推荐）
2. **直接改数据库**：`UPDATE shop_business_config SET agent_mappings = '{"after_sales":"客服晓晓"}' WHERE shop_id = 'xxx'`
3. **IPC 调用**：通过 `config:updateShopBusiness` IPC handler

### 重要约束
- ⚠️ **agentName 必须是飞鸽系统中真实存在的客服账号名**
  - 不是昵称、不是工号、不是用户名
  - 可在飞鸽客服工作台 → 客服管理 中查看
  - 错误的账号名会在步骤 5 返回 `agent-not-found`
- ⚠️ **agentMappings 仅对飞鸽平台生效**
  - 其他平台即使配置也不会被读取（已由平台分发逻辑保证）
- ⚠️ **未配置角色会返回 `no-mapping` 失败**
  - AI 调用 transferToAgent(after_sales) 但 agentMappings 中没有 after_sales 键
  - 降级为 manualTakeover，不操作页面

### 当前各店铺配置状态（2026-07-20）

| shopId | 平台 | 店铺名 | agentMappings |
|--------|------|--------|--------------|
| 1783701851888 | feige | 唯衣 | `{}` 空 |
| 1783794688704 | pinduoduo | 柚子货架 | `{}` 空 |
| 1783794731784 | kuaishou | QQ | 无记录（默认 `{}`） |
| 1783795050032 | weixin | 柚子货架 | 无记录（默认 `{}`） |

> 飞鸽店铺如需启用页面级转接，请在「店铺业务配置」中配置真实的飞鸽客服账号名。

## 5. 事件流与监控

### 事件流
```
AI Agent → TransferHumanTool → onTransferHuman
  ↓
executeTransfer (平台分发)
  ├─ 非飞鸽 → manualTakeover → emit('transfer:failed', reason='platform-not-supported')
  ├─ 飞鸽 + 无 agentMappings → manualTakeover → emit('transfer:failed', reason='no-mapping')
  ├─ 飞鸽 + 无 webviewClient → manualTakeover → emit('transfer:failed', reason='no-webview')
  ├─ 飞鸽 + transferToAgent 成功 → manualTakeover → emit('transfer:success', agentName)
  └─ 飞鸽 + transferToAgent 失败 → manualTakeover → emit('transfer:failed', reason=具体原因)
```

### IPC 广播
`ipc-handlers.ts` 订阅 `transfer:success` 和 `transfer:failed` 事件，广播到渲染层：
- `transfer:success` → `webContents.send('transfer:success', data)`
- `transfer:failed` → `webContents.send('transfer:failed', data)`

### Metrics 指标
- `transfer_human_total` (counter): 转人工总次数
  - tags: `source=ai_tool`, `agent_role=after_sales|logistics|pre_sales|general`
- `escalation_queued_total` (counter): 升级队列新增次数
- `escalation_requested_total` (counter): 升级请求次数

### escalation_queue 表
记录所有待人工处理的会话，字段：
- `shop_id`, `session_id`, `reason`（如 `emotional_frustration`、`multi_question;repeated_escalation`）
- `priority`（`urgent` / `high` / `normal` / `low`）
- `status`（`pending` / `assigned` / `resolved`）
- `required_skills`（JSON 数组，如 `["complaint"]`、`["general"]`）

## 6. 常见问题排查

### Q1: 日志显示 `reason: no-mapping`
**原因**：`agentMappings` 中没有配置 AI 请求的角色（如 AI 调 `after_sales` 但配置中没有）
**解决**：在「店铺业务配置」中补全 4 个角色的飞鸽客服账号名

### Q2: 日志显示 `reason: agent-not-found`
**原因**：配置的 agentName 在飞鸽系统中不存在
**解决**：核对飞鸽客服工作台中的真实客服账号名

### Q3: 日志显示 `reason: platform-not-supported`
**原因**：非飞鸽平台触发了 transfer 工具（2026-07-20 优化后的预期行为）
**解决**：这是正常降级，无需处理。AI 仍会发送"已为您转接人工客服"话术

### Q4: 日志显示 `reason: no-transfer-icon`
**原因**：当前会话是留言会话（离线消息），不支持转接
**解决**：这是飞鸽系统的限制，留言会话只能由人工在飞鸽后台处理

### Q5: 日志显示 `reason: drawer-load-timeout`
**原因**：点击 transfer 图标后，"转接到客服"抽屉未在 8 秒内加载出来
**可能原因**：网络慢、飞鸽页面 DOM 结构变更、抽屉被弹窗遮挡
**解决**：检查飞鸽页面是否正常加载、是否有新的弹窗拦截

### Q6: AI 频繁触发 transfer 工具但都失败
**原因**：可能是 agentMappings 未配置或 agentName 错误，但 AI prompt 仍引导转接
**解决**：
1. 先确认配置（参考第 4 节）
2. 如确实无人工客服资源，可调整 Agent prompt，减少 transfer 触发频率
3. 或在状态机中切换为持续 ManualMode，由人工接管所有会话

## 7. 相关源码索引

| 模块 | 文件 | 关键方法 |
|------|------|---------|
| 业务编排 | `src/shop/ShopSupervisor.ts` | `executeTransfer`, `onTransferHuman`, `buildToolContext` |
| 页面操作 | `src/cdp/WebviewClient.ts` | `transferToAgent` (L3234-3508) |
| 转接工具 | `src/tools/TransferHumanTool.ts` | `execute` |
| Agent 角色 | `src/tools/types.ts` | `AgentRole`, `AGENT_ROLE_NAMES` |
| 业务配置 | `src/db/repos/ShopBusinessConfigRepo.ts` | `agentMappings` 字段 |
| IPC 广播 | `electron/ipc-handlers.ts` | `transfer:success` / `transfer:failed` 订阅 |
| 升级管理 | `src/intent/EscalationManager.ts` | `escalation_queue` 写入 |
| 状态机 | `src/state/ShopStateMachine.ts` | `ManualMode` 状态 |
| E2E 测试 | `tests/e2e/escalation.e2e.test.ts` | 升级流程测试 |

## 8. 历史问题与修复记录

### 2026-07-20: 多平台误调 transferToAgent
**问题**：拼多多/快手/微信小店平台的 AI 触发 transfer 工具时，`executeTransfer` 直接调用 `transferToAgent`，
但因其他平台没有 `i-icon-transfer` 图标，返回 `no-transfer-icon` 失败。
**修复**：在 `executeTransfer` 开头添加平台分发，非飞鸽平台直接降级为 `manualTakeover`。

### 2026-07-20: 飞鸽 test_agent_cs1 测试账号残留
**问题**：飞鸽店铺的 `agent_mappings = {"after_sales": "test_agent_cs1"}` 是测试占位名，
即使触发也会在第 5 步 `agent-not-found` 失败。
**修复**：清空为 `{}`，避免无效的 transferToAgent 调用。后续需配置真实账号名。

### 2026-07-20: 快手重复回复 17 次（前一会话修复）
**问题**：快手 `sellerClassPatterns` 无法匹配 `__isMine` 类名，导致 AI 把自己回复识别为买家消息循环回复。
**修复**：在 `src/platform/registry.ts` 添加 `isMine`/`notMe` 模式。
