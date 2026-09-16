/**
 * LlmIntentRecognizer 单元测试
 * 详见 src/intent/LlmIntentRecognizer.ts
 *
 * 注意：源码已从 DeepSeekClient.chat() 重构为 ModelGateway.route()，
 * 让 DeepSeek 故障时能 fallback 到 tier2/tier3 其他 provider。
 * 测试需 mock ModelGateway.route() 而非 DeepSeekClient.chat()。
 */
import { LlmIntentRecognizer } from '@/intent/LlmIntentRecognizer';
import { createTestConfig } from '../helpers/testConfig';
import type { GatewayRequest, GatewayResponse, ModelGateway } from '@/gateway/types';

function makeResponse(content: string): GatewayResponse {
  return {
    content,
    model: 'deepseek-test',
    tokenInput: 10,
    tokenOutput: 20,
    latencyMs: 100,
    cached: false,
    truncated: false,
    confidence: 0.8,
    provider: 'deepseek',
    costYuan: 0,
  };
}

describe('LlmIntentRecognizer', () => {
  let mockGateway: { route: jest.Mock };
  let recognizer: LlmIntentRecognizer;

  beforeEach(() => {
    mockGateway = { route: jest.fn() };
    recognizer = new LlmIntentRecognizer(
      mockGateway as unknown as ModelGateway,
      createTestConfig(),
    );
  });

  it('解析有效 JSON 返回增强意图', async () => {
    mockGateway.route.mockResolvedValueOnce(
      makeResponse(
        JSON.stringify({
          intent: 'product_inquiry',
          confidence: 0.92,
          entities: [{ type: 'size', value: 'XL' }],
          emotion: 'neutral',
        }),
      ),
    );

    const result = await recognizer.recognize('这个有什么尺码', []);

    expect(result.intent.category).toBe('product_inquiry');
    expect(result.intent.confidence).toBeCloseTo(0.92);
    expect(result.intent.entities).toEqual([{ type: 'size', value: 'XL' }]);
    expect(result.entities).toEqual([{ type: 'size', value: 'XL' }]);
    expect(result.emotion).toBe('neutral');

    expect(mockGateway.route).toHaveBeenCalledTimes(1);
    const callArg = mockGateway.route.mock.calls[0][0] as GatewayRequest;
    expect(callArg.shopId).toBe('intent-recognition');
    expect(callArg.sessionId).toBe('global');
    expect(callArg.messages).toHaveLength(2);
    expect(callArg.messages[0].role).toBe('system');
    expect(callArg.messages[1].role).toBe('user');
    // 轻量调用走 directRoute（cascade=false）避免级联放大延迟
    expect(callArg.cascade).toBe(false);
    expect(callArg.preferredTier).toBe('tier2');
  });

  it('非 JSON 返回时回退到 unknown', async () => {
    mockGateway.route.mockResolvedValueOnce(makeResponse('这不是 JSON 内容'));

    const result = await recognizer.recognize('你好', []);

    expect(result.intent.category).toBe('unknown');
    expect(result.intent.confidence).toBe(0);
    expect(result.intent.entities).toEqual([]);
    expect(result.entities).toEqual([]);
    expect(result.emotion).toBe('neutral');
  });

  it('API 超时/错误时回退到 unknown', async () => {
    mockGateway.route.mockRejectedValueOnce(new Error('timeout'));

    const result = await recognizer.recognize('你好', []);

    expect(result.intent.category).toBe('unknown');
    expect(result.intent.confidence).toBe(0);
    expect(result.intent.entities).toEqual([]);
    expect(result.entities).toEqual([]);
    expect(result.emotion).toBe('neutral');
  });

  it('缺少 emotion 字段时默认 neutral', async () => {
    mockGateway.route.mockResolvedValueOnce(
      makeResponse(
        JSON.stringify({
          intent: 'greeting',
          confidence: 0.8,
          entities: [],
        }),
      ),
    );

    const result = await recognizer.recognize('你好', []);

    expect(result.intent.category).toBe('greeting');
    expect(result.emotion).toBe('neutral');
  });

  it('缺少 entities 字段时默认空数组', async () => {
    mockGateway.route.mockResolvedValueOnce(
      makeResponse(
        JSON.stringify({
          intent: 'faq',
          confidence: 0.7,
          emotion: 'neutral',
        }),
      ),
    );

    const result = await recognizer.recognize('怎么使用', []);

    expect(result.intent.category).toBe('faq');
    expect(result.intent.entities).toEqual([]);
    expect(result.entities).toEqual([]);
  });

  it('无效意图类别时回退到 unknown', async () => {
    mockGateway.route.mockResolvedValueOnce(
      makeResponse(
        JSON.stringify({
          intent: 'invalid_category',
          confidence: 0.9,
          entities: [],
          emotion: 'neutral',
        }),
      ),
    );

    const result = await recognizer.recognize('你好', []);

    expect(result.intent.category).toBe('unknown');
  });

  it('置信度超过 1.0 时截断为 1.0', async () => {
    mockGateway.route.mockResolvedValueOnce(
      makeResponse(
        JSON.stringify({
          intent: 'greeting',
          confidence: 1.5,
          entities: [],
          emotion: 'neutral',
        }),
      ),
    );

    const result = await recognizer.recognize('你好', []);

    expect(result.intent.confidence).toBe(1);
  });

  it('置信度低于 0 时设为 0', async () => {
    mockGateway.route.mockResolvedValueOnce(
      makeResponse(
        JSON.stringify({
          intent: 'greeting',
          confidence: -0.3,
          entities: [],
          emotion: 'neutral',
        }),
      ),
    );

    const result = await recognizer.recognize('你好', []);

    expect(result.intent.confidence).toBe(0);
  });
});
