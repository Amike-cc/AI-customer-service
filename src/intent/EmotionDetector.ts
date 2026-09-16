/**
 * 情绪检测器
 * 实现 4 级情绪检测：neutral / slightly_upset / anxious / angry
 * 优先级：angry > anxious > slightly_upset > neutral
 * 历史上下文：取最近 3 条 user 消息与当前文本的最高情绪等级
 * 详见 src/intent/types.ts
 */
import type { EmotionLevel } from './types';
import type { ChatMessage } from '../deepseek/DeepSeekClient';

/** 愤怒关键词（最高优先级） */
const ANGRY_KEYWORDS = [
  '气死', '骗子', '投诉', '差评', '举报', '太差',
  '垃圾', '恶心', '欺骗', '假货', '坑人', '什么破',
];

/** 焦虑触发词（双字及以上，避免"快/急"单字命中"快点回复我""比较着急"等误判） */
const ANXIOUS_KEYWORDS = [
  '着急', '很急', '急切', '急需', '快点', '尽快', '赶快', '加快',
  '马上', '来不及', '等很久', '什么时候', '多久', '几天',
];

/** 紧迫词（焦虑判定的强信号，无需问号即可触发） */
const URGENT_KEYWORDS = ['着急', '很急', '急切', '急需', '快点', '尽快', '赶快', '马上', '来不及', '等很久'];

/** 轻度不满关键词 */
const SLIGHTLY_UPSET_KEYWORDS = [
  '怎么这样', '什么意思', '不是吧', '麻烦',
];

/**
 * 泛化不满词（单字/两字，正常咨询中也常出现）：
 * "怎么洗这个杯子""又便宜了""还有货吗" 均非不满，需多个信号或较长文本才判定
 */
const GENERAL_UPSET_KEYWORDS = ['怎么', '又', '还'];

/** 情绪等级排序，数值越大优先级越高 */
const EMOTION_RANK: Record<EmotionLevel, number> = {
  neutral: 0,
  slightly_upset: 1,
  anxious: 2,
  angry: 3,
};

/** 取两个情绪等级中较高者 */
function higherEmotion(a: EmotionLevel, b: EmotionLevel): EmotionLevel {
  return EMOTION_RANK[a] >= EMOTION_RANK[b] ? a : b;
}

export interface IEmotionDetector {
  /**
   * 检测文本与历史上下文的情绪等级
   * 返回 Promise<EmotionLevel>（LLM 检测可能异步）
   * shopId 可选：LLM 实现用于成本/预算归属记账
   */
  detect(text: string, history: ChatMessage[], shopId?: string): Promise<EmotionLevel>;
}

export class EmotionDetector implements IEmotionDetector {
  /**
   * 检测当前文本与最近 3 条 user 历史消息的情绪等级
   * 返回当前文本与历史上下文中的最高情绪等级
   */
  async detect(text: string, history: ChatMessage[]): Promise<EmotionLevel> {
    const currentEmotion = this.detectSingle(text);

    const recentUserMessages = history
      .filter((m) => m.role === 'user')
      .slice(-3);

    let historyEmotion: EmotionLevel = 'neutral';
    for (const msg of recentUserMessages) {
      historyEmotion = higherEmotion(historyEmotion, this.detectSingle(msg.content));
    }

    return higherEmotion(currentEmotion, historyEmotion);
  }

  /**
   * 单条文本情绪检测
   * 优先级：angry > anxious > slightly_upset > neutral
   */
  private detectSingle(text: string): EmotionLevel {
    // 1. angry 检测（最高优先级）
    if (ANGRY_KEYWORDS.some((kw) => text.includes(kw))) {
      return 'angry';
    }

    // 2. anxious 检测：需命中焦虑词，且包含问号或紧迫词
    if (ANXIOUS_KEYWORDS.some((kw) => text.includes(kw))) {
      const hasQuestionMark = text.includes('?') || text.includes('？');
      const hasUrgent = URGENT_KEYWORDS.some((kw) => text.includes(kw));
      if (hasQuestionMark || hasUrgent) {
        return 'anxious';
      }
    }

    // 3. slightly_upset 检测
    // 特定词组直接命中；泛化词（怎么/又/还）需要 ≥2 个同时出现或较长文本，
    // 避免"怎么洗这个杯子"等正常咨询被误判为不满
    if (SLIGHTLY_UPSET_KEYWORDS.some((kw) => text.includes(kw))) {
      return 'slightly_upset';
    }
    const generalHits = GENERAL_UPSET_KEYWORDS.filter((kw) => text.includes(kw)).length;
    if (generalHits >= 2 || (generalHits >= 1 && text.trim().length >= 10)) {
      return 'slightly_upset';
    }

    // 4. neutral 默认
    return 'neutral';
  }
}
