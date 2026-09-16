import type { Config } from '../config/schema';
import type { AppLogger } from '../logging/logger';
import type { ChatMessage } from '../deepseek/DeepSeekClient';
import type { IntentCategory, IntentResult, IntentEntity } from './types';

interface CategoryKeywords {
  positive: Array<{ word: string; weight: number }>;
  negative: string[];
}

const CATEGORY_KEYWORDS: Record<IntentCategory, CategoryKeywords> = {
  greeting: {
    positive: [
      { word: '你好', weight: 3 }, { word: '您好', weight: 3 },
      { word: 'hi', weight: 3 }, { word: 'hello', weight: 3 },
      { word: '在吗', weight: 2 }, { word: '有人吗', weight: 2 },
      { word: '哈喽', weight: 3 }, { word: '嗨', weight: 2 },
    ],
    negative: ['退款', '退货', '物流', '价格'],
  },
  product_inquiry: {
    positive: [
      { word: '尺码', weight: 2 }, { word: '尺寸', weight: 2 },
      { word: '材质', weight: 2 }, { word: '面料', weight: 2 },
      { word: '颜色', weight: 2 }, { word: '规格', weight: 2 },
      { word: '参数', weight: 2 }, { word: '详情', weight: 1 },
      { word: '什么样', weight: 2 }, { word: '图片', weight: 1 },
    ],
    negative: ['退货', '退款', '投诉', '人工'],
  },
  purchase_intent: {
    positive: [
      { word: '下单', weight: 3 }, { word: '买', weight: 2 },
      { word: '要了', weight: 3 }, { word: '拍了', weight: 3 },
      { word: '付款', weight: 3 }, { word: '结算', weight: 2 },
      { word: '加入购物车', weight: 3 },
    ],
    negative: ['退货', '退款', '投诉'],
  },
  after_sales: {
    positive: [
      { word: '退货', weight: 3 }, { word: '退款', weight: 3 },
      { word: '换货', weight: 3 }, { word: '售后', weight: 2 },
      { word: '维修', weight: 2 }, { word: '保修', weight: 2 },
      { word: '质量问题', weight: 3 }, { word: '坏了', weight: 2 },
      { word: '破损', weight: 2 }, { word: '发错', weight: 3 },
    ],
    negative: [],
  },
  logistics: {
    positive: [
      { word: '物流', weight: 3 }, { word: '快递', weight: 3 },
      { word: '发货', weight: 3 }, { word: '到货', weight: 2 },
      { word: '运单', weight: 3 }, { word: '揽收', weight: 2 },
      { word: '派送', weight: 2 }, { word: '签收', weight: 2 },
      { word: '什么时候到', weight: 2 }, { word: '几天到', weight: 2 },
    ],
    negative: [],
  },
  complaint: {
    positive: [
      { word: '投诉', weight: 3 }, { word: '差评', weight: 3 },
      { word: '举报', weight: 3 }, { word: '骗子', weight: 3 },
      { word: '垃圾', weight: 2 }, { word: '气死', weight: 3 },
      { word: '太差了', weight: 2 }, { word: '不满', weight: 2 },
      { word: '欺骗', weight: 3 }, { word: '假货', weight: 3 },
    ],
    negative: [],
  },
  human_request: {
    positive: [
      { word: '人工', weight: 3 }, { word: '真人', weight: 3 },
      { word: '客服', weight: 2 },
      { word: '找人工', weight: 3 }, { word: '人工客服', weight: 3 },
      { word: '不是机器人', weight: 2 },
    ],
    negative: [],
  },
  faq: {
    positive: [
      { word: '怎么', weight: 1 }, { word: '如何', weight: 1 },
      { word: '能不能', weight: 1 }, { word: '可以吗', weight: 1 },
      { word: '支持', weight: 1 }, { word: '有没有', weight: 1 },
    ],
    negative: ['投诉', '退货', '退款'],
  },
  chitchat: {
    positive: [
      { word: '谢谢', weight: 3 }, { word: '感谢', weight: 3 },
      { word: '好的', weight: 2 }, { word: '知道了', weight: 2 },
      { word: 'ok', weight: 2 }, { word: '拜拜', weight: 2 },
    ],
    negative: [],
  },
  unknown: {
    positive: [],
    negative: [],
  },
};

const SENTENCE_PATTERNS: Array<{ pattern: RegExp; category: IntentCategory; weight: number }> = [
  { pattern: /(\d+元|多少钱|价格|价位)/, category: 'product_inquiry', weight: 2 },
  { pattern: /(退.*货|退货.*怎么)/, category: 'after_sales', weight: 3 },
  { pattern: /(退款.*怎么|怎么.*退款)/, category: 'after_sales', weight: 3 },
  { pattern: /(什么时候.*发货|几天.*到)/, category: 'logistics', weight: 3 },
  { pattern: /(下单|买了|要了|拍了)/, category: 'purchase_intent', weight: 3 },
  { pattern: /(便宜|优惠|券|满减|折扣)/, category: 'purchase_intent', weight: 2 },
  { pattern: /(有货吗|库存|断货)/, category: 'product_inquiry', weight: 2 },
  { pattern: /(人工|真人)/, category: 'human_request', weight: 3 },
  { pattern: /(投诉|差评|举报)/, category: 'complaint', weight: 3 },
  { pattern: /(尺码|尺寸|多大)/, category: 'product_inquiry', weight: 2 },
  { pattern: /(你好|您好|hi|hello)/i, category: 'greeting', weight: 3 },
  { pattern: /(谢谢|感谢|辛苦)/, category: 'chitchat', weight: 3 },
];

export class IntentClassifier {
  constructor(private config: Config, private logger: AppLogger) {}

  classify(text: string, history: ChatMessage[]): IntentResult {
    const lowerText = text.toLowerCase();
    const scores = new Map<IntentCategory, number>();
    const entities: IntentEntity[] = [];

    for (const [category, kwConfig] of Object.entries(CATEGORY_KEYWORDS)) {
      let score = 0;
      for (const { word, weight } of kwConfig.positive) {
        if (lowerText.includes(word.toLowerCase())) {
          score += weight;
        }
      }
      for (const negWord of kwConfig.negative) {
        if (lowerText.includes(negWord.toLowerCase())) {
          score *= 0.3;
          break;
        }
      }
      if (score > 0) {
        scores.set(category as IntentCategory, score);
      }
    }

    for (const { pattern, category, weight } of SENTENCE_PATTERNS) {
      if (pattern.test(text)) {
        scores.set(category, (scores.get(category) ?? 0) + weight);
      }
    }

    if (this.config.intent.history_weight > 0 && history.length > 0) {
      const recentHistory = history.slice(-3);
      const historyCategory = this.inferHistoryCategory(recentHistory);
      if (historyCategory) {
        const hw = this.config.intent.history_weight * 2;
        scores.set(historyCategory, (scores.get(historyCategory) ?? 0) + hw);
      }
    }

    const priceMatch = text.match(/(\d+)元/);
    if (priceMatch) {
      entities.push({ type: 'price', value: priceMatch[1] + '元' });
    }
    const orderMatch = text.match(/(\d{15,})/);
    if (orderMatch) {
      entities.push({ type: 'order_id', value: orderMatch[1] });
    }

    const sorted = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0 || sorted[0][1] === 0) {
      return { category: 'unknown', confidence: 0, entities: [] };
    }

    const [category, score] = sorted[0];
    // 平滑置信度：仅命中单类时 score/totalScore=1.0 过度自信，
    // 改用 score/(score+K) 压低单一命中的置信度
    const K = 1;
    const confidence = Math.min(score / (score + K), 1.0);

    return { category, confidence, entities };
  }

  private inferHistoryCategory(history: ChatMessage[]): IntentCategory | null {
    const userMessages = history.filter((m) => m.role === 'user').slice(-1);
    if (userMessages.length === 0) return null;
    const lastUserMsg = userMessages[0].content.toLowerCase();
    for (const [category, kwConfig] of Object.entries(CATEGORY_KEYWORDS)) {
      for (const { word } of kwConfig.positive) {
        if (lastUserMsg.includes(word.toLowerCase())) {
          return category as IntentCategory;
        }
      }
    }
    return null;
  }
}
