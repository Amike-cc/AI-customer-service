import type { Config } from '../config/schema';
import type { ChatMessage } from '../deepseek/DeepSeekClient';
import type { IntentResult, ComplexityResult, ComplexityLevel } from './types';

const EMOTIONAL_WORDS = ['气死', '垃圾', '骗子', '投诉', '差评', '举报', '太差', '不满', '欺骗', '假货', '恶心'];
const ORDER_PATTERNS = [/\d{15,}/, /订单/, /运单/, /\d+元/, /快递单/];

export class ComplexityAssessor {
  constructor(private config: Config) {}

  assess(
    text: string,
    intent: IntentResult,
    history: ChatMessage[],
    hasSessionEscalation: boolean = false,
  ): ComplexityResult {
    const reasons: string[] = [];
    let score = 0;

    const questionMarks = (text.match(/\?/g) ?? []).length + (text.match(/？/g) ?? []).length;
    const semicolons = (text.match(/[；;,，、]/g) ?? []).length;
    if (questionMarks >= 2 || semicolons >= 2) {
      score += 0.3;
      reasons.push('multi_question');
    }

    const hasEmotional = EMOTIONAL_WORDS.some((w) => text.includes(w));
    if (hasEmotional) {
      score += 0.25;
      reasons.push('emotional_frustration');
    }

    const hasOrderContext = ORDER_PATTERNS.some((p) => p.test(text));
    if (hasOrderContext) {
      score += 0.2;
      reasons.push('order_context');
    }

    if (hasSessionEscalation) {
      score += 0.3;
      reasons.push('repeated_escalation');
    }

    const recentAiMessages = history.filter((m) => m.role === 'assistant').slice(-1);
    if (recentAiMessages.length > 0) {
      // We can't directly know confidence from history text, but if the AI
      // previously responded with uncertainty markers, treat as low confidence
      const lastAiContent = recentAiMessages[0].content;
      if (lastAiContent.includes('不确定') || lastAiContent.includes('建议咨询') || lastAiContent.includes('人工')) {
        score += 0.2;
        reasons.push('low_confidence_history');
      }
    }

    score = Math.min(score, 1.0);

    const shouldEscalate =
      score >= this.config.intent.complexity_threshold || intent.category === 'complaint';

    let level: ComplexityLevel = 'simple';
    if (score >= 0.6) level = 'complex';
    else if (score >= 0.3) level = 'moderate';

    return { level, score, reasons, shouldEscalate };
  }
}
