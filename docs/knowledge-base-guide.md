# 知识库使用指南与场景化处理 SOP

> 本文档是 AI 客服知识库的整体使用指南，包括知识库架构、加载顺序、场景化处理流程。
> 最后更新：2026-07-20

## 1. 知识库架构总览

AI 客服知识库由以下 7 个层级组成，按优先级从高到低匹配：

| 层级 | 知识库 | 文件位置 | 用途 | 优先级 |
|------|--------|----------|------|--------|
| 1 | FAQ 库 | `data/shops/<shopId>/faq.json` | 精确匹配高频问题 | 100 |
| 2 | 类目规则 | `config/rules/category-rules.json` | 按主营类目加载规则 | 60-80 |
| 3 | 店铺规则 | `config/rules/<platform>/<shopId>/custom-rules.json` | 店铺定制规则 | 50-90 |
| 4 | 话术模板 | `config/templates/standard-templates.json` | 场景化话术 | 30-100 |
| 5 | 客服 Prompt | `config/prompt/customer-service.md` | LLM 生成依据 | - |
| 6 | 敏感词库 | `config/dict/sensitive-words.txt` | 安全检查 | block/warn |
| 7 | 商品/订单上下文 | 运行时注入 | 实时数据 | - |

## 2. 各层知识库详细说明

### 2.1 FAQ 库（精确匹配）
- **位置**：`data/shops/<shopId>/faq.json`
- **结构**：`[{q, a, priority}]`
- **匹配方式**：`q` 被转义为正则，全词匹配
- **加载时机**：店铺启动时加载到 RuleEngine
- **当前规模**：飞鸽 32 条，其他平台各 24 条
- **更新方式**：
  - UI：「店铺配置」→「FAQ 管理」
  - 直接编辑 JSON 文件（需重启应用生效）

### 2.2 类目规则库（regex 匹配）
- **位置**：`config/rules/category-rules.json`
- **结构**：`{ "<类目名>": [{name, pattern, answer, priority, enabled}] }`
- **加载方式**：根据 `shop_business_config.main_category` 字段加载对应类目规则
- **当前规模**：13 个类目（服装服饰/鞋包配饰/美妆个护/食品生鲜/家居日用/数码电器/母婴玩具/运动户外/图书文娱/其他/虚拟商品/定制商品/跨境商品）

### 2.3 店铺规则（custom-rules）
- **位置**：`config/rules/<platform>/<shopId>/custom-rules.json`
- **结构**：`[{name, pattern, answer, priority, enabled}]`
- **加载时机**：店铺启动时加载
- **用途**：店铺特殊规则（如店铺活动、特定商品话术）

### 2.4 话术模板库
- **位置**：`config/templates/standard-templates.json`
- **结构**：`{templates: [{id, category, scenario, content, tags, priority, enabled}]}`
- **当前规模**：75 个模板，13 个分类
  - `greeting`（5）：问候
  - `pre_sales`（10）：售前咨询
  - `after_sales`（8）：售后处理
  - `logistics`（7）：物流咨询
  - `activity`（6）：活动咨询
  - `complaint`（5）：投诉处理
  - `closing`（5）：结束语
  - `transfer`（5）：转接专员
  - `order_status`（5）：订单状态查询 ⭐ 新增
  - `order_modify`（4）：订单修改 ⭐ 新增
  - `payment`（4）：支付问题 ⭐ 新增
  - `refund`（4）：退款流程 ⭐ 新增
  - `account`（4）：账户问题 ⭐ 新增
  - `festival`（5）：节假日话术 ⭐ 新增
  - `interaction`（4）：互动话术 ⭐ 新增

### 2.5 客服 Prompt
- **位置**：`config/prompt/customer-service.md`
- **占位符**：`{shop_info}`（店铺信息）、`{product_info}`（当前咨询商品）
- **内容章节**：
  - 核心规范
  - 售后处理规则
  - 常见问题指引
  - 话术策略
  - **多轮对话处理规则** ⭐ 新增
  - **情绪安抚话术库** ⭐ 新增
  - **投诉升级判断** ⭐ 新增
  - **知识库使用指引** ⭐ 新增
  - 订单备注规则
  - 合规要求

### 2.6 敏感词库
- **位置**：`config/dict/sensitive-words.txt`
- **类型**：
  - `block`：命中后替换为 `fallback_response`（如"微信"、"支付宝"、"线下"）
  - `warn`：命中后记录日志但放行
- **检查时机**：所有回复发送前统一检查

## 3. 场景化处理 SOP

### 3.1 售后问题处理流程

```
买家提及"退货/退款/换货/质量/破损/错发/漏发"
  ↓
FAQ 精确匹配（优先级 95-97）
  ├─ 命中：返回标准话术 → 触发 transfer 工具
  └─ 未命中：类目规则匹配
      ├─ 命中：返回类目规则回复
      └─ 未命中：LLM 生成
          ↓
        LLM 判断是否需要转人工
          ├─ 是：调用 transfer 工具 → executeTransfer
          │   ├─ 飞鸽平台：查 agentMappings → transferToAgent 8 步流程
          │   └─ 其他平台：直接 manualTakeover 降级
          └─ 否：返回安抚话术 + 引导人工
```

**标准回复模板**：
- "亲，售后问题需要人工客服为您核实处理，我帮您转接人工客服，请稍等~"

### 3.2 物流异常处理流程

```
买家提及"物流慢/丢失/损坏/超时"
  ↓
判断物流超时程度：
  ├─ 24-48 小时未更新：安抚 + 引导关注
  ├─ 48-72 小时未更新：催件 + 反馈快递公司
  └─ 超过 72 小时未更新：立即转人工（物流丢失）
      ↓
触发 transfer 工具（logistics 角色）
```

### 3.3 投诉升级处理流程

```
买家情绪激动 / 提及"12315/曝光/起诉"
  ↓
立即识别为投诉升级
  ↓
不与买家争辩，使用共情话术
  ↓
调用 transfer 工具（general 角色）
  ↓
记录 escalation_queue（priority=urgent）
  ↓
状态机切换到 ManualMode
```

### 3.4 订单修改处理流程

```
买家要求"改地址/改规格/改数量/取消订单"
  ↓
判断订单状态：
  ├─ 待付款：可修改/取消（引导买家在订单页操作或联系人工）
  ├─ 已付款未发货：需人工客服处理 → 转人工
  └─ 已发货：无法修改 → 引导收货后处理
      ↓
触发 transfer 工具
```

### 3.5 商品咨询处理流程

```
买家询问"尺码/材质/规格/库存/价格"
  ↓
类目规则匹配
  ├─ 命中：返回类目规则回复（含详情页指引）
  └─ 未命中：话术模板匹配
      ├─ 命中：返回标准话术
      └─ 未命中：LLM 生成（参考商品详情页）
          ↓
        敏感词检查
          ├─ 通过：发送回复
          └─ 命中 block：替换为 fallback_response
```

### 3.6 退款进度查询流程

```
买家询问"退款进度/退款到账"
  ↓
FAQ 精确匹配
  ├─ 命中：返回退款流程说明
  └─ 未命中：话术模板匹配（refund 分类）
      ↓
判断退款状态：
  ├─ 审核中：安抚 + 等待
  ├─ 已退款：告知到账时间
  └─ 被拒绝：立即转人工申诉
```

### 3.7 节假日/大促处理流程

```
判断当前是否为节假日/大促期间
  ├─ 春节/国庆等：自动加载 festival 话术
  ├─ 双11/618 等：自动加载大促话术
  └─ 普通：使用标准问候
      ↓
买家咨询时附加营业时间提醒
      ↓
物流时效延长的预期管理
```

## 4. 知识库维护指南

### 4.1 新增 FAQ
1. 编辑 `data/shops/<shopId>/faq.json`
2. 添加 `{q, a, priority}` 对象
3. `q` 必须是完整问题文本（会被转义为正则）
4. `priority` 建议 60-100（越高越优先）
5. 重启应用生效

### 4.2 新增类目规则
1. 编辑 `config/rules/category-rules.json`
2. 在对应类目数组中添加 `{name, pattern, answer, priority, enabled}`
3. `pattern` 是 JavaScript 正则字符串
4. `name` 必须全局唯一
5. 重启应用生效

### 4.3 新增话术模板
1. 编辑 `config/templates/standard-templates.json`
2. 在 `templates` 数组中添加对象
3. `id` 必须全局唯一（建议 `<category>_<序号>` 格式）
4. `category` 选择已有分类或新建
5. `tags` 是关键词数组（用于匹配）
6. 重启应用生效

### 4.4 修改客服 Prompt
1. 编辑 `config/prompt/customer-service.md`
2. 保持占位符 `{shop_info}` 和 `{product_info}` 不变
3. 重启应用生效

### 4.5 新增敏感词
1. 编辑 `config/dict/sensitive-words.txt`
2. 格式：`<词>|<类型>|<等级>`
3. 类型：`block`（拦截替换）或 `warn`（仅记录）
4. 重启应用生效

## 5. 知识库与代码的集成点

| 知识库 | 加载代码 | 使用位置 |
|--------|----------|----------|
| FAQ 库 | `src/rules/RuleEngine.ts` `loadFaq` | RuleEngine.match |
| 类目规则 | `src/rules/RuleEngine.ts` `loadCategoryRules` | RuleEngine.match |
| 店铺规则 | `src/rules/RuleEngine.ts` `loadCustomRules` | RuleEngine.match |
| 话术模板 | `src/kb/TemplateLibrary.ts` | TemplateLibrary.match |
| 客服 Prompt | `src/shop/ShopSupervisor.ts` `buildPrompt` | DeepSeekClient.chat |
| 敏感词 | `src/secrets/SensitiveWordChecker.ts` | SensitiveWordChecker.check |

## 6. 知识库版本管理

- **全局配置快照**：`global` 作为虚拟 shopId 存储版本快照
- **审核工作流**：`src/kb/ReviewWorkflow.ts` 支持配置审核流程
- **权限检查**：`src/kb/PermissionChecker.ts` 控制配置修改权限
- **版本管理器**：`src/kb/VersionManager.ts` 管理配置版本历史

## 7. 常见问题排查

### Q1: FAQ 没有生效
**检查步骤**：
1. 确认 `data/shops/<shopId>/faq.json` 存在且 JSON 格式正确
2. 确认 `q` 字段是完整问题文本（不是关键词）
3. 确认应用已重启加载最新 FAQ
4. 查看日志中是否有 FAQ 加载失败的错误

### Q2: 类目规则没有匹配
**检查步骤**：
1. 确认 `shop_business_config.main_category` 字段值正确
2. 确认 `category-rules.json` 中对应类目存在
3. 确认规则的 `enabled` 为 `true`
4. 测试 `pattern` 正则是否能匹配买家消息

### Q3: 话术模板不生效
**检查步骤**：
1. 确认 `templates[].enabled` 为 `true`
2. 确认 `tags` 中包含买家消息的关键词
3. 确认 `priority` 不低于其他冲突模板

### Q4: LLM 回复不符合 Prompt 规范
**检查步骤**：
1. 确认 `config/prompt/customer-service.md` 占位符完整
2. 查看 `ai_reply_audit` 表中 `prompt_template` 字段
3. 确认 DeepSeek 模型版本正确（`deepseek-v4-flash`）

## 8. 相关源码索引

| 模块 | 文件 | 关键方法 |
|------|------|---------|
| 规则引擎 | `src/rules/RuleEngine.ts` | `loadFaq`, `loadCategoryRules`, `loadCustomRules`, `match` |
| 模板库 | `src/kb/TemplateLibrary.ts` | `match`, `getByCategory` |
| 版本管理 | `src/kb/VersionManager.ts` | `snapshot`, `restore` |
| 审核工作流 | `src/kb/ReviewWorkflow.ts` | `submit`, `approve`, `reject` |
| 权限检查 | `src/kb/PermissionChecker.ts` | `canEdit`, `canPublish` |
| 敏感词 | `src/secrets/SensitiveWordChecker.ts` | `check`, `reload` |
| Prompt 构建 | `src/shop/ShopSupervisor.ts` | `buildPrompt` |
| 配置加载 | `src/config/schema.ts` | `getPlatformDeepseekConfig` |
