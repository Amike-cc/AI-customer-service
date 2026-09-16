# 故障注入测试（Chaos Tests）

本目录承载系统鲁棒性验证的故障注入测试，对应 `docs/开发文档-综合版.md` 第 12.4 节。

## 设计原则

1. **可重复**：所有外部依赖（DeepSeek API / Ollama / 视觉服务 / 飞鸽 DOM）必须 mock，确保无网络也能跑通。
2. **可观测**：每个场景必须断言"系统行为"而非"实现细节"，例如：
   - 状态机进入预期状态
   - 告警/恢复事件被触发
   - 熔断器在连续失败后开启
   - 缓存条目在 TTL 后过期
3. **可组合**：场景之间相互独立，不依赖执行顺序。

## 已覆盖场景

| 编号 | 场景 | 故障注入点 | 期望行为 | 文件 |
|---|---|---|---|---|
| C-01 | CDP 心跳连续失败 | 心跳回调连续返回 false | 状态机进入 Error / 触发 restart_feige 恢复动作 | [cdp-faults.chaos.test.ts](cdp-faults.chaos.test.ts) |
| C-02 | WebContents 崩溃 | webContents.isCrashed() 返回 true | 状态机迁移到 Recovering 并尝试恢复 | [cdp-faults.chaos.test.ts](cdp-faults.chaos.test.ts) |
| C-03 | DeepSeek API 连续失败 | axios 抛 timeout / 5xx | 熔断器开启，回复走 fallback_response | [api-faults.chaos.test.ts](api-faults.chaos.test.ts) |
| C-04 | 限流频繁触发 | 单店每分钟 10+ 次 | 限流器拒绝，触发 rate_limit_frequent 告警 | [api-faults.chaos.test.ts](api-faults.chaos.test.ts) |
| C-05 | 视觉服务 stdout 超时 | 子进程不响应 | detect 超时 reject，状态机进入 Degrading | [vision-faults.chaos.test.ts](vision-faults.chaos.test.ts) |
| C-06 | 视觉服务进程异常退出 | exit 事件触发 | 重启次数达上限后触发 vision_service_exit 告警 | [vision-faults.chaos.test.ts](vision-faults.chaos.test.ts) |
| C-07 | LruCache 容量超限 | 单店 1000 条 | LRU 淘汰旧条目，globalCount 不超过 max_entries_global | [cache-stress.chaos.test.ts](cache-stress.chaos.test.ts) |
| C-08 | ContextManager 上下文累积 | 5 轮对话 | 自动截断到 context_rounds，invalidateHotCache 生效 | [cache-stress.chaos.test.ts](cache-stress.chaos.test.ts) |
| C-09 | 三级级联逐级降级 | Tier1/Tier2 返回低置信度 | 最终由 Tier3 兜底，cascadeChain 记录降级路径 | [cascade-failover.chaos.test.ts](cascade-failover.chaos.test.ts) |
| C-10 | 告警去重 + critical 抑制 | 同店铺先 critical 后 warn | warn 被抑制；critical 恢复后 warn 可再触发 | [alert-suppression.chaos.test.ts](alert-suppression.chaos.test.ts) |
| C-11 | OCR/模型回复低置信度 | 截断回复、极短回复、多不确定词 | 置信度低于阈值，shouldUpgrade 返回 true | [confidence-cascade.chaos.test.ts](confidence-cascade.chaos.test.ts) |
| C-12 | LruCache + ContextManager 资源清理 | 5000 次写入 + 100 轮对话 | 全局条目数受控，clearAllTimers 后仍可查询 | [resource-exhaustion.chaos.test.ts](resource-exhaustion.chaos.test.ts) |
| C-13 | 敏感词全量检测 | block/warn/replace 三种动作 | block 阻止通过，replace 替换为星号，warn 不阻止 | [safety-context.chaos.test.ts](safety-context.chaos.test.ts) |
| C-14 | 网络抖动重试 | 前两次超时，第三次成功 | 重试后返回正常回复，不走 fallback | [network-resilience.chaos.test.ts](network-resilience.chaos.test.ts) |
| C-15 | 熔断器半开恢复 | 连续 5 次失败 → 时间流逝 → 探测成功 | 熔断器 open → half-open → closed | [network-resilience.chaos.test.ts](network-resilience.chaos.test.ts) |
| C-16 | 状态机循环恢复 | Recovering 验证失败 → VisualMode → 再恢复 | 验证失败后回到 VisualMode，最终恢复 Healthy | [state-recovery.chaos.test.ts](state-recovery.chaos.test.ts) |
| C-17 | SilentWait 累计到 Error | 3 次 SilentWait 达上限 | silentWaitCount >= max → Error 状态 | [state-recovery.chaos.test.ts](state-recovery.chaos.test.ts) |
| C-18 | 上下文 DB 持久恢复 | 写入消息后新建 ContextManager | 新实例可从 DB 读取历史消息，多会话独立 | [safety-context.chaos.test.ts](safety-context.chaos.test.ts) |
| C-19 | 预算超限拒绝 | 店铺/全局日预算超限 | ResourceScheduler 返回 budget_exceeded 拒绝 | [resource-exhaustion.chaos.test.ts](resource-exhaustion.chaos.test.ts) |
| C-20 | 令牌桶耗尽降级 | Tier3 预算不足 | 调度器降级到更便宜的 Tier 或拒绝 | [resource-exhaustion.chaos.test.ts](resource-exhaustion.chaos.test.ts) |

## 运行方式

```bash
npm run test:chaos
```

## 扩展指南

补充新场景时，请遵循：
1. 文件命名：`{故障域}.chaos.test.ts`，如 `network-faults.chaos.test.ts`。
2. 在本 README 的"已覆盖场景"表中登记新场景。
3. 每个用例必须包含"注入故障 → 等待稳态 → 断言行为"三段式。
4. 禁止使用真实网络 / 真实文件 IO；所有外部依赖通过 `jest.mock` 或依赖注入替换。
