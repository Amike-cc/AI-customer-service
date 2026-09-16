/**
 * 故障注入测试：网络抖动与熔断器恢复
 *
 * 覆盖场景：
 * - C-14: DeepSeek API 网络抖动 → 重试后成功
 * - C-15: 熔断器开启 → 半开探测 → 恢复关闭
 *
 * 对应文档：docs/开发文档-综合版.md 第 12.4 节、第 10 章 DeepSeek 客户端
 */
import axios from 'axios';
import { DeepSeekClient } from '@/deepseek/DeepSeekClient';
import { MetricsCollector } from '@/monitor/MetricsCollector';
import { createTestConfig } from '../unit/helpers/testConfig';

jest.mock('axios');

function makeMockDb() {
  return {
    prepare: jest.fn().mockReturnValue({
      run: jest.fn(),
      all: jest.fn().mockReturnValue([]),
      get: jest.fn().mockReturnValue(undefined),
    }),
  };
}

function makeSuccessResponse(content: string) {
  return {
    data: {
      choices: [
        {
          message: { content },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
      },
    },
  };
}

describe('Chaos: 网络抖动与熔断器恢复', () => {
  let metrics: MetricsCollector;
  let db: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    db = makeMockDb();
    const config = createTestConfig();
    metrics = new MetricsCollector(config, db as any);
    (axios.create as jest.Mock).mockReturnValue({
      post: jest.fn(),
      interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
    });
  });

  describe('C-14: 网络抖动重试后成功', () => {
    it('前两次超时，第三次成功 → 返回正常回复', async () => {
      const config = createTestConfig({
        deepseek: {
          ...createTestConfig().deepseek,
          retry_count: 3,
          retry_interval_ms: 1,
          timeout_ms: 100,
          fallback_response: 'fallback',
        },
      });

      const postFn = jest.fn();
      postFn
        .mockRejectedValueOnce(new Error('timeout'))
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce(makeSuccessResponse('重试成功回复'));

      (axios.create as jest.Mock).mockReturnValue({
        post: postFn,
        interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
      });

      const client = new DeepSeekClient(config, 'sk-test', metrics);
      const response = await client.chat({
        shopId: 'shop-c14',
        sessionId: 'sess-1',
        messages: [{ role: 'user', content: '你好' }],
      });

      expect(response.content).toBe('重试成功回复');
      expect(response.model).not.toBe('fallback');
      expect(postFn).toHaveBeenCalledTimes(3);
    });

    it('全部重试失败后返回 fallback_response', async () => {
      const config = createTestConfig({
        deepseek: {
          ...createTestConfig().deepseek,
          retry_count: 2,
          retry_interval_ms: 1,
          timeout_ms: 100,
          fallback_response: '服务暂时不可用',
        },
      });

      const postFn = jest.fn().mockRejectedValue(new Error('connection refused'));
      (axios.create as jest.Mock).mockReturnValue({
        post: postFn,
        interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
      });

      const client = new DeepSeekClient(config, 'sk-test', metrics);
      const response = await client.chat({
        shopId: 'shop-c14b',
        sessionId: 'sess-1',
        messages: [{ role: 'user', content: '你好' }],
      });

      expect(response.content).toBe('服务暂时不可用');
      expect(response.model).toBe('fallback');
    });
  });

  describe('C-15: 熔断器开启 → 半开探测 → 恢复关闭', () => {
    it('连续 5 次失败后熔断器开启，返回 fallback', async () => {
      const config = createTestConfig({
        deepseek: {
          ...createTestConfig().deepseek,
          retry_count: 0,
          retry_interval_ms: 1,
          timeout_ms: 100,
          fallback_response: 'circuit-fallback',
        },
      });

      const postFn = jest.fn().mockRejectedValue(new Error('500'));
      (axios.create as jest.Mock).mockReturnValue({
        post: postFn,
        interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
      });

      const client = new DeepSeekClient(config, 'sk-test', metrics);

      // 触发 5 次失败
      for (let i = 0; i < 5; i++) {
        await client.chat({
          shopId: 'shop-c15',
          sessionId: 'sess-1',
          messages: [{ role: 'user', content: '你好' }],
        });
      }

      const circuit = client.getCircuitState();
      expect(circuit.state).toBe('open');
      expect(circuit.consecutiveFailures).toBeGreaterThanOrEqual(5);
    });

    it('熔断器开启后直接返回 fallback，不调用 API', async () => {
      const config = createTestConfig({
        deepseek: {
          ...createTestConfig().deepseek,
          retry_count: 0,
          retry_interval_ms: 1,
          timeout_ms: 100,
          fallback_response: 'circuit-open-fallback',
        },
      });

      const postFn = jest.fn().mockRejectedValue(new Error('500'));
      (axios.create as jest.Mock).mockReturnValue({
        post: postFn,
        interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
      });

      const client = new DeepSeekClient(config, 'sk-test', metrics);

      // 开启熔断器
      for (let i = 0; i < 5; i++) {
        await client.chat({
          shopId: 'shop-c15b',
          sessionId: 'sess-1',
          messages: [{ role: 'user', content: '你好' }],
        });
      }

      const callCountBefore = postFn.mock.calls.length;

      // 熔断器开启状态下调用，不应访问 API
      const response = await client.chat({
        shopId: 'shop-c15b',
        sessionId: 'sess-1',
        messages: [{ role: 'user', content: '再问一次' }],
      });

      expect(response.content).toBe('circuit-open-fallback');
      expect(response.model).toBe('circuit-open');
      expect(postFn.mock.calls.length).toBe(callCountBefore);
    });

    it('熔断器半开状态下探测成功 → 恢复关闭', async () => {
      const config = createTestConfig({
        deepseek: {
          ...createTestConfig().deepseek,
          retry_count: 0,
          retry_interval_ms: 1,
          timeout_ms: 100,
          fallback_response: 'half-open-fallback',
        },
      });

      const postFn = jest.fn();
      (axios.create as jest.Mock).mockReturnValue({
        post: postFn,
        interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
      });

      const client = new DeepSeekClient(config, 'sk-test', metrics);

      // 开启熔断器
      postFn.mockRejectedValue(new Error('500'));
      for (let i = 0; i < 5; i++) {
        await client.chat({
          shopId: 'shop-c15c',
          sessionId: 'sess-1',
          messages: [{ role: 'user', content: '你好' }],
        });
      }

      expect(client.getCircuitState().state).toBe('open');

      // 模拟时间流逝超过 circuitResetMs (60000ms)
      jest.useFakeTimers();
      jest.setSystemTime(Date.now() + 61000);

      // 恢复 API 响应
      postFn.mockResolvedValue(makeSuccessResponse('服务已恢复'));

      const response = await client.chat({
        shopId: 'shop-c15c',
        sessionId: 'sess-1',
        messages: [{ role: 'user', content: '你好' }],
      });

      expect(response.content).toBe('服务已恢复');
      expect(client.getCircuitState().state).toBe('closed');

      jest.useRealTimers();
    });
  });
});
