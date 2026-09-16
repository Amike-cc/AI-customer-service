import type { Config } from '../config/schema';
import type { ProductMatcher, Product } from '../product/ProductMatcher';
import type { Recommendation, RecommendationStrategy, PurchaseIntentResult } from './types';

export class ProductRecommender {
  private lastRecommendAt = new Map<string, number>();
  /** 最多保留的冷却记录数，超出按最旧删除（L-13 内存泄漏防护） */
  private readonly maxEntries = 1000;
  /** 超过此时长的冷却记录视为过期（24h），写入时清理 */
  private readonly staleMs = 24 * 60 * 60 * 1000;

  constructor(
    private productMatcher: ProductMatcher,
    private config: Config,
  ) {}

  recommend(
    text: string,
    currentProductId: string | undefined,
    purchaseIntent: PurchaseIntentResult,
    history: Array<{ role: string; content: string }>,
    shopId = 'global',
    sessionId = 'global',
  ): Recommendation[] {
    const cooldownMs = this.config.conversion.recommendation_cooldown_ms;
    const cooldownKey = `${shopId}:${sessionId}:${currentProductId ?? 'none'}`;
    const lastTime = this.lastRecommendAt.get(cooldownKey) ?? 0;
    if (Date.now() - lastTime < cooldownMs) {
      return [];
    }

    const maxRecs = this.config.conversion.max_recommendations;
    const recommendations: Recommendation[] = [];

    if (currentProductId) {
      const currentProduct = this.productMatcher.getProduct(currentProductId);
      if (currentProduct) {
        // alternative: 当前商品缺货 → 推荐同类有货商品
        if (currentProduct.variants.every((v) => v.stock === 0)) {
          const alt = this.findAlternative(currentProduct);
          if (alt) {
            recommendations.push(alt);
          }
        }

        // up_sell: 同商品更高价位规格
        const upSell = this.findUpSell(currentProduct);
        if (upSell) {
          recommendations.push(upSell);
        }

        // cross_sell: 其他商品 keywords 交集
        const crossSells = this.findCrossSell(currentProduct, maxRecs - recommendations.length);
        recommendations.push(...crossSells);
      }
    } else {
      // 无当前商品，推荐热销品（库存最多的）
      const topProducts = this.findTopProducts(maxRecs);
      recommendations.push(...topProducts);
    }

    if (recommendations.length > maxRecs) {
      recommendations.length = maxRecs;
    }

    if (recommendations.length > 0) {
      this.lastRecommendAt.set(cooldownKey, Date.now());
      this.pruneStaleEntries();
    }

    return recommendations;
  }

  private findAlternative(currentProduct: Product): Recommendation | null {
    const allProducts = this.productMatcher.listProducts();
    for (const p of allProducts) {
      if (p.product_id === currentProduct.product_id) continue;
      if (!p.active) continue;
      const hasStock = p.variants.some((v) => v.stock > 0);
      if (!hasStock) continue;
      const overlap = this.keywordOverlap(currentProduct.keywords, p.keywords);
      if (overlap > 0) {
        const inStockVariant = p.variants.find((v) => v.stock > 0);
        return {
          productId: p.product_id,
          productName: p.name,
          reason: `当前商品缺货，为您推荐同类商品`,
          score: 0.5 + overlap * 0.3,
          strategy: 'alternative',
          spec: inStockVariant?.spec,
          price: inStockVariant?.price,
        };
      }
    }
    return null;
  }

  private findUpSell(currentProduct: Product): Recommendation | null {
    const variants = [...currentProduct.variants].sort((a, b) => b.price - a.price);
    if (variants.length < 2) return null;
    const top = variants[0];
    const currentCheapest = variants[variants.length - 1];
    if (top.price <= currentCheapest.price) return null;
    return {
      productId: currentProduct.product_id,
      productName: currentProduct.name,
      reason: `升级到 ${top.spec}，仅 ${top.price} 元`,
      score: 0.7,
      strategy: 'up_sell',
      spec: top.spec,
      price: top.price,
    };
  }

  private findCrossSell(currentProduct: Product, limit: number): Recommendation[] {
    const allProducts = this.productMatcher.listProducts();
    const results: Recommendation[] = [];
    const threshold = this.config.conversion.cross_sell_threshold;

    for (const p of allProducts) {
      if (p.product_id === currentProduct.product_id) continue;
      if (!p.active) continue;
      const hasStock = p.variants.some((v) => v.stock > 0);
      if (!hasStock) continue;

      const overlap = this.keywordOverlap(currentProduct.keywords, p.keywords);
      const normalizedOverlap = overlap / Math.max(currentProduct.keywords.length, 1);
      if (normalizedOverlap >= threshold) {
        const inStockVariant = p.variants.find((v) => v.stock > 0);
        const priceProximity = this.priceProximity(
          currentProduct.variants[0]?.price ?? 0,
          inStockVariant?.price ?? 0,
        );
        const score = normalizedOverlap * 0.4 + priceProximity * 0.3 + 0.2 + 0.1;
        results.push({
          productId: p.product_id,
          productName: p.name,
          reason: `搭配购买 ${p.name}`,
          score,
          strategy: 'cross_sell',
          spec: inStockVariant?.spec,
          price: inStockVariant?.price,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  private findTopProducts(limit: number): Recommendation[] {
    const allProducts = this.productMatcher.listProducts();
    const withStock = allProducts
      .filter((p) => p.active && p.variants.some((v) => v.stock > 0))
      .map((p) => {
        const totalStock = p.variants.reduce((s, v) => s + v.stock, 0);
        const minPrice = Math.min(...p.variants.map((v) => v.price));
        return { product: p, totalStock, minPrice };
      })
      .sort((a, b) => b.totalStock - a.totalStock);

    return withStock.slice(0, limit).map(({ product, minPrice }) => ({
      productId: product.product_id,
      productName: product.name,
      reason: `热销推荐`,
      score: 0.5,
      strategy: 'complementary' as RecommendationStrategy,
      price: minPrice,
    }));
  }

  private keywordOverlap(kw1: string[], kw2: string[]): number {
    const set1 = new Set(kw1.map((k) => k.toLowerCase()));
    const set2 = new Set(kw2.map((k) => k.toLowerCase()));
    let count = 0;
    for (const k of set1) {
      if (set2.has(k)) count++;
    }
    return count;
  }

  /** 清理过期的冷却记录；若仍超出上限，按最旧（Map 插入顺序）删除（L-13） */
  private pruneStaleEntries(): void {
    if (this.lastRecommendAt.size <= this.maxEntries) {
      const now = Date.now();
      for (const [key, ts] of this.lastRecommendAt) {
        if (now - ts > this.staleMs) this.lastRecommendAt.delete(key);
      }
      return;
    }
    while (this.lastRecommendAt.size > this.maxEntries) {
      const oldest = this.lastRecommendAt.keys().next().value;
      if (oldest === undefined) break;
      this.lastRecommendAt.delete(oldest);
    }
  }

  private priceProximity(price1: number, price2: number): number {
    if (price1 === 0 || price2 === 0) return 0.5;
    const ratio = Math.min(price1, price2) / Math.max(price1, price2);
    return ratio;
  }
}
