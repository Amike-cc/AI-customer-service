/**
 * 商品匹配器
 * 详见 docs/17-数据持久化与配置管理.md §17.5
 */
import fs from 'fs-extra';
import path from 'path';
import type { Config } from '../config/schema';

export interface Product {
  product_id: string;
  name: string;
  sku: string;
  /** 商品规格（如颜色、尺码等规格名及其可选值） */
  specs: Array<{ name: string; values: string[] }>;
  /** 商品属性（如材质、品牌、产地等键值对） */
  attrs: Array<{ name: string; value: string }>;
  variants: Array<{ spec: string; price: number; stock: number; sku: string }>;
  shipping: { free_shipping: boolean; delivery_days: string; logistics: string[] };
  after_sales: { return_days: number; exchange_days: number; policy: string };
  faq: Array<{ q: string; a: string }>;
  keywords: string[];
  active: boolean;
  /** 商品描述 */
  description?: string;
  /** 商品分类路径 */
  category?: string;
  /** 商品图片列表（含主图） */
  images?: string[];
  /** 平台创建时间 */
  createdAt?: string;
  /** 平台更新时间 */
  updatedAt?: string;
  /** 销量 */
  sales?: number;
}

export interface MatchResult {
  productId: string;
  confidence: number;
  matchType: 'exact' | 'fuzzy' | 'keyword';
}

export class ProductMatcher {
  private products: Product[] = [];
  private keywordIndex = new Map<string, Set<string>>();

  constructor(private config: Config, private shopId: string) {}

  async load(): Promise<void> {
    const filePath = path.join(this.config.app.data_dir, 'data', 'shops', this.shopId, 'products.json');
    if (!(await fs.pathExists(filePath))) {
      return;
    }
    const data = await fs.readJson(filePath);
    this.products = (data.products as Product[]).filter((p) => p.active);
    this.buildIndex();
  }

  private buildIndex(): void {
    this.keywordIndex.clear();
    for (const p of this.products) {
      for (const kw of [p.name, ...p.keywords]) {
        const normalized = (kw ?? '').trim().toLowerCase();
        // 空字符串会命中所有消息（includes('') 恒真），必须跳过
        if (!normalized) continue;
        if (!this.keywordIndex.has(normalized)) {
          this.keywordIndex.set(normalized, new Set());
        }
        this.keywordIndex.get(normalized)!.add(p.product_id);
      }
    }
  }

  match(text: string): MatchResult[] {
    const results = new Map<string, MatchResult>();
    const lower = text.toLowerCase();
    const algo = this.config.product.match_algorithm;

    // 1. 关键词匹配
    for (const [kw, ids] of this.keywordIndex) {
      if (lower.includes(kw)) {
        for (const id of ids) {
          const existing = results.get(id);
          const score = this.config.product.keywords_weight * (kw.length / Math.max(1, lower.length));
          if (!existing || existing.confidence < score) {
            results.set(id, { productId: id, confidence: score, matchType: 'keyword' });
          }
        }
      }
    }

    // 2. 精确匹配商品名（名称非空，且与关键词一致统一小写比较）
    for (const p of this.products) {
      if (p.name && p.name.trim().length > 0 && lower.includes(p.name.toLowerCase())) {
        results.set(p.product_id, {
          productId: p.product_id,
          confidence: 1.0,
          matchType: 'exact',
        });
      }
    }

    // 3. 模糊匹配（fuzzy / hybrid 模式）
    if (algo === 'fuzzy' || algo === 'hybrid') {
      for (const p of this.products) {
        const candidates = [p.name, ...p.keywords].map((c) => c.toLowerCase());
        let bestSim = 0;
        for (const c of candidates) {
          const sim = this.similarity(lower, c);
          if (sim > bestSim) bestSim = sim;
        }
        if (bestSim >= this.config.product.fuzzy_threshold) {
          const score = bestSim * this.config.product.fuzzy_match_weight;
          const existing = results.get(p.product_id);
          if (!existing || existing.confidence < score) {
            results.set(p.product_id, {
              productId: p.product_id,
              confidence: score,
              matchType: 'fuzzy',
            });
          }
        }
      }
    }

    return Array.from(results.values()).sort((a, b) => b.confidence - a.confidence);
  }

  /** Levenshtein 距离 */
  private levenshtein(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const prev = new Array(n + 1);
    const curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      for (let j = 0; j <= n; j++) prev[j] = curr[j];
    }
    return prev[n];
  }

  /** 基于 Levenshtein 距离的相似度比率 [0,1] */
  private similarity(a: string, b: string): number {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    return 1 - this.levenshtein(a, b) / maxLen;
  }

  getProduct(productId: string): Product | null {
    return this.products.find((p) => p.product_id === productId) ?? null;
  }

  listProducts(): Product[] {
    return [...this.products];
  }

  get count(): number {
    return this.products.length;
  }
}
