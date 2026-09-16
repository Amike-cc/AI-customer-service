/**
 * ModelRegistry 单元测试
 */
import { ModelRegistry } from '@/gateway/ModelRegistry';
import type { IModelProvider } from '@/gateway/providers/IModelProvider';
import type { ProviderCapability, ProviderType } from '@/gateway/types';
import type { ModelTier } from '@/scheduler/types';
import type { ChatResponse } from '@/deepseek/DeepSeekClient';
import type { ProviderChatRequest } from '@/gateway/types';

function makeMockProvider(type: ProviderType, tier: ModelTier, available = true): IModelProvider {
  const capability: ProviderCapability = {
    provider: type,
    tier,
    model: `model-${type}`,
    priceInputPer1k: 0.001,
    priceOutputPer1k: 0.002,
    avgLatencyMs: 1000,
    maxContextTokens: 32768,
    available,
  };
  return {
    provider: type,
    tier,
    capability,
    async chat(_req: ProviderChatRequest): Promise<ChatResponse> {
      return {
        content: 'mock reply',
        tokenInput: 10,
        tokenOutput: 20,
        latencyMs: 100,
        model: capability.model,
        cached: false,
        truncated: false,
      };
    },
    async healthCheck(): Promise<boolean> {
      return available;
    },
    updateConfig(): void {},
  };
}

describe('ModelRegistry', () => {
  it('注册后可按层级查询', () => {
    const registry = new ModelRegistry();
    registry.register(makeMockProvider('deepseek', 'tier3'));
    registry.register(makeMockProvider('qwen', 'tier2'));
    registry.register(makeMockProvider('local', 'tier1'));

    expect(registry.getByTier('tier3')).toHaveLength(1);
    expect(registry.getByTier('tier2')).toHaveLength(1);
    expect(registry.getByTier('tier1')).toHaveLength(1);
  });

  it('getAvailableByTier 返回可用 Provider', () => {
    const registry = new ModelRegistry();
    registry.register(makeMockProvider('deepseek', 'tier3', true));
    registry.register(makeMockProvider('qwen', 'tier2', false));

    expect(registry.getAvailableByTier('tier3')?.provider).toBe('deepseek');
    expect(registry.getAvailableByTier('tier2')).toBeUndefined();
  });

  it('注销后不再返回', () => {
    const registry = new ModelRegistry();
    registry.register(makeMockProvider('qwen', 'tier2'));
    expect(registry.get('qwen')).toBeDefined();

    registry.unregister('qwen');
    expect(registry.get('qwen')).toBeUndefined();
    expect(registry.getByTier('tier2')).toHaveLength(0);
  });

  it('getAll 返回所有 Provider', () => {
    const registry = new ModelRegistry();
    registry.register(makeMockProvider('deepseek', 'tier3'));
    registry.register(makeMockProvider('qwen', 'tier2'));
    expect(registry.getAll()).toHaveLength(2);
  });

  it('getTiers 返回已排序的层级', () => {
    const registry = new ModelRegistry();
    registry.register(makeMockProvider('deepseek', 'tier3'));
    registry.register(makeMockProvider('local', 'tier1'));
    registry.register(makeMockProvider('qwen', 'tier2'));
    expect(registry.getTiers()).toEqual(['tier1', 'tier2', 'tier3']);
  });
});
