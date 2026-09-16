import type { Config } from '../config/schema';
import type { ProductMatcher } from '../product/ProductMatcher';
import { PurchaseIntentDetector } from './PurchaseIntentDetector';
import { ProductRecommender } from './ProductRecommender';
import type { IntentResult } from '../intent/types';
import type { PurchaseIntentResult, Recommendation } from './types';

export class ConversionEngine {
  readonly detector: PurchaseIntentDetector;
  readonly recommender: ProductRecommender;

  constructor(config: Config, productMatcher: ProductMatcher) {
    this.detector = new PurchaseIntentDetector();
    this.recommender = new ProductRecommender(productMatcher, config);
  }

  detectIntent(
    text: string,
    intent: IntentResult | null,
    history: Array<{ role: string; content: string }>,
  ): PurchaseIntentResult {
    return this.detector.detect(text, intent, history);
  }

  recommend(
    text: string,
    currentProductId: string | undefined,
    purchaseIntent: PurchaseIntentResult,
    history: Array<{ role: string; content: string }>,
    shopId?: string,
    sessionId?: string,
  ): Recommendation[] {
    return this.recommender.recommend(
      text,
      currentProductId,
      purchaseIntent,
      history,
      shopId,
      sessionId,
    );
  }

}
