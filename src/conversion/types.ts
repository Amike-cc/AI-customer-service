import type { IntentResult } from '../intent/types';

export type PurchaseSignal =
  | 'buying_intent'
  | 'hesitation'
  | 'discount_seeking'
  | 'price_inquiry'
  | 'stock_check'
  | 'spec_comparison';

export type PurchaseStage = 'awareness' | 'consideration' | 'decision' | 'retention';

export interface PurchaseIntentResult {
  hasIntent: boolean;
  signals: PurchaseSignal[];
  confidence: number;
  stage: PurchaseStage;
}

export type RecommendationStrategy =
  | 'cross_sell'
  | 'up_sell'
  | 'complementary'
  | 'alternative';

export interface Recommendation {
  productId: string;
  productName: string;
  reason: string;
  score: number;
  strategy: RecommendationStrategy;
  spec?: string;
  price?: number;
}

export interface PurchaseIntentDetectorOptions {
  text: string;
  intent: IntentResult | null;
  history: Array<{ role: string; content: string }>;
}
