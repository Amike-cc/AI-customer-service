/**
 * LRU + TTL 缓存单元测试
 * 详见 docs/17-数据持久化与配置管理.md §17.6
 */
import { LruCache } from '@/cache/LruCache';
import { createTestConfig } from '../helpers/testConfig';

describe('LruCache', () => {
  function makeCache(overrides?: Parameters<typeof createTestConfig>[0]) {
    return new LruCache(createTestConfig(overrides));
  }

  it('set/get 基本存取', () => {
    const cache = makeCache();
    cache.set('shop1', 'hash1', 'answer1');
    expect(cache.get('shop1', 'hash1')).toBe('answer1');
  });

  it('不同 shopId 隔离', () => {
    const cache = makeCache();
    cache.set('shop1', 'hash1', 'a1');
    cache.set('shop2', 'hash1', 'a2');
    expect(cache.get('shop1', 'hash1')).toBe('a1');
    expect(cache.get('shop2', 'hash1')).toBe('a2');
  });

  it('productId 区分缓存', () => {
    const cache = makeCache();
    cache.set('shop1', 'hash1', 'a1', 'p1');
    cache.set('shop1', 'hash1', 'a2', 'p2');
    expect(cache.get('shop1', 'hash1', 'p1')).toBe('a1');
    expect(cache.get('shop1', 'hash1', 'p2')).toBe('a2');
    expect(cache.get('shop1', 'hash1')).toBeNull();
  });

  it('TTL 过期淘汰', async () => {
    const cache = makeCache({
      cache: {
        ttl_ms: 50,
        max_entries_per_shop: 100,
        max_entries_global: 1000,
        invalidate_on_product_update: true,
      },
    });
    cache.set('shop1', 'hash1', 'a1');
    expect(cache.get('shop1', 'hash1')).toBe('a1');
    await new Promise((r) => setTimeout(r, 70));
    expect(cache.get('shop1', 'hash1')).toBeNull();
  });

  it('LRU 单店铺上限淘汰', () => {
    const cache = makeCache({
      cache: {
        ttl_ms: 3600000,
        max_entries_per_shop: 3,
        max_entries_global: 1000,
        invalidate_on_product_update: true,
      },
    });
    cache.set('shop1', 'h1', 'a1');
    cache.set('shop1', 'h2', 'a2');
    cache.set('shop1', 'h3', 'a3');
    // 访问 h1，h2 变最久未用
    cache.get('shop1', 'h1');
    cache.set('shop1', 'h4', 'a4'); // 应淘汰 h2
    expect(cache.get('shop1', 'h2')).toBeNull();
    expect(cache.get('shop1', 'h1')).toBe('a1');
    expect(cache.get('shop1', 'h3')).toBe('a3');
    expect(cache.get('shop1', 'h4')).toBe('a4');
  });

  it('全局上限淘汰', () => {
    const cache = makeCache({
      cache: {
        ttl_ms: 3600000,
        max_entries_per_shop: 100,
        max_entries_global: 3,
        invalidate_on_product_update: true,
      },
    });
    cache.set('shop1', 'h1', 'a1');
    cache.set('shop2', 'h1', 'a2');
    cache.set('shop3', 'h1', 'a3');
    cache.set('shop4', 'h1', 'a4'); // 淘汰 shop1.h1
    expect(cache.get('shop1', 'h1')).toBeNull();
  });

  it('invalidateShop 清空指定店铺', () => {
    const cache = makeCache();
    cache.set('shop1', 'h1', 'a1');
    cache.set('shop1', 'h2', 'a2');
    cache.set('shop2', 'h1', 'b1');
    cache.invalidateShop('shop1');
    expect(cache.get('shop1', 'h1')).toBeNull();
    expect(cache.get('shop1', 'h2')).toBeNull();
    expect(cache.get('shop2', 'h1')).toBe('b1');
  });

  it('invalidateProduct 仅清空指定商品缓存', () => {
    const cache = makeCache();
    cache.set('shop1', 'h1', 'a1', 'p1');
    cache.set('shop1', 'h2', 'a2', 'p1');
    cache.set('shop1', 'h3', 'a3', 'p2');
    cache.invalidateProduct('shop1', 'p1');
    expect(cache.get('shop1', 'h1', 'p1')).toBeNull();
    expect(cache.get('shop1', 'h2', 'p1')).toBeNull();
    expect(cache.get('shop1', 'h3', 'p2')).toBe('a3');
  });

  it('重复 set 同一 key 更新内容', () => {
    const cache = makeCache();
    cache.set('shop1', 'h1', 'old');
    cache.set('shop1', 'h1', 'new');
    expect(cache.get('shop1', 'h1')).toBe('new');
  });
});
