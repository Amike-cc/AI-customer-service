import type { IntentResult } from '../intent/types';
import type { PurchaseIntentResult, PurchaseSignal, PurchaseStage } from './types';

const BUYING_KEYWORDS = ['下单', '买', '要了', '拍了', '付款', '结算', '加购', '下单了'];
const HESITATION_KEYWORDS = ['再看看', '考虑', '太贵', '对比', '犹豫', '算了', '下次', '贵了'];
const DISCOUNT_KEYWORDS = ['便宜', '优惠', '券', '满减', '折扣', '活动', '促销', '减免', '优惠券'];
const STOCK_KEYWORDS = ['有货吗', '库存', '还能发吗', '断货', '现货', '有现', '发货吗'];
const COMPARISON_KEYWORDS = ['对比', '区别', '差异', '还是', '哪个好', '对比下'];

const PRICE_PATTERN = /(\d+元|多少钱|价格|价位)/;

export class PurchaseIntentDetector {
  detect(
    text: string,
    intent: IntentResult | null,
    history: Array<{ role: string; content: string }>,
  ): PurchaseIntentResult {
    const signals: PurchaseSignal[] = [];
    const lowerText = text.toLowerCase();

    if (BUYING_KEYWORDS.some((kw) => lowerText.includes(kw))) {
      signals.push('buying_intent');
    }
    if (HESITATION_KEYWORDS.some((kw) => lowerText.includes(kw))) {
      signals.push('hesitation');
    }
    if (DISCOUNT_KEYWORDS.some((kw) => lowerText.includes(kw))) {
      signals.push('discount_seeking');
    }
    if (PRICE_PATTERN.test(text)) {
      signals.push('price_inquiry');
    }
    if (STOCK_KEYWORDS.some((kw) => lowerText.includes(kw))) {
      signals.push('stock_check');
    }
    if (COMPARISON_KEYWORDS.some((kw) => lowerText.includes(kw))) {
      signals.push('spec_comparison');
    }

    const hasIntent =
      signals.length > 0 ||
      intent?.category === 'purchase_intent' ||
      intent?.category === 'product_inquiry';

    const stage = this.inferStage(text, signals, history, intent);
    const confidence = Math.min(signals.length / 3, 1.0);

    return {
      hasIntent,
      signals: Array.from(new Set(signals)),
      confidence,
      stage,
    };
  }

  private inferStage(
    text: string,
    signals: PurchaseSignal[],
    history: Array<{ role: string; content: string }>,
    intent: IntentResult | null,
  ): PurchaseStage {
    if (intent?.category === 'after_sales') {
      return 'retention';
    }
    if (signals.includes('buying_intent')) {
      return 'decision';
    }
    if (signals.includes('hesitation') || signals.includes('discount_seeking')) {
      return 'consideration';
    }
    const userMessageCount = history.filter((m) => m.role === 'user').length;
    if (userMessageCount <= 1) {
      return 'awareness';
    }
    if (signals.includes('price_inquiry') || signals.includes('stock_check')) {
      return 'consideration';
    }
    return userMessageCount > 3 ? 'consideration' : 'awareness';
  }
}
