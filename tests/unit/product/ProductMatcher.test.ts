/**
 * 商品匹配器单元测试
 * 详见 docs/17-数据持久化与配置管理.md §17.5
 */
import { ProductMatcher } from '@/product/ProductMatcher';
import { createTestConfig } from '../helpers/testConfig';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

describe('ProductMatcher', () => {
  let tmpDir: string;
  let shopDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-test-'));
    const shopsDir = path.join(tmpDir, 'data', 'shops');
    await fs.ensureDir(shopsDir);
    shopDir = path.join(shopsDir, 'shop1');
    await fs.ensureDir(shopDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  async function writeProducts(products: any[]) {
    await fs.writeJson(path.join(shopDir, 'products.json'), { products });
  }

  function makeMatcher() {
    const config = createTestConfig({ app: { ...createTestConfig().app, data_dir: tmpDir } });
    return new ProductMatcher(config, 'shop1');
  }

  it('加载后能精确匹配商品名', async () => {
    await writeProducts([
      {
        product_id: 'p1',
        name: '蓝牙耳机',
        sku: 'BT-001',
        variants: [],
        shipping: { free_shipping: true, delivery_days: '2天', logistics: [] },
        after_sales: { return_days: 7, exchange_days: 15, policy: '' },
        faq: [],
        keywords: ['耳机', '无线'],
        active: true,
      },
    ]);
    const pm = makeMatcher();
    await pm.load();

    const r = pm.match('蓝牙耳机有货吗');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].productId).toBe('p1');
    expect(r[0].matchType).toBe('exact');
    expect(r[0].confidence).toBe(1.0);
  });

  it('关键词匹配', async () => {
    await writeProducts([
      {
        product_id: 'p1',
        name: '蓝牙耳机',
        sku: 'BT-001',
        variants: [],
        shipping: { free_shipping: true, delivery_days: '2天', logistics: [] },
        after_sales: { return_days: 7, exchange_days: 15, policy: '' },
        faq: [],
        keywords: ['耳机', '无线'],
        active: true,
      },
    ]);
    const pm = makeMatcher();
    await pm.load();

    const r = pm.match('我要买耳机');
    expect(r.some((m) => m.productId === 'p1')).toBe(true);
  });

  it('过滤 inactive 商品', async () => {
    await writeProducts([
      {
        product_id: 'p1',
        name: 'A',
        sku: 'A',
        variants: [],
        shipping: { free_shipping: true, delivery_days: '', logistics: [] },
        after_sales: { return_days: 7, exchange_days: 15, policy: '' },
        faq: [],
        keywords: [],
        active: false,
      },
      {
        product_id: 'p2',
        name: 'B',
        sku: 'B',
        variants: [],
        shipping: { free_shipping: true, delivery_days: '', logistics: [] },
        after_sales: { return_days: 7, exchange_days: 15, policy: '' },
        faq: [],
        keywords: [],
        active: true,
      },
    ]);
    const pm = makeMatcher();
    await pm.load();

    const r = pm.match('A');
    expect(r.some((m) => m.productId === 'p1')).toBe(false);
  });

  it('无匹配返回空数组', async () => {
    await writeProducts([
      {
        product_id: 'p1',
        name: 'XYZ',
        sku: 'X',
        variants: [],
        shipping: { free_shipping: true, delivery_days: '', logistics: [] },
        after_sales: { return_days: 7, exchange_days: 15, policy: '' },
        faq: [],
        keywords: [],
        active: true,
      },
    ]);
    const pm = makeMatcher();
    await pm.load();
    const r = pm.match('完全没有关联的查询');
    expect(r).toHaveLength(0);
  });

  it('文件不存在时 load 不报错，match 返回空', async () => {
    const pm = makeMatcher();
    await pm.load();
    expect(pm.match('anything')).toHaveLength(0);
  });

  it('getProduct 返回已加载商品', async () => {
    await writeProducts([
      {
        product_id: 'p1',
        name: '测试',
        sku: 'T',
        variants: [],
        shipping: { free_shipping: true, delivery_days: '', logistics: [] },
        after_sales: { return_days: 7, exchange_days: 15, policy: '' },
        faq: [],
        keywords: [],
        active: true,
      },
    ]);
    const pm = makeMatcher();
    await pm.load();
    expect(pm.getProduct('p1')?.name).toBe('测试');
    expect(pm.getProduct('nonexistent')).toBeNull();
  });

  it('多商品按 confidence 降序排序', async () => {
    await writeProducts([
      {
        product_id: 'p1',
        name: '耳机',
        sku: 'A',
        variants: [],
        shipping: { free_shipping: true, delivery_days: '', logistics: [] },
        after_sales: { return_days: 7, exchange_days: 15, policy: '' },
        faq: [],
        keywords: ['蓝牙耳机'],
        active: true,
      },
      {
        product_id: 'p2',
        name: '蓝牙耳机',
        sku: 'B',
        variants: [],
        shipping: { free_shipping: true, delivery_days: '', logistics: [] },
        after_sales: { return_days: 7, exchange_days: 15, policy: '' },
        faq: [],
        keywords: [],
        active: true,
      },
    ]);
    const pm = makeMatcher();
    await pm.load();
    const r = pm.match('蓝牙耳机');
    expect(r[0].confidence).toBeGreaterThanOrEqual(r[r.length - 1].confidence);
  });
});
