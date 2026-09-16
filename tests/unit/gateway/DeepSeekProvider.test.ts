import { DeepSeekProvider } from '@/gateway/providers/DeepSeekProvider';
import type { DeepSeekClient } from '@/deepseek/DeepSeekClient';
import { createTestConfig } from '../helpers/testConfig';

describe('DeepSeekProvider', () => {
  it('无 API Key 时不可用，热更新 Key 后立即可用', async () => {
    const client = {
      currentApiKey: '',
      getCircuitState: jest.fn(() => ({
        state: 'closed' as const,
        consecutiveFailures: 0,
        openedAt: 0,
      })),
    };
    const provider = new DeepSeekProvider(
      client as unknown as DeepSeekClient,
      createTestConfig(),
      'tier3',
    );

    expect(provider.capability.available).toBe(false);
    expect(await provider.healthCheck()).toBe(false);

    client.currentApiKey = 'sk-configured';
    expect(provider.capability.available).toBe(true);
    expect(await provider.healthCheck()).toBe(true);
  });
});
