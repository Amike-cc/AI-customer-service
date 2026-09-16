# 全量代码审查 + 完善 — 任务总览

## 背景
- 上一轮已完成 48 项 BUG 修复（见 `docs/全量代码BUG审查报告-2026-07-21.md`）
- 本轮（2026-08）通过 4 路并行深度审查，再次发现并修复 **30+ 项**问题，覆盖崩溃防护、核心链路、AI 决策、数据一致性、前端竞态、监控盲区

## 本轮修复清单

### 崩溃防护（P0）
1. **index.ts**：全局 `unhandledRejection`/`uncaughtException` 兜底 + shutdown try/finally + 10s 强制退出保护
2. **MetricsCollector**：flush 失败不再 `emit('error')`（无监听器会抛异常导致进程崩溃），改为 stderr 记录
3. **ShopInstance**：stateMachine 注册 `error` 事件监听（transition 回调异常不再崩溃进程）

### 核心会话链路（P0-P1）
4. **ShopInstance**：发送失败/限流重试被 15s 会话冷却吞掉的严重 BUG（finally 中无条件设冷却后重试被拦截）——重试路径不再设冷却
5. **ShopInstance**：转人工角色硬编码 `after_sales` → 使用计算出的 `transferRole`（human_request 走 general）
6. **ShopInstance**：兜底/熔断/无法回答的回复不再写入 LRU 缓存（LLM 恢复后同一问题可重新生成）
7. **ShopInstance**：对话状态机检查移到意图评估之后，`detectScenario` 传入意图（triggerIntent 场景恢复可用）
8. **WebviewClient**：`connect()` 重置 `stopped` 标志（复用路径消息静默丢失的潜伏缺陷）
9. **WebviewClient**：`drainMessageQueue` 逐条 try/catch（单条 handler 异常不再中断导致剩余消息永久丢失）
10. **WebviewClient**：`typeChar` 支持 `\n`（Shift+Enter 换行），特殊字符不再发送非法 keyCode

### AI 决策链路（P1）
11. **gateway providers**：OpenAI/Qwen 完整透传 `tools`/`tool_choice`/`tool_calls`/`tool_call_id`/`name`；Claude 实现 Anthropic 原生 tool_use/tool_result 协议——非 DeepSeek provider 的 Function Calling 级联从 400 失效变为可用
12. **ModelGateway**：directRoute 计入预算/成本（此前意图/情绪等高频调用完全绕过预算上限）+ 计算真实置信度（替代硬编码 0.8）+ fallback 记录实际失败 provider
13. **LlmIntentRecognizer**：买家原文移出 system prompt 并加"非指令"标记（修复 prompt 注入面）+ confidence 字符串宽容解析
14. **LlmEmotionDetector**：缓存 key 加入历史摘要（避免不同上下文串缓存）+ 超时后晚到结果写入缓存（孤儿请求复用）
15. **EmotionDetector**：移除单字"快/急"误判（"快推荐一下""比较着急"不再误判焦虑）；"怎么/又/还"改为泛化词需多信号
16. **DeepSeekClient**：400/404/413 等确定性错误不再退避重试；参数优先级统一 `po ?? scenario ?? global`；响应记录真实 model
17. **Orchestrator**：priority 归一化（不再固定除以 50 造成 after_sales 系统性胜出）+ agents 为空时的兜底 Agent
18. **BaseAgent**：多轮工具调用的 latencyMs 累加（此前只取最后一轮，监控失真）
19. **PreSalesAgent**：移除单字"买"关键词（"买贵了"等大量误命中）
20. **EscalationManager**：reasons 为空时补 `high_complexity` 而非占位符

### 规则与知识库（P1）
21. **RuleEngine**：FAQ 路径统一为 `{data_dir}/data/shops/{shopId}/faq.json`（与其它模块一致，消除双目录）
22. **RuleEngine**：human_service 规则移除裸词"客服"（不再拦截"客服推荐下尺码"等普通咨询）
23. **RuleEngine**：thanks 规则排除带真实问题的感谢消息（"谢谢，什么时候发货？"不再只回"不客气"）
24. **RuleEngine**：addRule/updateRule 保存前校验正则合法性（无效正则不再静默"消失"）；priority 0 不再被当作 50
25. **VersionManager**：deleteVersion 增加 shopId 归属校验（修复跨店铺越权删除）

### 数据一致性（P1-P2）
26. **AuditRepo**：verifyChain 跳过链头记录（修复 cleanup 清理后永久假阳性）+ ORDER BY 加 id 稳定排序
27. **ShopConfigRepo**：ON CONFLICT 不再覆盖 `feige_client_path`/`login_status`（重复添加丢配置）
28. **FeedbackRepo**：audit_id 唯一约束 + 原子 upsert（重复 👍/👎 不再污染准确率统计），老库自动迁移去重
29. **ProductMatcher**：跳过空字符串 name/keyword（`includes('')` 恒真导致所有消息命中全部商品）+ 精确匹配统一小写
30. **ProductSyncService**：非飞鸽平台改用名称哈希稳定 ID（不再每次同步产生重复商品）+ 老格式 sync_* ID 全平台清理 + NaN 库存防御

### 对话框（P2）
31. **DialogStateManager**：场景查找改用实例索引（自定义注入场景恢复可用）+ 可选槽位推进与"无"跳过（preference 槽恢复工作）+ 无捕获组正则提取修复 + slots 未初始化防御 + 取消检测限长（"我已经取消重下了"不再误判取消）
32. **scenarios**：身高兜底正则改为纯数字锚定（"我今年38"不再误提取 38）

### 前端（P2）
33. **useShops**：switchView/exitView 派生链尾部吞拒绝（修复 unhandled rejection）+ refresh in-flight 去重
34. **Sidebar**：重命名弹窗初始值只设一次（15s 轮询不再覆盖用户正在输入的名字）
35. **KnowledgeBase/OverviewPanel**：店铺切换竞态守卫（旧店铺慢响应不再覆盖新店铺数据）

### 监控与日志（P2）
36. **ShopInstance/backend**：补发 `cdp_heartbeat_failure_total`/`visual_mode_active`/`vision_service_exit_total` 指标（此前三条默认告警规则永远不触发，监控盲区）
37. **LruCache**：语义比较按文本长度差排序后截断（不再因 Map 迭代序漏掉最旧的高相似条目）
38. **logger**：meta 对象（err 堆栈/消息原文）递归脱敏（此前只有 message 脱敏，手机号仍可能写入日志）
39. **ResourceScheduler**：预算为 0 时等待时间不再返回 Infinity
40. **TransferHumanTool**：reason/urgency 截断上限

## 验证结果
- `tsc --noEmit`（主 + renderer）EXIT 0
- `eslint --max-warnings 0` EXIT 0
- 单元测试 497/497 通过（2 个测试随行为变更同步更新）
- Renderer 测试 83/83、Chaos 42/42、Integration 22/22 全部通过
- `vite build` 打包成功

## 说明
- 修复未做 Electron 运行时集成测试（需真实飞鸽页面 + 各平台账号验证）
- 数据库变更（feedback 唯一索引）启动时自动迁移，无需手动操作
