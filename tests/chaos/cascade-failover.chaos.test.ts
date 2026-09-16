/**
 * 故障注入测试：三级级联降级
 *
 * 覆盖场景：
 * - C-09: 三级级联逐级降级（Tier1/Tier2 返回低置信度，最终由 Tier3 兜底）
 *
 * 对应文档：docs/开发文档-综合版.md §12.4 节、第 9.6 节模型级别 */
import { ModelGateway } from '@/gateway/ModelGateway';
import { ModelRegistry } from '@/gateway/ModelRegistry';
import { ConfidenceEvaluator } from '@/gateway/ConfidenceEvaluator';
import { ResourceScheduler } from '@/scheduler/ResourceScheduler';
import { CostTokenBucket } from '@/scheduler/CostTokenBucket';
import { BudgetTracker } from '@/scheduler/BudgetTracker';
import { PrioritySelector } from '@/scheduler/PrioritySelector';
import type { IModelProvider } from '@/gateway/providers/IModelProvider';
import type { ProviderCapability, ProviderType, ProviderChatRequest } from '@/gateway/types';
import type { ModelTier } from '@/scheduler/types';
import type { ChatResponse } from '@/deepseek/DeepSeekClient';
import type { Config } from '@/config/schema';
import type { AppLogger } from '@/logging/logger';
import type { MetricsCollector } from '@/monitor/MetricsCollector';
import { createTestConfig } from '../unit/helpers/testConfig';

const HIGH_CONFIDENCE_CONTENT = '这是一条非常完整详细的回复，包含了所有必要的信息，语气专业且确定，建议您按照以下步骤操作即可解决问题。';
const LOW_CONFIDENCE_CONTENT = '可能不明确';

function makeMockProvider(
  type: ProviderType,
  tier: ModelTier,
  opts: { highConfidence: boolean; available: boolean; latencyMs?: number },
): IModelProvider {
  const capability: ProviderCapability = {
    provider: type,
    tier,
    model: `model-${type}`,
    priceInputPer1k: type === 'local' ? 0 : 0.001,
    priceOutputPer1k: type === 'local' ? 0 : 0.002,
    avgLatencyMs: opts.latencyMs ?? 100,
    maxContextTokens: 32768,
    available: opts.available,
  };

  return {
    provider: type,
    tier,
    capability,
    chat: jest.fn(async (req: ProviderChatRequest): Promise<ChatResponse> => {
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
    }),
    async healthCheck(): Promise<boolean> {
      return opts.available;
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
    trace: jest.fn(),
  } as unknown as AppLogger;
}

function makeMockMetrics(): MetricsCollector {
  return {
    inc: jest.fn(),
    set: jest.fn(),
    observe: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
  } as unknown as MetricsCollector;
}

describe('Chaos: 三级级联降级', () => {
  let config: Config;

  beforeEach(() => {
    config = createTestConfig({
      gateway: {
        ...createTestConfig().gateway,
        enabled: true,
        cascade: {
          enabled: true,
          confidence_thresholds: { tier1: 0.75, tier2: 0.70, tier3: 0.60 },
          max_depth: 3,
        },
        providers: {
          deepseek: { enabled: true, tier: 'tier3' },
          qwen: { enabled: true, tier: 'tier2', api_url: '', api_key_env_var: '', model: '', timeout_ms: 8000 },
          local: { enabled: true, tier: 'tier1', api_url: '', model: '', timeout_ms: 5000 },
        },
      },
    });
  });

  it('C-09: Tier1 低置信度 → 升级 Tier2 → 仍低 → Tier3 兜底', async () => {
    // 三个 provider 都可用，让 Tier1/Tier2 返回低置信度内容（短文本 + truncated）
    const tier1 = makeMockProvider('local', 'tier1', { highConfidence: false, available: true });
    const tier2 = makeMockProvider('qwen', 'tier2', { highConfidence: false, available: true });
    const tier3 = makeMockProvider('deepseek', 'tier3', { highConfidence: true, available: true });

    const registry = new ModelRegistry();
    registry.register(tier1);
    registry.register(tier2);
    registry.register(tier3);

    const logger = makeMockLogger();
    const metrics = makeMockMetrics();
    const scheduler = new ResourceScheduler({
      tokenBucket: new CostTokenBucket(config),
      budgetTracker: new BudgetTracker(config, null),
      prioritySelector: new PrioritySelector(config),
      metrics,
      logger,
      config,
    });
    const confidenceEvaluator = new ConfidenceEvaluator();
    const gateway = new ModelGateway({ registry, confidenceEvaluator, scheduler, metrics, logger, config });

    const response = await gateway.route({
      shopId: 'shop-chaos-09',
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: '我想退货' }],
      preferredTier: 'tier1',
    });

    expect(response).toBeDefined();
    expect(response.provider).toBe('deepseek');
    // Tier1 应该被调用过
    expect(tier1.chat).toHaveBeenCalled();
    // 最终回复来自 Tier3
    expect(response.cascadeChain).toBeDefined();
    expect(response.cascadeChain!.length).toBeGreaterThanOrEqual(1);
  });

  it('C-09b: Tier1 不可用 → 直接降级到 Tier2/Tier3', async () => {
    const tier2 = makeMockProvider('qwen', 'tier2', { highConfidence: true, available: true });
    const tier3 = makeMockProvider('deepseek', 'tier3', { highConfidence: true, available: true });

    const registry = new ModelRegistry();
    // 不注册 tier1，模拟 Tier1 不可用
    registry.register(tier2);
    registry.register(tier3);

    const logger = makeMockLogger();
    const metrics = makeMockMetrics();
    const scheduler = new ResourceScheduler({
      tokenBucket: new CostTokenBucket(config),
      budgetTracker: new BudgetTracker(config, null),
      prioritySelector: new PrioritySelector(config),
      metrics,
      logger,
      config,
    });
    const confidenceEvaluator = new ConfidenceEvaluator();
    const gateway = new ModelGateway({ registry, confidenceEvaluator, scheduler, metrics, logger, config });

    const response = await gateway.route({
      shopId: 'shop-chaos-09b',
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: '物流什么时候到' }],
      preferredTier: 'tier1',
    });

    expect(response).toBeDefined();
    expect(tier2.chat).toHaveBeenCalled();
  });

  it('C-09c: provider 抛出网络异常后继续下一层', async () => {
    const tier1 = makeMockProvider('local', 'tier1', { highConfidence: false, available: true });
    (tier1.chat as jest.Mock).mockRejectedValueOnce(new Error('network timeout'));
    const tier2 = makeMockProvider('qwen', 'tier2', { highConfidence: true, available: true });

    const registry = new ModelRegistry();
    registry.register(tier1);
    registry.register(tier2);
    const logger = makeMockLogger();
    const metrics = makeMockMetrics();
    const scheduler = new ResourceScheduler({
      tokenBucket: new CostTokenBucket(config),
      budgetTracker: new BudgetTracker(config, null),
      prioritySelector: new PrioritySelector(config),
      metrics,
      logger,
      config,
    });
    const gateway = new ModelGateway({
      registry,
      confidenceEvaluator: new ConfidenceEvaluator(),
      scheduler,
      metrics,
      logger,
      config,
    });

    const response = await gateway.route({
      shopId: 'shop-chaos-09c',
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: '查询物流' }],
      preferredTier: 'tier1',
    });

    expect(response.provider).toBe('qwen');
    expect(tier2.chat).toHaveBeenCalled();
    expect(response.cascadeChain?.[0].upgradeReason).toContain('network timeout');
  });
});
