/**
 * DeepSeekClient 单元测试
 */
import axios from 'axios';
import { DeepSeekClient } from '@/deepseek/DeepSeekClient';
import { createTestConfig } from '../helpers/testConfig';

jest.mock('axios', () => {
  const mockAxios = {
    create: jest.fn().mockImplementation(() => ({
      post: jest.fn(),
    })),
    isAxiosError: jest.fn().mockReturnValue(true),
  };
  return { ...mockAxios, default: mockAxios };
});

describe('DeepSeekClient', () => {
  let client: DeepSeekClient;
  let http: { post: jest.Mock };
  let metrics: { inc: jest.Mock; observe: jest.Mock };
  const config = createTestConfig();

  function createClient() {
    metrics = { inc: jest.fn(), observe: jest.fn() };
    client = new DeepSeekClient(config, 'test-api-key', metrics as any);
    const instances = (axios.create as jest.Mock).mock.results;
    http = instances[instances.length - 1]?.value as { post: jest.Mock };
  }

  beforeEach(() => {
    (axios.create as jest.Mock).mockClear();
    createClient();
  });

  function mockSuccess(content = '你好，有什么可以帮您？', usage = { prompt_tokens: 50, completion_tokens: 30 }) {
    http.post.mockResolvedValueOnce({
      data: {
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage,
      },
    });
  }

  function mockTruncated(content = '截断内容', usage = { prompt_tokens: 50, completion_tokens: 30 }) {
    http.post.mockResolvedValueOnce({
      data: {
        choices: [{ message: { content }, finish_reason: 'length' }],
        usage,
      },
    });
  }

  function mockError(status: number, code?: string) {
    const err = new Error('Axios error') as any;
    err.response = { status };
    err.code = code;
    http.post.mockRejectedValueOnce(err);
  }

  describe('正常 chat', () => {
    it('返回完整 ChatResponse', async () => {
      mockSuccess('你好，有什么可以帮您？');
      const resp = await client.chat({
        shopId: 'shop1',
        sessionId: 'sess1',
        messages: [{ role: 'user', content: '你好' }],
      });
      expect(resp.content).toBe('你好，有什么可以帮您？');
      expect(resp.tokenInput).toBe(50);
      expect(resp.tokenOutput).toBe(30);
      expect(resp.truncated).toBe(false);
      expect(resp.finishReason).toBe('stop');
    });

    it('记录 token 消费指标', async () => {
      mockSuccess();
      await client.chat({
        shopId: 'shop1',
        sessionId: 'sess1',
        messages: [{ role: 'user', content: '你好' }],
      });
      expect(metrics.inc).toHaveBeenCalledWith('token_consumed_total', 50, expect.anything(), 'shop1');
      expect(metrics.inc).toHaveBeenCalledWith('token_consumed_total', 30, expect.anything(), 'shop1');
      expect(metrics.observe).toHaveBeenCalledWith('api_latency_ms', expect.any(Number), undefined, 'shop1');
    });
  });

  describe('熔断器', () => {
    it('连续失败达到阈值后打开熔断器', async () => {
      // Each call fails twice (retry_count=1), so consecutiveFailures += 2 per call
      // After 3 calls: consecutiveFailures = 6 >= 5, circuit opens during call 3
      for (let i = 0; i < 3; i++) {
        mockError(500);
        await client.chat({
          shopId: 'shop1', sessionId: 'sess1',
          messages: [{ role: 'user', content: 'hi' }],
        });
      }
      // 第 4 次调用被熔断
      const resp = await client.chat({
        shopId: 'shop1', sessionId: 'sess1',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(resp.model).toBe('circuit-open');
      expect(resp.content).toBe(config.deepseek.fallback_response);
    });
  });

  describe('错误处理', () => {
    it('未配置 API Key 时立即返回 fallback 且不发起网络请求', async () => {
      client = new DeepSeekClient(config, '', metrics as any);
      const instances = (axios.create as jest.Mock).mock.results;
      http = instances[instances.length - 1]?.value as { post: jest.Mock };

      const resp = await client.chat({
        shopId: 'shop1', sessionId: 'sess1',
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(resp.model).toBe('fallback');
      expect(resp.content).toBe(config.deepseek.fallback_response);
      expect(http.post).not.toHaveBeenCalled();
      expect(metrics.inc).toHaveBeenCalledWith(
        'api_call_total', 1, { status: 'auth_failed' }, 'shop1',
      );
    });

    it('401 认证失败返回 fallback 不重试', async () => {
      mockError(401);
      const resp = await client.chat({
        shopId: 'shop1', sessionId: 'sess1',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(resp.content).toBe(config.deepseek.fallback_response);
      // 401 不重试，只调用 1 次
      expect(http.post).toHaveBeenCalledTimes(1);
    });

    it('402 余额不足返回 fallback 不重试', async () => {
      mockError(402);
      const resp = await client.chat({
        shopId: 'shop1', sessionId: 'sess1',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(resp.content).toBe(config.deepseek.fallback_response);
      expect(http.post).toHaveBeenCalledTimes(1);
    });

    it('超时错误重试', async () => {
      mockError(500, 'ECONNABORTED');
      mockSuccess();
      const resp = await client.chat({
        shopId: 'shop1', sessionId: 'sess1',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(resp.content).toBe('你好，有什么可以帮您？');
      expect(http.post).toHaveBeenCalledTimes(2);
    });

    it('所有重试耗尽后返回 fallback', async () => {
      const totalCalls = config.deepseek.retry_count + 1;
      for (let i = 0; i < totalCalls + 1; i++) {
        mockError(500);
      }
      const resp = await client.chat({
        shopId: 'shop1', sessionId: 'sess1',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(resp.content).toBe(config.deepseek.fallback_response);
    });
  });

  describe('chatWithContinuation', () => {
    it('正常回复不续写', async () => {
      mockSuccess('完整的回复');
      const resp = await client.chatWithContinuation({
        shopId: 'shop1', sessionId: 'sess1',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(resp.content).toBe('完整的回复');
      expect(http.post).toHaveBeenCalledTimes(1);
    });

    it('截断回复触发续写', async () => {
      mockTruncated('前半部分的内容');
      mockSuccess('后半部分的内容');
      const resp = await client.chatWithContinuation({
        shopId: 'shop1', sessionId: 'sess1',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(resp.content).toContain('前半部分');
      expect(resp.content).toContain('后半部分');
      expect(http.post).toHaveBeenCalledTimes(2);
    });
  });

  describe('合并逻辑', () => {
    it('有重叠部分时去重', async () => {
      mockTruncated('ABCDEF');
      mockSuccess('DEFGHI');
      const resp = await client.chatWithContinuation({
        shopId: 'shop1', sessionId: 'sess1',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(resp.content).toBe('ABCDEFGHI');
    });
  });

  describe('updateApiKey', () => {
    it('重建 HTTP 客户端', () => {
      (axios.create as jest.Mock).mockClear();
      client.updateApiKey('new-key');
      expect(axios.create).toHaveBeenCalled();
      const callArgs = (axios.create as jest.Mock).mock.calls[0][0];
      expect(callArgs.headers.Authorization).toBe('Bearer new-key');
    });
  });

  describe('updateConfig', () => {
    it('重建 HTTP 客户端', () => {
      (axios.create as jest.Mock).mockClear();
      client.updateConfig(config);
      expect(axios.create).toHaveBeenCalled();
    });
  });

  describe('错误事件去重', () => {
    it('30s 内同类型错误只 emit 一次', async () => {
      const spy = jest.fn();
      client.on('chatError', spy);

      mockError(401);
      await client.chat({ shopId: 'shop1', sessionId: 'sess1', messages: [{ role: 'user', content: 'hi' }] });

      mockError(401);
      await client.chat({ shopId: 'shop1', sessionId: 'sess1', messages: [{ role: 'user', content: 'hi2' }] });

      expect(spy).toHaveBeenCalledTimes(1);
    });
  });
});
