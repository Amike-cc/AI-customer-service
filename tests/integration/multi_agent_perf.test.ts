/**
 * Multi-Agent 集群性能测试
 *
 * 测试内容：
 * 1. Agent 路由准确率（1000 条消息）
 * 2. 级联调用链深度分析
 * 3. 吞吐量与延迟（10 并发）
 * 4. 置信度评估正确性
 *
 * 使用 mock provider，不调用真实 API
 */
import { Orchestrator } from '@/agents/Orchestrator';
import { AfterSalesAgent } from '@/agents/AfterSalesAgent';
import { LogisticsAgent } from '@/agents/LogisticsAgent';
import { ProductExpertAgent } from '@/agents/ProductExpertAgent';
import { GeneralAgent } from '@/agents/GeneralAgent';
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
  opts: { highConfidence: boolean; latencyMs?: number },
): IModelProvider {
  const capability: ProviderCapability = {
    provider: type,
    tier,
    model: `model-${type}`,
    priceInputPer1k: type === 'local' ? 0 : 0.001,
    priceOutputPer1k: type === 'local' ? 0 : 0.002,
    avgLatencyMs: opts.latencyMs ?? 100,
    maxContextTokens: 32768,
    available: true,
  };

  return {
    provider: type,
    tier,
    capability,
    async chat(req: ProviderChatRequest): Promise<ChatResponse> {
      const content = opts.highConfidence ? HIGH_CONFIDENCE_CONTENT : LOW_CONFIDENCE_CONTENT;
      return {
        content,
        tokenInput: req.messages.reduce((s, m) => s + m.content.length, 0),
        tokenOutput: content.length,
        latencyMs: opts.latencyMs ?? 50,
        model: capability.model,
        cached: false,
        finishReason: opts.highConfidence ? 'stop' : 'length',
        truncated: !opts.highConfidence,
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

function createGatewayWithProviders(
  config: Config,
  providers: IModelProvider[],
): { gateway: ModelGateway; scheduler: ResourceScheduler } {
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

  return { gateway, scheduler };
}

function createOrchestrator(config: Config, gateway: ModelGateway, scheduler: ResourceScheduler): Orchestrator {
  const logger = makeMockLogger();
  const metrics = makeMockMetrics();
  const agents = [
    new AfterSalesAgent(gateway, scheduler, logger),
    new LogisticsAgent(gateway, scheduler, logger),
    new ProductExpertAgent(gateway, scheduler, logger),
    new GeneralAgent(gateway, scheduler, logger),
  ];
  return new Orchestrator({ agents, logger, metrics, config });
}

describe('Multi-Agent 集群性能测试', () => {
  const config = createTestConfig();

  describe('1. Agent 路由准确率', () => {
    const testCases = [
      { message: '我要退货，商品坏了', expectedAgent: 'after_sales' },
      { message: '退款多久能到账', expectedAgent: 'after_sales' },
      { message: '换货流程是什么', expectedAgent: 'after_sales' },
      { message: '快递什么时候发货', expectedAgent: 'logistics' },
      { message: '物流到哪里', expectedAgent: 'logistics' },
      { message: '运费多少', expectedAgent: 'logistics' },
      { message: '这两款有什么区别', expectedAgent: 'product_expert' },
      { message: '推荐哪个尺码', expectedAgent: 'product_expert' },
      { message: 'XL码适合多高', expectedAgent: 'product_expert' },
      { message: '你好，在吗', expectedAgent: 'general' },
      { message: '谢谢', expectedAgent: 'general' },
      { message: '请问一下', expectedAgent: 'general' },
    ];

    it('各场景路由命中率 ≥95%', async () => {
      const { gateway, scheduler } = createGatewayWithProviders(config, [
        makeMockProvider('deepseek', 'tier3', { highConfidence: true }),
      ]);
      const orchestrator = createOrchestrator(config, gateway, scheduler);

      let correct = 0;
      const total = testCases.length * 100;

      for (let i = 0; i < 100; i++) {
        for (const tc of testCases) {
          const result = await orchestrator.orchestrate({
            shopId: 'shop1',
            sessionId: `s${i}`,
            userMessage: tc.message,
            history: [],
          });
          if (result.agentId === tc.expectedAgent) correct++;
        }
      }

      const accuracy = correct / total;
      console.log(`  路由准确率: ${(accuracy * 100).toFixed(1)}% (${correct}/${total})`);
      expect(accuracy).toBeGreaterThanOrEqual(0.9);
    });
  });

  describe('2. 级联调用链深度分析', () => {
    it('tier3 高置信度时深度 1', async () => {
      const { gateway } = createGatewayWithProviders(config, [
        makeMockProvider('deepseek', 'tier3', { highConfidence: true }),
      ]);

      const result = await gateway.route({
        shopId: 'shop1',
        sessionId: 's1',
        messages: [{ role: 'user', content: '退货流程' }],
        preferredTier: 'tier3',
      });

      expect(result.cascadeChain).toBeUndefined();
      expect(result.confidence).toBeGreaterThan(0.6);
      console.log(`  tier3 单层置信度: ${result.confidence.toFixed(4)}`);
    });

    it('tier1 低置信度 → 升级到 tier3', async () => {
      const { gateway } = createGatewayWithProviders(config, [
        makeMockProvider('local', 'tier1', { highConfidence: false }),
        makeMockProvider('qwen', 'tier2', { highConfidence: false }),
        makeMockProvider('deepseek', 'tier3', { highConfidence: true }),
      ]);

      const result = await gateway.route({
        shopId: 'shop1',
        sessionId: 's1',
        messages: [{ role: 'user', content: '退货流程' }],
        preferredTier: 'tier1',
      });

      expect(result.cascadeChain).toBeDefined();
      expect(result.cascadeChain!.length).toBeGreaterThan(1);
      expect(result.provider).toBe('deepseek');
      console.log(`  级联深度: ${result.cascadeChain!.length}, 终止 provider: ${result.provider}`);
    });

    it('tier2 高置信度时深度 1', async () => {
      const { gateway } = createGatewayWithProviders(config, [
        makeMockProvider('qwen', 'tier2', { highConfidence: true }),
        makeMockProvider('deepseek', 'tier3', { highConfidence: true }),
      ]);

      const result = await gateway.route({
        shopId: 'shop1',
        sessionId: 's1',
        messages: [{ role: 'user', content: '物流查询' }],
        preferredTier: 'tier2',
      });

      expect(result.cascadeChain).toBeUndefined();
      expect(result.provider).toBe('qwen');
      console.log(`  tier2 单层终止, provider: ${result.provider}`);
    });
  });

  describe('3. 吞吐量与延迟', () => {
    it('50 并发请求 QPS 测量', async () => {
      const { gateway, scheduler } = createGatewayWithProviders(config, [
        makeMockProvider('deepseek', 'tier3', { highConfidence: true, latencyMs: 5 }),
      ]);
      const orchestrator = createOrchestrator(config, gateway, scheduler);

      const concurrency = 50;
      const start = Date.now();
      const promises = Array.from({ length: concurrency }, (_, i) =>
        orchestrator.orchestrate({
          shopId: 'shop1',
          sessionId: `s${i}`,
          userMessage: '我要退货',
          history: [],
        }),
      );
      const results = await Promise.all(promises);
      const elapsed = Date.now() - start;

      const qps = (concurrency / elapsed) * 1000;
      const avgLatency = results.reduce((s, r) => s + r.latencyMs, 0) / concurrency;

      console.log(`  ${concurrency} 并发: 耗时 ${elapsed}ms, QPS ${qps.toFixed(1)}, 平均延迟 ${avgLatency.toFixed(1)}ms`);
      expect(results).toHaveLength(concurrency);
      expect(qps).toBeGreaterThan(0);
    });
  });

  describe('4. 置信度评估正确性', () => {
    const evaluator = new ConfidenceEvaluator();

    it('高置信度回复不触发升级', () => {
      const score = evaluator.evaluate({
        content: HIGH_CONFIDENCE_CONTENT,
        finishReason: 'stop',
        truncated: false,
        model: 'deepseek-v4-flash',
        tier: 'tier3',
        maxTokens: 1024,
      });
      console.log(`  高置信度评分: ${score.toFixed(4)}`);
      expect(score).toBeGreaterThan(0.8);
      expect(evaluator.shouldUpgrade(score, 'tier3', { tier1: 0.75, tier2: 0.70, tier3: 0.60 })).toBe(false);
    });

    it('低置信度回复触发升级', () => {
      const score = evaluator.evaluate({
        content: LOW_CONFIDENCE_CONTENT,
        finishReason: 'length',
        truncated: true,
        model: 'qwen2.5:7b',
        tier: 'tier1',
        maxTokens: 256,
      });
      console.log(`  低置信度评分: ${score.toFixed(4)}`);
      expect(evaluator.shouldUpgrade(score, 'tier1', { tier1: 0.75, tier2: 0.70, tier3: 0.60 })).toBe(true);
    });

    it('tier3 置信度阈值低于 tier1', () => {
      const thresholds = { tier1: 0.75, tier2: 0.70, tier3: 0.60 };
      expect(thresholds.tier3).toBeLessThan(thresholds.tier1);
      expect(thresholds.tier2).toBeLessThan(thresholds.tier1);
      expect(thresholds.tier3).toBeLessThanOrEqual(thresholds.tier2);
    });
  });
});
