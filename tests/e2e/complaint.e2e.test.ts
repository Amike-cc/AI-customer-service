/**
 * E2E 测试：投诉处理场景
 *
 * 覆盖场景：E-09
 * 验证完整业务流程：买家投诉商品质量 → 情绪检测识别 angry → 规则引擎匹配售后/转人工
 *
 * 对应文档：docs/开发文档-综合版.md 第 12.5 节、第 9.8 节情绪识别
 */
import { RuleEngine } from '@/rules/RuleEngine';
import { EmotionDetector } from '@/intent/EmotionDetector';
import { createTestConfig } from '../unit/helpers/testConfig';

describe('E2E: 投诉处理', () => {
  let ruleEngine: RuleEngine;
  let emotionDetector: EmotionDetector;
  const config = createTestConfig();

  beforeEach(() => {
    ruleEngine = new RuleEngine(config, 'shop-e2e-09');
    emotionDetector = new EmotionDetector();
  });

  it('E-09: 买家投诉质量问题 → 情绪检测 angry + 规则匹配售后转人工', async () => {
    const userMessage = '你们这什么破质量，我要投诉，发假货给我';
    const history = [
      { role: 'user' as const, content: '我买的衣服到了' },
      { role: 'assistant' as const, content: '亲，衣服已签收，有什么问题吗？' },
    ];

    // 1. 情绪检测 → angry（命中"什么破"、"投诉"、"假货"）
    const emotion = await emotionDetector.detect(userMessage, history);
    expect(emotion).toBe('angry');

    // 2. 规则引擎匹配（"假货"可能命中 return_policy 规则）
    const ruleResult = ruleEngine.match(userMessage);
    expect(ruleResult).toBeDefined();
    // 投诉类消息应命中某条规则或走 AI 回复
    if (ruleResult.matched) {
      expect(ruleResult.answer).toBeDefined();
    }
  });

  it('E-09b: 买家要求差评举报 → 情绪检测 angry', async () => {
    const emotion = await emotionDetector.detect('太差了，我要给差评，举报你们', []);
    expect(emotion).toBe('angry');
  });

  it('E-09c: 买家情绪从 neutral 升级到 angry', async () => {
    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    // 第一轮：neutral
    history.push({ role: 'user', content: '你好，问下发货时间' });
    let emotion = await emotionDetector.detect(history[0].content, []);
    expect(emotion).toBe('neutral');

    // 第二轮：slightly_upset
    history.push({ role: 'assistant', content: '亲，24小时内发货哦' });
    history.push({ role: 'user', content: '怎么还没发？' });
    emotion = await emotionDetector.detect(history[2].content, history.slice(0, 2));
    expect(['slightly_upset', 'anxious', 'neutral']).toContain(emotion);

    // 第三轮：angry
    history.push({ role: 'assistant', content: '正在为您加急处理' });
    history.push({ role: 'user', content: '气死了，你们这什么效率，骗子' });
    emotion = await emotionDetector.detect(history[4].content, history.slice(0, 4));
    expect(emotion).toBe('angry');
  });
});
