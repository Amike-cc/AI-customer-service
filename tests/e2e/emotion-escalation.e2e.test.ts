/**
 * E2E 测试：情绪升级场景
 *
 * 覆盖场景：E-13
 * 验证完整业务流程：买家情绪从 neutral 逐步升级到 angry → 触发不同处理策略
 *
 * 对应文档：docs/开发文档-综合版.md 第 12.5 节、第 9.8 节情绪识别
 */
import { EmotionDetector } from '@/intent/EmotionDetector';
import type { ChatMessage } from '@/deepseek/DeepSeekClient';

describe('E2E: 情绪升级', () => {
  let detector: EmotionDetector;

  beforeEach(() => {
    detector = new EmotionDetector();
  });

  it('E-13: 买家情绪从 neutral 逐步升级到 angry', async () => {
    const history: ChatMessage[] = [];

    // 第 1 轮：neutral
    const msg1 = '你好，我想咨询一下';
    history.push({ role: 'user', content: msg1 });
    let emotion = await detector.detect(msg1, []);
    expect(emotion).toBe('neutral');

    // 第 2 轮：slightly_upset
    history.push({ role: 'assistant', content: '亲，请问有什么可以帮您？' });
    const msg2 = '怎么还没回复？';
    history.push({ role: 'user', content: msg2 });
    emotion = await detector.detect(msg2, history.slice(0, 2));
    expect(['slightly_upset', 'anxious', 'neutral']).toContain(emotion);

    // 第 3 轮：anxious
    history.push({ role: 'assistant', content: '正在为您查询，请稍等' });
    const msg3 = '很急，麻烦快一点，什么时候能到？';
    history.push({ role: 'user', content: msg3 });
    emotion = await detector.detect(msg3, history.slice(0, 4));
    expect(['anxious', 'angry']).toContain(emotion);

    // 第 4 轮：angry
    history.push({ role: 'assistant', content: '已为您加急处理' });
    const msg4 = '气死我了，你们这是什么效率，骗子！';
    history.push({ role: 'user', content: msg4 });
    emotion = await detector.detect(msg4, history.slice(0, 6));
    expect(emotion).toBe('angry');
  });

  it('E-13b: 历史情绪影响当前检测（取最高等级）', async () => {
    const history: ChatMessage[] = [
      { role: 'user', content: '气死了，什么破服务' },
      { role: 'assistant', content: '非常抱歉给您带来不便' },
    ];

    // 当前消息 neutral，但历史有 angry → 取最高等级 angry
    const emotion = await detector.detect('好的，那我等等', history);
    expect(emotion).toBe('angry');
  });

  it('E-13c: 焦虑情绪检测（紧迫词 + 问号）', async () => {
    const emotion = await detector.detect('很急！我的快递什么时候到？', []);
    expect(emotion).toBe('anxious');
  });

  it('E-13d: 轻度不满情绪检测', async () => {
    const emotion = await detector.detect('怎么又发错了？', []);
    expect(['slightly_upset', 'anxious', 'angry']).toContain(emotion);
  });
});
