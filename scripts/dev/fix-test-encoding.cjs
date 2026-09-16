/**
 * 修复 PowerShell 编码往返导致的测试文件损坏（U+FFFD 替换字符 + 换行丢失）
 * 用法：node scripts/dev/fix-test-encoding.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// 每文件：[损坏片段, 正确片段]（按出现顺序替换，不重复）
const FIXES = {
  'tests/unit/scheduler/BudgetTracker.test.ts': [
    ["it('全局日成本累�?, () => {", "it('全局日成本累加', () => {"],
    ["it('店铺超预算检�?, () => {", "it('店铺超预算检测', () => {"],
    ["it('优先级影响预算限�?, () => {", "it('优先级影响预算限额', () => {"],
    ["it('全局预算超限检�?, () => {", "it('全局预算超限检测', () => {"],
  ],
  'tests/unit/scheduler/ResourceScheduler.test.ts': [
    ["it('预算充足时允许执�?, async () => {", "it('预算充足时允许执行', async () => {"],
    ["it('全局预算超限时拒�?, async () => {", "it('全局预算超限时拒绝', async () => {"],
    ["it('店铺预算超限时拒�?, async () => {", "it('店铺预算超限时拒绝', async () => {"],
  ],
  'tests/chaos/cascade-failover.chaos.test.ts': [
    [' * 故障注入测试：三级级联降�? *', ' * 故障注入测试：三级级联降级\n *'],
    [' * 覆盖场景�? * - C-09', ' * 覆盖场景：\n * - C-09'],
    [' * 对应文档：docs/开发文�?综合�?md �?12.4 节、第 9.6 节模型级�? */', ' * 对应文档：docs/开发文档-综合版.md §12.4 节、第 9.6 节模型级别 */'],
    ["const HIGH_CONFIDENCE_CONTENT = '这是一条非常完整详细的回复，包含了所有必要的信息，语气专业且确定，建议您按照以下步骤操作即可解决问题�?;", "const HIGH_CONFIDENCE_CONTENT = '这是一条非常完整详细的回复，包含了所有必要的信息，语气专业且确定，建议您按照以下步骤操作即可解决问题。';"],
    ["const LOW_CONFIDENCE_CONTENT = '可能�?;", "const LOW_CONFIDENCE_CONTENT = '可能不明确';"],
    ["  it('C-09: Tier1 低置信度 �?升级 Tier2 �?仍低 �?Tier3 兜底', async () => {", "  it('C-09: Tier1 低置信度 → 升级 Tier2 → 仍低 → Tier3 兜底', async () => {"],
    ['    // 三个 provider 都可用，�?Tier1/Tier2 返回低置信度内容（短文本 + truncated�?    const tier1 = makeMockProvider(', '    // 三个 provider 都可用，让 Tier1/Tier2 返回低置信度内容（短文本 + truncated）\n    const tier1 = makeMockProvider('],
    ["      messages: [{ role: 'user', content: '我想退�? }],", "      messages: [{ role: 'user', content: '我想退货' }],"],
    ['    // 最终回复来�?Tier3', '    // 最终回复来自 Tier3'],
    ["  it('C-09b: Tier1 不可�?�?直接降级�?Tier2/Tier3', async () => {", "  it('C-09b: Tier1 不可用 → 直接降级到 Tier2/Tier3', async () => {"],
    ['    // 不注�?tier1，模�?Tier1 不可�?    registry.register(tier2);', '    // 不注册 tier1，模拟 Tier1 不可用\n    registry.register(tier2);'],
    ["  it('C-09c: provider 抛出网络异常后继续下一�?, async () => {", "  it('C-09c: provider 抛出网络异常后继续下一层', async () => {"],
  ],
  'tests/chaos/resource-exhaustion.chaos.test.ts': [
    [' * 故障注入测试：资源耗尽与预算控�? *', ' * 故障注入测试：资源耗尽与预算控制\n *'],
    [' * 覆盖场景�? * - C-12', ' * 覆盖场景：\n * - C-12'],
    [' * - C-19: 预算超限 �?ResourceScheduler 拒绝请求', ' * - C-19: 预算超限时 ResourceScheduler 拒绝请求'],
    [' * - C-20: 令牌桶耗尽 �?调度器降级到更便宜的 Tier', ' * - C-20: 令牌桶耗尽时调度器降级到更便宜的 Tier'],
    [' * 对应文档：docs/开发文�?综合�?md �?12.4 节、第 15 �?Token 测算与成本控�? */', ' * 对应文档：docs/开发文档-综合版.md §12.4 节、第 15 节 Token 测算与成本控制 */'],
    ["describe('Chaos: 资源耗尽与预算控�?, () => {", "describe('Chaos: 资源耗尽与预算控制', () => {"],
    ["describe('C-12: LruCache + ContextManager 大量操作后资源清�?, () => {", "describe('C-12: LruCache + ContextManager 大量操作后资源清理', () => {"],
    ["    it('LruCache 5000 次写入后全局条目数受�?, () => {", "    it('LruCache 5000 次写入后全局条目数受控', () => {"],
    ["    it('ContextManager 多轮操作�?clearAllTimers 正确清理', () => {", "    it('ContextManager 多轮操作后 clearAllTimers 正确清理', () => {"],
    ['    // 验证清理后仍可正常查�?      const messages = ctx.getRecentMessages(', '    // 验证清理后仍可正常查询\n    const messages = ctx.getRecentMessages('],
    ['    // 记录超过预算的成�?      budgetTracker.record({', '    // 记录超过预算的成本\n    budgetTracker.record({'],
    ['    // 请求 Tier3 但预算不足以支付 0.5 �?      const decision = await scheduler.acquire({', '    // 请求 Tier3 但预算不足以支付 0.5 元\n    const decision = await scheduler.acquire({'],
    ['    // 应降级到更便宜的 tier 或允许（�?reserve_ratio 兜底�?      expect(decision.allowed).toBe(true);', '    // 应降级到更便宜的 tier 或允许（由 reserve_ratio 兜底）\n    expect(decision.allowed).toBe(true);'],
    ["    it('令牌桶完全耗尽且无 reserve 时拒绝请�?, async () => {", "    it('令牌桶完全耗尽且无 reserve 时拒绝请求', async () => {"],
  ],
  'tests/integration/cost_analysis.test.ts': [
    [' * 成本分析与预算控制测�? *', ' * 成本分析与预算控制测试\n *'],
    [' * 测试内容�? * 1. �?DeepSeek 模式 vs 三级级联模式成本对比', ' * 测试内容：\n * 1. 纯 DeepSeek 模式 vs 三级级联模式成本对比'],
    [' * 3. 令牌桶补�? * 4. 优先级降�? *', ' * 3. 令牌桶补充\n * 4. 优先级降级\n *'],
    ["const HIGH_CONFIDENCE_CONTENT = '这是一条非常完整详细的回复，包含了所有必要的信息，语气专业且确定，建议您按照以下步骤操作即可解决问题�?;", "const HIGH_CONFIDENCE_CONTENT = '这是一条非常完整详细的回复，包含了所有必要的信息，语气专业且确定，建议您按照以下步骤操作即可解决问题。';"],
    ["const LOW_CONFIDENCE_CONTENT = '可能不确定，建议咨询人工客服�?;", "const LOW_CONFIDENCE_CONTENT = '可能不确定，建议咨询人工客服。';"],
    ["describe('成本分析与预算控�?, () => {", "describe('成本分析与预算控制', () => {"],
    ["describe('1. �?DeepSeek vs 三级级联成本对比', () => {", "describe('1. 纯 DeepSeek vs 三级级联成本对比', () => {"],
    ["  it('�?DeepSeek 模式成本', async () => {", "  it('纯 DeepSeek 模式成本', async () => {"],
    ["      messages: [{ role: 'user', content: '退货流程是什�? }],", "      messages: [{ role: 'user', content: '退货流程是什么' }],"],
    ['    console.log(`  �?DeepSeek 模式: ${REQUEST_COUNT} 请求, 总成�?¥${totalCost.toFixed(4)}, 平均 ¥${(totalCost / REQUEST_COUNT).toFixed(6)}/请求`);', '    console.log(`  纯 DeepSeek 模式: ${REQUEST_COUNT} 请求, 总成本 ¥${totalCost.toFixed(4)}, 平均 ¥${(totalCost / REQUEST_COUNT).toFixed(6)}/请求`);'],
    ["  it('三级级联模式成本�?0% tier1, 30% tier2, 20% tier3�?, async () => {", "  it('三级级联模式成本（50% tier1, 30% tier2, 20% tier3）', async () => {"],
    ['    console.log(`  三级级联模式: ${REQUEST_COUNT} 请求, 总成�?¥${totalCost.toFixed(4)}, 平均 ¥${(totalCost / REQUEST_COUNT).toFixed(6)}/请求`);', '    console.log(`  三级级联模式: ${REQUEST_COUNT} 请求, 总成本 ¥${totalCost.toFixed(4)}, 平均 ¥${(totalCost / REQUEST_COUNT).toFixed(6)}/请求`);'],
    ["  it('纯本地模式成本为�?, async () => {", "  it('纯本地模式成本为零', async () => {"],
    ['    console.log(`  纯本地模�? ${REQUEST_COUNT} 请求, 总成�?¥${totalCost.toFixed(4)}`);', '    console.log(`  纯本地模式: ${REQUEST_COUNT} 请求, 总成本 ¥${totalCost.toFixed(4)}`);'],
    ["      messages: [{ role: 'user', content: '退货流�? }],", "      messages: [{ role: 'user', content: '退货流程' }],"],
    ['    console.log(`  日预�?¥0.01: 20 请求�?${rejected} 个被拒绝`);', '    console.log(`  日预算 ¥0.01: 20 请求中 ${rejected} 个被拒绝`);'],
    ["      messages: [{ role: 'user', content: '退货流�? }],", "      messages: [{ role: 'user', content: '退货流程' }],"],
    ['    console.log(`  店铺日预�?¥0.01: 30 请求�?${rejected} 个被拒绝, 实际花费 ¥${budgetTracker.getDailyCost(\'shop1\').toFixed(4)}`);', '    console.log(`  店铺日预算 ¥0.01: 30 请求中 ${rejected} 个被拒绝, 实际花费 ¥${budgetTracker.getDailyCost(\'shop1\').toFixed(4)}`);'],
    ["describe('3. 令牌桶补�?, () => {", "describe('3. 令牌桶补充', () => {"],
    ['    console.log(`  初始余额: ¥${initial.toFixed(4)}, 消�?¥3 �? ¥${afterConsume.toFixed(4)}`);', '    console.log(`  初始余额: ¥${initial.toFixed(4)}, 消费 ¥3 后: ¥${afterConsume.toFixed(4)}`);'],
    ["    it('余额不足�?tryConsume 失败', () => {", "    it('余额不足时 tryConsume 失败', () => {"],
    ["describe('4. 优先级降�?, () => {", "describe('4. 优先级降级', () => {"],
    ["  it('high 优先级店铺日限额�?base*2', () => {", "  it('high 优先级店铺日限额为 base*2', () => {"],
    ['    console.log(`  预算�?50% 时降级店�? ${toDegrade.join(\', \')}`);', '    console.log(`  预算到 50% 时降级店铺: ${toDegrade.join(\', \')}`);'],
    ["describe('5. 成本对比汇�?, () => {", "describe('5. 成本对比汇总', () => {"],
    ["  console.log('\\n  ========== 成本对比汇�?==========');", "  console.log('\\n  ========== 成本对比汇总 ==========');"],
    ['    console.log(`  日均请求�? ${dailyRequests}`);', '    console.log(`  日均请求数: ${dailyRequests}`);'],
    ['    console.log(`  �?DeepSeek 模式: ¥${deepseekDaily.toFixed(2)}/�? ¥${(deepseekDaily * 30).toFixed(2)}/月`);', '    console.log(`  纯 DeepSeek 模式: ¥${deepseekDaily.toFixed(2)}/天, ¥${(deepseekDaily * 30).toFixed(2)}/月`);'],
    ['    console.log(`  三级级联模式: ¥${cascadeDaily.toFixed(2)}/�? ¥${(cascadeDaily * 30).toFixed(2)}/月`);', '    console.log(`  三级级联模式: ¥${cascadeDaily.toFixed(2)}/天, ¥${(cascadeDaily * 30).toFixed(2)}/月`);'],
    ['    console.log(`  纯本地模�?   ¥${localDaily.toFixed(2)}/�? ¥${(localDaily * 30).toFixed(2)}/月`);', '    console.log(`  纯本地模式:   ¥${localDaily.toFixed(2)}/天, ¥${(localDaily * 30).toFixed(2)}/月`);'],
  ],
  'tests/integration/multi_agent_perf.test.ts': [
    [' * 测试内容�? * 1. Agent 路由准确率（1000 条消息）', ' * 测试内容：\n * 1. Agent 路由准确率（1000 条消息）'],
    [' * 2. 级联调用链深度分�? * 3. 吞吐量与延迟�?0 并发�? * 4. 置信度评估正确�? *', ' * 2. 级联调用链深度分析\n * 3. 吞吐量与延迟（10 并发）\n * 4. 置信度评估正确性\n *'],
    ["const HIGH_CONFIDENCE_CONTENT = '这是一条非常完整详细的回复，包含了所有必要的信息，语气专业且确定，建议您按照以下步骤操作即可解决问题�?;", "const HIGH_CONFIDENCE_CONTENT = '这是一条非常完整详细的回复，包含了所有必要的信息，语气专业且确定，建议您按照以下步骤操作即可解决问题。';"],
    ["const LOW_CONFIDENCE_CONTENT = '可能不确定，建议咨询人工客服�?;", "const LOW_CONFIDENCE_CONTENT = '可能不确定，建议咨询人工客服。';"],
    ["describe('1. Agent 路由准确�?, () => {", "describe('1. Agent 路由准确率', () => {"],
    ["    { message: '换货流程是什�?, expectedAgent: 'after_sales' },", "    { message: '换货流程是什么', expectedAgent: 'after_sales' },"],
    ["    { message: '快递什么时候发�?, expectedAgent: 'logistics' },", "    { message: '快递什么时候发货', expectedAgent: 'logistics' },"],
    ["    { message: '物流到哪�?, expectedAgent: 'logistics' },", "    { message: '物流到哪里', expectedAgent: 'logistics' },"],
    ["    { message: '这两款有什么区�?, expectedAgent: 'product_expert' },", "    { message: '这两款有什么区别', expectedAgent: 'product_expert' },"],
    ["    { message: '你好，在�?, expectedAgent: 'general' },", "    { message: '你好，在吗', expectedAgent: 'general' },"],
    ["    { message: '请问一�?, expectedAgent: 'general' },", "    { message: '请问一下', expectedAgent: 'general' },"],
    ["    it('各场景路由命中率 �?95%', async () => {", "    it('各场景路由命中率 ≥95%', async () => {"],
    ['    console.log(`  路由准确�? ${(accuracy * 100).toFixed(1)}% (${correct}/${total})`);', '    console.log(`  路由准确率: ${(accuracy * 100).toFixed(1)}% (${correct}/${total})`);'],
    ["describe('2. 级联调用链深度分�?, () => {", "describe('2. 级联调用链深度分析', () => {"],
    ["    it('tier3 高置信度时深�?1', async () => {", "    it('tier3 高置信度时深度 1', async () => {"],
    ["      messages: [{ role: 'user', content: '退货流�? }],", "      messages: [{ role: 'user', content: '退货流程' }],"],
    ['    console.log(`  tier3 单层置信�? ${result.confidence.toFixed(4)}`);', '    console.log(`  tier3 单层置信度: ${result.confidence.toFixed(4)}`);'],
    ["    it('tier1 低置信度 �?升级�?tier3', async () => {", "    it('tier1 低置信度 → 升级到 tier3', async () => {"],
    ["      messages: [{ role: 'user', content: '退货流�? }],", "      messages: [{ role: 'user', content: '退货流程' }],"],
    ["    it('tier2 高置信度时深�?1', async () => {", "    it('tier2 高置信度时深度 1', async () => {"],
    ["      userMessage: '我要退�?,", "      userMessage: '我要退货',"],
    ["describe('4. 置信度评估正确�?, () => {", "describe('4. 置信度评估正确性', () => {"],
    ["    it('高置信度回复不触发升�?, () => {", "    it('高置信度回复不触发升级', () => {"],
    ["    it('tier3 置信度阈值低�?tier1', () => {", "    it('tier3 置信度阈值低于 tier1', () => {"],
  ],
};

let fixed = 0;
for (const [rel, pairs] of Object.entries(FIXES)) {
  const filePath = path.join(ROOT, rel);
  if (!fs.existsSync(filePath)) {
    console.log(`跳过（不存在）: ${rel}`);
    continue;
  }
  let content = fs.readFileSync(filePath, 'utf8');
  for (const [from, to] of pairs) {
    if (!content.includes(from)) {
      console.log(`未命中: ${rel}: ${from.slice(0, 40)}`);
      continue;
    }
    content = content.split(from).join(to);
    fixed++;
  }
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`已修复: ${rel}`);
}
console.log(`\n共修复 ${fixed} 处损坏片段`);
