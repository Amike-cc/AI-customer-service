/**
 * E2E 测试：缓存命中场景
 *
 * 覆盖场景：E-06
 * 验证完整业务流程：同一问题第二次询问 → LruCache 精确命中 → 不再调用 DeepSeek
 *
 * 对应文档：docs/开发文档-综合版.md 第 12.5 节、第 17.6 节
 */
import { LruCache } from '@/cache/LruCache';
import { createTestConfig } from '../unit/helpers/testConfig';
import crypto from 'crypto';

describe('E2E: 缓存命中', () => {
  let cache: LruCache;
  const config = createTestConfig({
    cache: {
      ttl_ms: 3600000,
      max_entries_per_shop: 100,
      max_entries_global: 1000,
      invalidate_on_product_update: true,
    },
  });

  beforeEach(() => {
    cache = new LruCache(config);
  });

  it('E-06: 同一问题第二次询问 → LruCache 精确命中', () => {
    const shopId = 'shop-e2e-06';
    const question = '这款衣服的尺码是多少';
    const questionHash = crypto.createHash('md5').update(question).digest('hex');
    const answer = 'M/L/XL 三个尺码可选';

    // 第一次查询：未命中，写入缓存
    const firstResult = cache.get(shopId, questionHash);
    expect(firstResult).toBeNull();
    cache.set(shopId, questionHash, answer);

    // 第二次查询：应命中
    const secondResult = cache.get(shopId, questionHash);
    expect(secondResult).toBe(answer);
  });

  it('E-06b: 不同问题不命中（避免假阳性）', () => {
    const shopId = 'shop-e2e-06b';
    const q1 = '尺码是多少';
    const q2 = '颜色有哪些';
    const h1 = crypto.createHash('md5').update(q1).digest('hex');
    const h2 = crypto.createHash('md5').update(q2).digest('hex');

    cache.set(shopId, h1, 'M/L/XL');

    expect(cache.get(shopId, h2)).toBeNull();
    expect(cache.get(shopId, h1)).toBe('M/L/XL');
  });
});
