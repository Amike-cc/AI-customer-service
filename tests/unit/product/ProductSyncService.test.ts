/**
 * ProductSyncService 单元测试
 */
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import { ProductSyncService } from '@/product/ProductSyncService';
import type { ShopSupervisor } from '@/shop/ShopSupervisor';
import type { ProductManager } from '@/product/ProductManager';
import type { Product } from '@/product/ProductMatcher';
import type { IWebviewManager } from '@/cdp/types';
import { SCRAPE_PRODUCT_LIST_SCRIPT } from '@/product/scrape-scripts';

function makeSupervisor(
  started: boolean,
  scriptResult?: unknown,
  platform = 'pinduoduo',
): ShopSupervisor {
  return {
    hasShopStarted: jest.fn().mockReturnValue(started),
    getShopPlatform: jest.fn().mockReturnValue(platform),
    executeScriptOnShop: jest.fn().mockResolvedValue(scriptResult ?? ''),
    reloadProductCatalog: jest.fn().mockResolvedValue(undefined),
  } as unknown as ShopSupervisor;
}

function makeProductManager(existing: Product[] = []): ProductManager {
  return {
    listProducts: jest.fn().mockResolvedValue(existing),
    importProducts: jest.fn().mockResolvedValue({ imported: 0, errors: [] }),
    removeProducts: jest.fn().mockResolvedValue(0),
  } as unknown as ProductManager;
}

function makeLogger() {
  return { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } as any;
}

function makeWebviewManager(scriptResult: unknown): IWebviewManager {
  return {
    scrapeUrlInHiddenWindow: jest.fn().mockResolvedValue(scriptResult),
  } as unknown as IWebviewManager;
}

function makeService(
  supervisor: ShopSupervisor,
  productManager: ProductManager,
  logger: ReturnType<typeof makeLogger>,
  dataDir: string,
  scriptResult: unknown,
): ProductSyncService {
  return new ProductSyncService(
    supervisor,
    productManager,
    logger,
    dataDir,
    makeWebviewManager(scriptResult),
  );
}

describe('ProductSyncService', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `sync-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('syncShopProducts 店铺未启动抛错', async () => {
    const supervisor = makeSupervisor(false);
    const service = new ProductSyncService(supervisor, makeProductManager(), makeLogger(), tmpDir);
    await expect(service.syncShopProducts('123')).rejects.toThrow('未启动');
  });

  it('syncShopProducts 脚本返回空商品时返回空结果', async () => {
    const emptyResult = JSON.stringify({ steps: [], products: [], errors: ['未找到"商品"标签'] });
    const supervisor = makeSupervisor(true, emptyResult);
    const service = makeService(supervisor, makeProductManager(), makeLogger(), tmpDir, emptyResult);

    const result = await service.syncShopProducts('123');
    expect(result.total).toBe(0);
    expect(result.imported).toBe(0);
    expect(result.errors).toContain('未找到"商品"标签');
  });

  it('syncShopProducts 成功同步返回 imported', async () => {
    const scriptResult = JSON.stringify({
      steps: [{ step: 'click_product', ok: true }, { step: 'click_all_products', ok: true }],
      products: [
        { productId: 'p1', name: '测试商品1', specs: [{ name: '颜色', values: ['红', '蓝'] }] },
        { productId: 'p2', name: '测试商品2', attrs: [{ name: '材质', value: '棉' }] },
      ],
      errors: [],
    });
    const supervisor = makeSupervisor(true, scriptResult);
    const service = makeService(supervisor, makeProductManager(), makeLogger(), tmpDir, scriptResult);

    const result = await service.syncShopProducts('123');
    expect(result.total).toBe(2);
    expect(result.imported).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('syncShopProducts 智能合并保留现有商品字段', async () => {
    const scriptResult = JSON.stringify({
      steps: [],
      products: [{ productId: 'p1', name: '更新名称' }],
      errors: [],
    });
    const existingProduct: Product = {
      product_id: 'p1',
      name: '旧名称',
      sku: 'SKU001',
      variants: [{ spec: '红色', price: 100, stock: 10, sku: 'SKU001' }],
      shipping: { free_shipping: true, delivery_days: '1-2天', logistics: ['顺丰'] },
      after_sales: { return_days: 7, exchange_days: 15, policy: '7天无理由' },
      faq: [{ q: '怎么洗', a: '机洗即可' }],
      keywords: ['旧关键词'],
      active: true,
    };

    const supervisor = makeSupervisor(true, scriptResult);
    const service = makeService(supervisor, makeProductManager([existingProduct]), makeLogger(), tmpDir, scriptResult);

    const result = await service.syncShopProducts('123');
    expect(result.updated).toBe(1);
    expect(result.imported).toBe(0);
  });

  it('syncShopProducts 规格属性映射到 variants', async () => {
    const scriptResult = JSON.stringify({
      steps: [],
      products: [{
        productId: 'p1',
        name: '测试商品',
        specs: [
          { name: '颜色', values: ['红', '蓝'] },
          { name: '尺码', values: ['S', 'M'] },
        ],
        attrs: [{ name: '材质', value: '纯棉' }],
      }],
      errors: [],
    });
    const supervisor = makeSupervisor(true, scriptResult);
    const service = makeService(supervisor, makeProductManager(), makeLogger(), tmpDir, scriptResult);

    const result = await service.syncShopProducts('123');
    expect(result.total).toBe(1);
    expect(result.imported).toBe(1);
  });

  it('syncShopProducts 脚本返回非JSON时记录错误', async () => {
    const supervisor = makeSupervisor(true, 'not json');
    const service = makeService(supervisor, makeProductManager(), makeLogger(), tmpDir, 'not json');

    const result = await service.syncShopProducts('123');
    expect(result.total).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('diagnoseProductSidebar 店铺未启动抛错', async () => {
    const supervisor = makeSupervisor(false);
    const service = new ProductSyncService(supervisor, makeProductManager(), makeLogger(), tmpDir);
    await expect(service.diagnoseProductSidebar('123')).rejects.toThrow('未启动');
  });

  it('diagnoseProductSidebar 返回脚本执行结果', async () => {
    const diagData = JSON.stringify({ url: 'https://example.com', foundTexts: {} });
    const supervisor = makeSupervisor(true, diagData);
    const service = new ProductSyncService(supervisor, makeProductManager(), makeLogger(), tmpDir);

    const result = await service.diagnoseProductSidebar('123');
    expect(result).toBe(diagData);
  });

  it('getSyncStatus 无状态文件返回 null lastSyncAt', async () => {
    const supervisor = makeSupervisor(true);
    const service = new ProductSyncService(supervisor, makeProductManager(), makeLogger(), tmpDir);

    const status = await service.getSyncStatus('123');
    expect(status).not.toBeNull();
    expect(status!.lastSyncAt).toBeNull();
    expect(status!.productCount).toBe(0);
  });

  it('getSyncStatus 有状态文件返回正确数据', async () => {
    const scriptResult = JSON.stringify({
      steps: [],
      products: [{ productId: 'p1', name: '商品1' }],
      errors: [],
    });
    const supervisor = makeSupervisor(true, scriptResult);
    const service = makeService(supervisor, makeProductManager(), makeLogger(), tmpDir, scriptResult);

    await service.syncShopProducts('123');
    const status = await service.getSyncStatus('123');
    expect(status).not.toBeNull();
    expect(status!.lastSyncAt).not.toBeNull();
    expect(status!.lastResult).not.toBeNull();
  });

  it('飞鸽同步从独立商品管理页抓取，不执行客服会话脚本', async () => {
    // 商品含完整详情字段（description/category/specs/attrs/images），跳过详情页抓取阶段，
    // 只调用一次 scrapeUrlInHiddenWindow（列表页抓取）。
    const scriptResult = JSON.stringify({
      products: [{
        productId: '1234567890123456789',
        name: '飞鸽测试商品',
        price: 29.9,
        stock: 8,
        description: '这是一个完整的商品描述文本，长度大于10',
        category: '服装',
        specs: [{ name: '颜色', values: ['红', '蓝'] }],
        attrs: [{ name: '材质', value: '纯棉' }],
        images: ['https://example.com/1.jpg', 'https://example.com/2.jpg'],
      }],
      errors: [],
      steps: [{ page: 1, count: 1 }],
    });
    const supervisor = makeSupervisor(true, '', 'feige');
    const webviewManager = makeWebviewManager(scriptResult);
    const productManager = makeProductManager();
    const service = new ProductSyncService(
      supervisor,
      productManager,
      makeLogger(),
      tmpDir,
      webviewManager,
    );

    const result = await service.syncShopProducts('123');

    expect(result.imported).toBe(1);
    // 源码调用 scrapeUrlInHiddenWindow 时传入 6 个参数：shopId, url, script, timeout, wait, preloadScript
    expect(webviewManager.scrapeUrlInHiddenWindow).toHaveBeenCalledWith(
      '123',
      'https://fxg.jinritemai.com/ffa/g/list',
      expect.stringContaining('MAX_PAGES = 200'),
      expect.any(Number),
      expect.any(Number),
      expect.any(String),
    );
    // 跳过详情抓取后应仅调用 1 次
    expect(webviewManager.scrapeUrlInHiddenWindow).toHaveBeenCalledTimes(1);
    expect(supervisor.executeScriptOnShop).not.toHaveBeenCalled();
    expect(supervisor.reloadProductCatalog).toHaveBeenCalledWith('123');
  });

  it('飞鸽同步跳过没有真实商品ID的记录', async () => {
    const scriptResult = JSON.stringify({
      products: [
        { productId: 'gen_0', name: '错误临时商品' },
        { productId: '', name: '缺少编号商品' },
      ],
      errors: [],
    });
    const supervisor = makeSupervisor(true, '', 'feige');
    const productManager = makeProductManager();
    const service = new ProductSyncService(
      supervisor,
      productManager,
      makeLogger(),
      tmpDir,
      makeWebviewManager(scriptResult),
    );

    const result = await service.syncShopProducts('123');

    expect(result.total).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.errors).toContain('抓取结果中没有带真实商品ID的有效商品，本地商品库未修改');
    expect(productManager.importProducts).not.toHaveBeenCalled();
  });

  it('同一店铺并发点击同步只执行一次抓取', async () => {
    let resolveScrape: (value: unknown) => void = () => {};
    const scrapePromise = new Promise<unknown>((resolve) => { resolveScrape = resolve; });
    const webviewManager = makeWebviewManager('');
    (webviewManager.scrapeUrlInHiddenWindow as jest.Mock).mockReturnValue(scrapePromise);
    const supervisor = makeSupervisor(true, '', 'feige');
    const service = new ProductSyncService(
      supervisor,
      makeProductManager(),
      makeLogger(),
      tmpDir,
      webviewManager,
    );

    const first = service.syncShopProducts('123');
    const second = service.syncShopProducts('123');
    // 商品含完整详情字段，跳过详情页抓取阶段，只调用 1 次 scrapeUrlInHiddenWindow
    resolveScrape(JSON.stringify({
      products: [{
        productId: '1234567890123456789',
        name: '并发测试商品',
        description: '完整的商品描述，长度大于10字符',
        category: '服装',
        specs: [{ name: '颜色', values: ['红'] }],
        attrs: [{ name: '材质', value: '棉' }],
        images: ['https://example.com/1.jpg', 'https://example.com/2.jpg'],
      }],
      errors: [],
    }));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual(secondResult);
    // 并发去重：两次 syncShopProducts 调用应复用同一任务，只触发 1 次抓取
    expect(webviewManager.scrapeUrlInHiddenWindow).toHaveBeenCalledTimes(1);
  });

  it('飞鸽完整同步后清理历史临时商品并更新库存', async () => {
    const existingProduct: Product = {
      product_id: '1234567890123456789',
      name: '旧商品名',
      sku: 'old-sku',
      specs: [],
      attrs: [],
      variants: [{ spec: '默认', price: 20, stock: 0, sku: 'old-sku' }],
      shipping: { free_shipping: false, delivery_days: '2-3天', logistics: [] },
      after_sales: { return_days: 7, exchange_days: 15, policy: '' },
      faq: [],
      keywords: [],
      active: true,
    };
    const syntheticProduct = { ...existingProduct, product_id: 'gen_0', name: '历史错误商品' };
    const productManager = makeProductManager([existingProduct, syntheticProduct]);
    (productManager.removeProducts as jest.Mock).mockResolvedValue(1);
    const supervisor = makeSupervisor(true, '', 'feige');
    const webviewManager = makeWebviewManager(JSON.stringify({
      products: [{
        productId: '1234567890123456789',
        name: '新商品名',
        sku: 'SKU-NEW',
        price: 29.8,
        stock: 90,
        active: true,
      }],
      errors: [],
    }));
    const service = new ProductSyncService(
      supervisor,
      productManager,
      makeLogger(),
      tmpDir,
      webviewManager,
    );

    const result = await service.syncShopProducts('123');
    const importedJson = JSON.parse((productManager.importProducts as jest.Mock).mock.calls[0][1]);

    expect(result.updated).toBe(1);
    expect(result.removed).toBe(1);
    expect(productManager.removeProducts).toHaveBeenCalledWith('123', ['gen_0']);
    expect(importedJson.products[0].variants[0]).toEqual(
      expect.objectContaining({ price: 29.8, stock: 90, sku: 'SKU-NEW' }),
    );
    // 列表未返回真实详情 URL 时不再访问已废弃的 /ffa/g/product/edit 路由。
    expect(webviewManager.scrapeUrlInHiddenWindow).toHaveBeenCalledTimes(1);
  });

  it('非飞鸽平台也从商家后台商品列表同步完整目录', async () => {
    const scriptResult = JSON.stringify({
      products: [{ productId: 'goods-123', name: '拼多多测试商品', active: false }],
      errors: [],
    });
    const supervisor = makeSupervisor(true, '', 'pinduoduo');
    const webviewManager = makeWebviewManager(scriptResult);
    const service = new ProductSyncService(
      supervisor,
      makeProductManager(),
      makeLogger(),
      tmpDir,
      webviewManager,
    );

    const result = await service.syncShopProducts('123');

    expect(result.total).toBe(1);
    expect(webviewManager.scrapeUrlInHiddenWindow).toHaveBeenCalledWith(
      '123',
      'https://mms.pinduoduo.com/goods/goods_list',
      SCRAPE_PRODUCT_LIST_SCRIPT,
      240_000,
      10_000,
      expect.any(String),
    );
    expect(supervisor.executeScriptOnShop).not.toHaveBeenCalled();
  });

  it('列表页空规格和属性不会覆盖已有完整商品字段', async () => {
    const existingProduct: Product = {
      product_id: 'goods-123',
      name: '已有商品',
      sku: 'SKU-1',
      specs: [{ name: '颜色', values: ['红色', '蓝色'] }],
      attrs: [{ name: '材质', value: '纯棉' }],
      variants: [{ spec: '红色', price: 29.9, stock: 8, sku: 'SKU-1' }],
      shipping: { free_shipping: true, delivery_days: '1天', logistics: ['顺丰'] },
      after_sales: { return_days: 7, exchange_days: 15, policy: '7天无理由' },
      faq: [],
      keywords: [],
      active: true,
    };
    const productManager = makeProductManager([existingProduct]);
    const service = makeService(
      makeSupervisor(true, '', 'pinduoduo'),
      productManager,
      makeLogger(),
      tmpDir,
      JSON.stringify({
        products: [{ productId: 'goods-123', name: '更新商品', specs: [], attrs: [] }],
        errors: [],
      }),
    );

    await service.syncShopProducts('123');
    const imported = JSON.parse((productManager.importProducts as jest.Mock).mock.calls[0][1]);
    expect(imported.products[0].specs).toEqual(existingProduct.specs);
    expect(imported.products[0].attrs).toEqual(existingProduct.attrs);
  });

  it('商品列表脚本保留非上架商品并包含多种分页兜底', () => {
    expect(SCRAPE_PRODUCT_LIST_SCRIPT).toContain('products.push(item.product)');
    expect(SCRAPE_PRODUCT_LIST_SCRIPT).toContain('商品管理需要完整目录');
    expect(SCRAPE_PRODUCT_LIST_SCRIPT).toContain('.ant-pagination-next');
    expect(SCRAPE_PRODUCT_LIST_SCRIPT).toContain('[aria-current="page"]');
  });
});
