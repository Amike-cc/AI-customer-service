/**
 * ConversionEngine 单元测试
 * 详见 src/conversion/ConversionEngine.ts
 */
import { ConversionEngine } from '@/conversion/ConversionEngine';
import { createTestConfig } from '../helpers/testConfig';
import type { ProductMatcher, Product } from '@/product/ProductMatcher';
import type { IntentResult } from '@/intent/types';

function makeProducts(): Product[] {
  return [
    {
      product_id: 'p1',
      name: '蓝牙耳机',
      sku: 'BT-001',
      variants: [
        { spec: '标准版', price: 99, stock: 10, sku: 'BT-001-S' },
        { spec: '升级版', price: 199, stock: 5, sku: 'BT-001-P' },
      ],
      shipping: { free_shipping: true, delivery_days: '2天', logistics: [] },
      after_sales: { return_days: 7, exchange_days: 15, policy: '' },
      faq: [],
      keywords: ['耳机', '无线', '蓝牙'],
      active: true,
    },
    {
      product_id: 'p2',
      name: '蓝牙音箱',
      sku: 'BT-002',
      variants: [{ spec: '标准版', price: 149, stock: 8, sku: 'BT-002-S' }],
      shipping: { free_shipping: true, delivery_days: '2天', logistics: [] },
      after_sales: { return_days: 7, exchange_days: 15, policy: '' },
      faq: [],
      keywords: ['音箱', '蓝牙'],
      active: true,
    },
  ];
}

function makeMockProductMatcher(products: Product[]): ProductMatcher {
  return {
    getProduct: (id: string) => products.find((p) => p.product_id === id) ?? null,
    listProducts: () => [...products],
  } as unknown as ProductMatcher;
}

describe('ConversionEngine', () => {
  let engine: ConversionEngine;
  let products: Product[];

  beforeEach(() => {
    products = makeProducts();
    engine = new ConversionEngine(createTestConfig(), makeMockProductMatcher(products));
  });

  describe('detectIntent', () => {
    it('购买意图 — 下单信号 + decision阶段', () => {
      const result = engine.detectIntent('我要下单', null, []);
      expect(result.hasIntent).toBe(true);
      expect(result.signals).toContain('buying_intent');
      expect(result.stage).toBe('decision');
    });

    it('犹豫信号 — consideration阶段', () => {
      const result = engine.detectIntent('我再看看，太贵了', null, []);
      expect(result.signals).toContain('hesitation');
      expect(result.stage).toBe('consideration');
    });

    it('价格询问信号', () => {
      const result = engine.detectIntent('多少钱', null, []);
      expect(result.signals).toContain('price_inquiry');
    });

    it('库存查询信号', () => {
      const result = engine.detectIntent('有货吗', null, []);
      expect(result.signals).toContain('stock_check');
    });

    it('售后意图 — retention阶段', () => {
      const intent: IntentResult = { category: 'after_sales', confidence: 0.9, entities: [] };
      const result = engine.detectIntent('退款', intent, []);
      expect(result.stage).toBe('retention');
    });

    it('无意图信号时 hasIntent=false', () => {
      const result = engine.detectIntent('你好', null, []);
      expect(result.hasIntent).toBe(false);
    });
  });

  describe('recommend', () => {
    it('无当前商品 — 推荐热销品 (complementary)', () => {
      const purchaseIntent = { hasIntent: true, signals: [], confidence: 0.5, stage: 'awareness' as const };
      const recs = engine.recommend('推荐商品', undefined, purchaseIntent, []);
      expect(recs.length).toBeGreaterThan(0);
      expect(recs[0].strategy).toBe('complementary');
    });

    it('当前商品 — up_sell 升级推荐', () => {
      const purchaseIntent = { hasIntent: true, signals: ['buying_intent'], confidence: 0.8, stage: 'decision' as const };
      const recs = engine.recommend('蓝牙耳机', 'p1', purchaseIntent, []);
      const upSell = recs.find((r) => r.strategy === 'up_sell');
      expect(upSell).toBeDefined();
      expect(upSell!.spec).toBe('升级版');
      expect(upSell!.price).toBe(199);
    });

    it('冷却期内不重复推荐', () => {
      const purchaseIntent = { hasIntent: true, signals: [], confidence: 0.5, stage: 'awareness' as const };
      const firstRecs = engine.recommend('推荐', undefined, purchaseIntent, []);
      expect(firstRecs.length).toBeGreaterThan(0);
      const secondRecs = engine.recommend('推荐', undefined, purchaseIntent, []);
      expect(secondRecs).toEqual([]);
    });

    it('不同会话之间的推荐冷却互不影响', () => {
      const purchaseIntent = { hasIntent: true, signals: [], confidence: 0.5, stage: 'awareness' as const };
      const first = engine.recommend('推荐', undefined, purchaseIntent, [], 'shop1', 'session1');
      const second = engine.recommend('推荐', undefined, purchaseIntent, [], 'shop1', 'session2');
      expect(first.length).toBeGreaterThan(0);
      expect(second.length).toBeGreaterThan(0);
    });
  });

});
