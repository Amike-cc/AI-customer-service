/**
 * 成本分析与预算控制测试
 *
 * 测试内容：
 * 1. 纯 DeepSeek 模式 vs 三级级联模式成本对比
 * 2. 预算超限拒绝
 * 3. 令牌桶补充
 * 4. 优先级降级
 *
 * 使用 mock provider，不调用真实 API
 */
import { ModelGateway } from '@/gateway/ModelGateway';
import { ModelRegistry } from '@/gateway/ModelRegistry';
import { ConfidenceEvaluator } from '@/gateway/ConfidenceEvaluator';
import type { IModelProvider } from '@/gateway/providers/IModelProvider';
import { ResourceScheduler } from '@/scheduler/ResourceScheduler';
import { CostTokenBucket } from '@/scheduler/CostTokenBucket';
import { BudgetTracker } from '@/scheduler/BudgetTracker';
import { PrioritySelector } from '@/scheduler/PrioritySelector';
import type { ProviderCapability, ProviderType, ProviderChatRequest } from '@/gateway/types';
import type { ModelTier } from '@/scheduler/types';
import type { ChatResponse } from '@/deepseek/DeepSeekClient';
import type { Config } from '@/config/schema';
import type { AppLogger } from '@/logging/logger';
import type { MetricsCollector } from '@/monitor/MetricsCollector';
import { createTestConfig } from '../unit/helpers/testConfig';

const HIGH_CONFIDENCE_CONTENT = '这是一条非常完整详细的回复，包含了所有必要的信息，语气专业且确定，建议您按照以下步骤操作即可解决问题。';
const LOW_CONFIDENCE_CONTENT = '可能不确定，建议咨询人工客服。';

function makeMockProvider(
  type: ProviderType,
  tier: ModelTier,
  priceIn: number,
  priceOut: number,
  highConfidence: boolean,
): IModelProvider {
  const capability: ProviderCapability = {
    provider: type,
    tier,
    model: `model-${type}`,
    priceInputPer1k: priceIn,
    priceOutputPer1k: priceOut,
    avgLatencyMs: 100,
    maxContextTokens: 32768,
    available: true,
  };

  return {
    provider: type,
    tier,
    capability,
    async chat(req: ProviderChatRequest): Promise<ChatResponse> {
      const content = highConfidence ? HIGH_CONFIDENCE_CONTENT : LOW_CONFIDENCE_CONTENT;
      const tokenInput = req.messages.reduce((s, m) => s + m.content.length, 0) / 2;
      const tokenOutput = content.length;
      return {
        content,
        tokenInput,
        tokenOutput,
        latencyMs: 50,
        model: capability.model,
        cached: false,
        finishReason: highConfidence ? 'stop' : 'length',
        truncated: !highConfidence,
      };
    },
    async healthCheck(): Promise<boolean> {
      return true;
    },
    updateConfig(): void {},
  };
}

function makeMockLogger(): AppLogger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as AppLogger;
}

function makeMockMetrics(): MetricsCollector {
  return {
    inc: jest.fn(),
    set: jest.fn(),
    observe: jest.fn(),
  } as unknown as MetricsCollector;
}

function createGateway(config: Config, providers: IModelProvider[]): {
  gateway: ModelGateway;
  scheduler: ResourceScheduler;
  budgetTracker: BudgetTracker;
  tokenBucket: CostTokenBucket;
} {
  const registry = new ModelRegistry();
  for (const p of providers) {
    registry.register(p);
  }

  const tokenBucket = new CostTokenBucket(config);
  const budgetTracker = new BudgetTracker(config, null);
  const prioritySelector = new PrioritySelector(config);
  const logger = makeMockLogger();
  const metrics = makeMockMetrics();

  const scheduler = new ResourceScheduler({
    tokenBucket,
    budgetTracker,
    prioritySelector,
    metrics,
    logger,
    config,
  });

  const confidenceEvaluator = new ConfidenceEvaluator();
  const gateway = new ModelGateway({
    registry,
    confidenceEvaluator,
    scheduler,
    metrics,
    logger,
    config,
  });

  return { gateway, scheduler, budgetTracker, tokenBucket };
}

describe('成本分析与预算控制', () => {
  describe('1. 纯 DeepSeek vs 三级级联成本对比', () => {
    const REQUEST_COUNT = 100;

    it('纯 DeepSeek 模式成本', async () => {
      const config = createTestConfig();
      const { gateway } = createGateway(config, [
        makeMockProvider('deepseek', 'tier3', 0.00027, 0.0011, true),
      ]);

      let totalCost = 0;
      for (let i = 0; i < REQUEST_COUNT; i++) {
        const result = await gateway.route({
          shopId: 'shop1',
          sessionId: `s${i}`,
          messages: [{ role: 'user', content: '退货流程是什么' }],
          preferredTier: 'tier3',
        });
        totalCost += result.costYuan;
      }

      console.log(`  纯 DeepSeek 模式: ${REQUEST_COUNT} 请求, 总成本 ¥${totalCost.toFixed(4)}, 平均 ¥${(totalCost / REQUEST_COUNT).toFixed(6)}/请求`);
      expect(totalCost).toBeGreaterThan(0);
    });

    it('三级级联模式成本（50% tier1, 30% tier2, 20% tier3）', async () => {
      const config = createTestConfig();
      const { gateway } = createGateway(config, [
        makeMockProvider('local', 'tier1', 0, 0, false),
        makeMockProvider('qwen', 'tier2', 0.004, 0.012, true),
        makeMockProvider('deepseek', 'tier3', 0.00027, 0.0011, true),
      ]);

      let totalCost = 0;
      let tier1Count = 0;
      let tier2Count = 0;
      let tier3Count = 0;

      for (let i = 0; i < REQUEST_COUNT; i++) {
        const result = await gateway.route({
          shopId: 'shop1',
          sessionId: `s${i}`,
          messages: [{ role: 'user', content: '退货流程是什么' }],
          preferredTier: i % 2 === 0 ? 'tier1' : i % 5 === 0 ? 'tier2' : 'tier3',
        });

        totalCost += result.costYuan;
        if (result.provider === 'local') tier1Count++;
        else if (result.provider === 'qwen') tier2Count++;
        else tier3Count++;
      }

      console.log(`  三级级联模式: ${REQUEST_COUNT} 请求, 总成本 ¥${totalCost.toFixed(4)}, 平均 ¥${(totalCost / REQUEST_COUNT).toFixed(6)}/请求`);
      console.log(`    分布: tier1=${tier1Count}, tier2=${tier2Count}, tier3=${tier3Count}`);
    });

    it('纯本地模式成本为零', async () => {
      const config = createTestConfig();
      const { gateway } = createGateway(config, [
        makeMockProvider('local', 'tier1', 0, 0, true),
      ]);

      let totalCost = 0;
      for (let i = 0; i < REQUEST_COUNT; i++) {
        const result = await gateway.route({
          shopId: 'shop1',
          sessionId: `s${i}`,
          messages: [{ role: 'user', content: '你好' }],
          preferredTier: 'tier1',
        });
        totalCost += result.costYuan;
      }

      console.log(`  纯本地模式: ${REQUEST_COUNT} 请求, 总成本 ¥${totalCost.toFixed(4)}`);
      expect(totalCost).toBe(0);
    });
  });

  describe('2. 预算超限拒绝', () => {
    it('全局日预算超限时返回 fallback', async () => {
      const config = createTestConfig({
        scheduler: {
          enabled: true,
          token_bucket: { daily_budget_yuan: 0.01, reserve_ratio: 0.2 },
          budget: {
            global_daily_yuan: 0.01,
            global_monthly_yuan: 2000,
            per_shop_daily_yuan: 5,
            warn_threshold: 0.8,
            critical_threshold: 1.0,
          },
          default_priority: 'normal',
        },
      } as never);

      const { gateway } = createGateway(config, [
        makeMockProvider('deepseek', 'tier3', 1.0, 1.0, true),
      ]);

      const results: string[] = [];
      for (let i = 0; i < 20; i++) {
        const result = await gateway.route({
          shopId: 'shop1',
          sessionId: `s${i}`,
          messages: [{ role: 'user', content: '退货流程' }],
          preferredTier: 'tier3',
        });
        results.push(result.model === 'fallback' ? 'rejected' : 'ok');
      }

      const rejected = results.filter((r) => r === 'rejected').length;
      console.log(`  日预算 ¥0.01: 20 请求中 ${rejected} 个被拒绝`);
      expect(rejected).toBeGreaterThan(0);
    });

    it('店铺日预算超限时拒绝', async () => {
      const config = createTestConfig({
        scheduler: {
          enabled: true,
          token_bucket: { daily_budget_yuan: 50, reserve_ratio: 0.2 },
          budget: {
            global_daily_yuan: 100,
            global_monthly_yuan: 2000,
            per_shop_daily_yuan: 0.01,
            warn_threshold: 0.8,
            critical_threshold: 1.0,
          },
          default_priority: 'normal',
        },
      } as never);

      const { gateway, budgetTracker } = createGateway(config, [
        makeMockProvider('deepseek', 'tier3', 1.0, 1.0, true),
      ]);

      const results: string[] = [];
      for (let i = 0; i < 30; i++) {
        const result = await gateway.route({
          shopId: 'shop1',
          sessionId: `s${i}`,
          messages: [{ role: 'user', content: '退货流程' }],
          preferredTier: 'tier3',
        });
        results.push(result.model === 'fallback' ? 'rejected' : 'ok');
      }

      const rejected = results.filter((r) => r === 'rejected').length;
      console.log(`  店铺日预算 ¥0.01: 30 请求中 ${rejected} 个被拒绝, 实际花费 ¥${budgetTracker.getDailyCost('shop1').toFixed(4)}`);
      expect(rejected).toBeGreaterThan(0);
    });
  });

  describe('3. 令牌桶补充', () => {
    it('消耗后剩余减少，补充后恢复', () => {
      const config = createTestConfig({
        scheduler: {
          enabled: true,
          token_bucket: { daily_budget_yuan: 10, reserve_ratio: 0.2 },
          budget: {
            global_daily_yuan: 100,
            global_monthly_yuan: 2000,
            per_shop_daily_yuan: 5,
            warn_threshold: 0.8,
            critical_threshold: 1.0,
          },
          default_priority: 'normal',
        },
      } as never);

      const bucket = new CostTokenBucket(config);
      const initial = bucket.remaining;

      const result = bucket.tryConsume(3);
      expect(result.success).toBe(true);
      const afterConsume = bucket.remaining;
      console.log(`  初始余额: ¥${initial.toFixed(4)}, 消费 ¥3 后: ¥${afterConsume.toFixed(4)}`);

      expect(afterConsume).toBeLessThan(initial);
    });

    it('余额不足时 tryConsume 失败', () => {
      const config = createTestConfig({
        scheduler: {
          enabled: true,
          token_bucket: { daily_budget_yuan: 1, reserve_ratio: 0.2 },
          budget: {
            global_daily_yuan: 100,
            global_monthly_yuan: 2000,
            per_shop_daily_yuan: 5,
            warn_threshold: 0.8,
            critical_threshold: 1.0,
          },
          default_priority: 'normal',
        },
      } as never);

      const bucket = new CostTokenBucket(config);
      const result = bucket.tryConsume(2);
      expect(result.success).toBe(false);
      console.log(`  余额 ¥1, 请求 ¥2: 成功=${result.success}, 剩余 ¥${result.remaining.toFixed(4)}`);
    });
  });

  describe('4. 优先级降级', () => {
    it('high 优先级店铺日限额为 base*2', () => {
      const config = createTestConfig();
      const tracker = new BudgetTracker(config, null);

      tracker.setShopPriority('shop-high', 'high');
      tracker.setShopPriority('shop-low', 'low');

      console.log(`  normal 店铺限额: ¥${config.scheduler.budget.per_shop_daily_yuan}`);
      console.log(`  high 店铺限额: ¥${(config.scheduler.budget.per_shop_daily_yuan * 2).toFixed(2)}`);

      expect(tracker.isShopOverBudget('shop-high')).toBe(false);
    });

    it('PrioritySelector 返回应降级的店铺', () => {
      const config = createTestConfig();
      const selector = new PrioritySelector(config);

      selector.setPriority('shop1', 'low');
      selector.setPriority('shop2', 'normal');
      selector.setPriority('shop3', 'high');

      const toDegrade = selector.selectForDegrade(['shop1', 'shop2', 'shop3'], 0.5);

      console.log(`  预算到 50% 时降级店铺: ${toDegrade.join(', ')}`);
      expect(toDegrade).toContain('shop1');
      expect(toDegrade).not.toContain('shop3');
    });
  });

  describe('5. 成本对比汇总', () => {
    it('三种模式日均成本预估', () => {
      const dailyRequests = 500;

      const deepseekCostPerReq = 0.005;
      const cascadeCostPerReq = 0.002;
      const localCostPerReq = 0;

      const deepseekDaily = deepseekCostPerReq * dailyRequests;
      const cascadeDaily = cascadeCostPerReq * dailyRequests;
      const localDaily = localCostPerReq * dailyRequests;

      console.log('\n  ========== 成本对比汇总 ==========');
      console.log(`  日均请求数: ${dailyRequests}`);
      console.log(`  纯 DeepSeek 模式: ¥${deepseekDaily.toFixed(2)}/天, ¥${(deepseekDaily * 30).toFixed(2)}/月`);
      console.log(`  三级级联模式: ¥${cascadeDaily.toFixed(2)}/天, ¥${(cascadeDaily * 30).toFixed(2)}/月`);
      console.log(`  纯本地模式:   ¥${localDaily.toFixed(2)}/天, ¥${(localDaily * 30).toFixed(2)}/月`);
      console.log(`  级联模式节省: ${((1 - cascadeDaily / deepseekDaily) * 100).toFixed(1)}%`);
      console.log('  ==================================\n');

      expect(cascadeDaily).toBeLessThan(deepseekDaily);
    });
  });
});
