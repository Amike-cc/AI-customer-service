# 端到端测试（E2E Tests）

本目录承载端到端业务流程验证测试，对应 `docs/开发文档-综合版.md` 第 12.5 节。

## 设计原则

1. **业务流程完整**：每个场景覆盖"买家消息进入 → 规则/AI 处理 → 回复发送"完整链路。
2. **Mock 边界**：飞鸽 DOM、DeepSeek API、视觉服务全部 Mock；业务逻辑（ShopSupervisor/RuleEngine/LruCache/ContextManager/RateLimiter）使用真实实现。
3. **场景化**：每个测试对应一个真实客服场景（商品咨询、物流、售后等）。

## 已覆盖场景

| 编号 | 场景 | 输入 | 期望输出 | 文件 |
|---|---|---|---|---|
| E-01 | 商品咨询 | "这款衣服有什么颜色" | 规则引擎匹配商品 FAQ，返回颜色说明 | [product-consult.e2e.test.ts](product-consult.e2e.test.ts) |
| E-02 | 物流查询 | "我的快递到哪了" | 规则引擎匹配物流模板，返回物流查询引导 | [logistics.e2e.test.ts](logistics.e2e.test.ts) |
| E-03 | 售后退货 | "我要退货" | 规则引擎匹配退货流程，返回退货指引 | [after-sales.e2e.test.ts](after-sales.e2e.test.ts) |
| E-04 | 多轮对话上下文 | "尺码是多少" → "推荐一个" | ContextManager 累积上下文，第二轮理解"推荐"指代尺码 | [multi-turn.e2e.test.ts](multi-turn.e2e.test.ts) |
| E-05 | 敏感词拦截 | "加我微信购买" | SensitiveWordChecker 命中"微信" block 类型，返回 fallback_response | [sensitive-block.e2e.test.ts](sensitive-block.e2e.test.ts) |
| E-06 | 缓存命中 | 同一问题第二次询问 | LruCache 精确命中，不再调用 DeepSeek | [cache-hit.e2e.test.ts](cache-hit.e2e.test.ts) |
| E-07 | 限流降级 | 单店 1 分钟内 11 次请求 | 第 11 次被 RateLimiter 拒绝，不进入 AI 流程 | [rate-limit.e2e.test.ts](rate-limit.e2e.test.ts) |
| E-08 | 规则未命中走 AI | 无规则匹配的咨询问题 | 调用 Mock DeepSeek，返回 AI 回复 | [ai-fallback.e2e.test.ts](ai-fallback.e2e.test.ts) |
| E-09 | 投诉情绪识别 | "什么破质量，要投诉" | EmotionDetector 识别为 angry，规则引擎匹配 complaint_apology | [complaint.e2e.test.ts](complaint.e2e.test.ts) |
| E-10 | 转人工场景 | "转人工" / "找真人客服" / "不想和机器人说话" | 规则引擎匹配 human_service，返回转接提示 | [escalation.e2e.test.ts](escalation.e2e.test.ts) |
| E-11 | 多店铺规则隔离 | 两店独立 RuleEngine + RateLimiter | 规则匹配互不影响，限流配额相互隔离 | [multi-shop.e2e.test.ts](multi-shop.e2e.test.ts) |
| E-12 | 凌晨限流降频 | night_hours [22,6] + night_factor 0.5 | 22-6 时段每分钟上限减半，超额请求被拒 | [night-ratelimit.e2e.test.ts](night-ratelimit.e2e.test.ts) |
| E-13 | 情绪逐轮升级 | neutral → slightly_upset → anxious → angry | EmotionDetector 跨 4 轮对话识别情绪升级路径 | [emotion-escalation.e2e.test.ts](emotion-escalation.e2e.test.ts) |

## 运行方式

```bash
npm run test:e2e
```

## 扩展指南

补充新场景时，请遵循：
1. 文件命名：`{业务场景}.e2e.test.ts`，如 `complaint.e2e.test.ts`。
2. 在本 README 的"已覆盖场景"表中登记新场景。
3. 每个用例必须包含"构造输入消息 → 触发 handleIncomingMessage → 断言回复内容/状态"三段式。
4. 禁止使用真实网络 / 真实文件 IO；所有外部依赖通过 `jest.mock` 或依赖注入替换。
