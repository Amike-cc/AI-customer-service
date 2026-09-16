/**
 * EmotionDetector 单元测试
 * 详见 src/intent/EmotionDetector.ts
 */
import { EmotionDetector } from '@/intent/EmotionDetector';
import type { ChatMessage } from '@/deepseek/DeepSeekClient';

describe('EmotionDetector', () => {
  let detector: EmotionDetector;

  beforeEach(() => {
    detector = new EmotionDetector();
  });

  it('angry 检测 — 命中"投诉"', async () => {
    expect(await detector.detect('我要投诉', [])).toBe('angry');
  });

  it('anxious 检测 — 命中"什么时候"且含问号', async () => {
    expect(await detector.detect('什么时候发货？', [])).toBe('anxious');
  });

  it('slightly_upset 检测 — 命中"怎么这样"', async () => {
    expect(await detector.detect('怎么这样啊', [])).toBe('slightly_upset');
  });

  it('neutral 检测 — 无情绪词', async () => {
    expect(await detector.detect('你好', [])).toBe('neutral');
  });

  it('优先级测试 — angry 优先于 slightly_upset', async () => {
    // 同时命中 angry("气死") 与 slightly_upset("怎么这样")，应返回 angry
    expect(await detector.detect('气死我了，怎么这样', [])).toBe('angry');
  });

  it('历史上下文情绪升级 — 当前 neutral，历史 angry', async () => {
    const history: ChatMessage[] = [
      { role: 'user', content: '我要投诉' },
      { role: 'assistant', content: '非常抱歉给您带来困扰' },
    ];
    expect(await detector.detect('好的', history)).toBe('angry');
  });

  it('无情绪历史不影响 — 当前 angry，历史 neutral', async () => {
    const history: ChatMessage[] = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '有什么可以帮您' },
    ];
    expect(await detector.detect('我要投诉', history)).toBe('angry');
  });

  it('anxious 需要问号或紧迫词 — 仅"什么时候"不触发', async () => {
    // 命中焦虑词"什么时候"但无问号、无紧迫词，应返回 neutral
    expect(await detector.detect('什么时候发货', [])).toBe('neutral');
  });
});
