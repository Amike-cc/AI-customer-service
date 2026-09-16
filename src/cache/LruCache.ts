/**
 * LRU + TTL 缓存
 * 详见 docs/17-数据持久化与配置管理.md §17.6
 */
import type { Config } from '../config/schema';
import { getDynamicThreshold, levenshtein } from './similarity';

interface CacheEntry {
  key: string;
  answer: string;
  questionText?: string;
  productId?: string;
  createdAt: number;
  lastAccessedAt: number;
  hitCount: number;
}

export class LruCache {
  private entries = new Map<string, CacheEntry>();
  private globalCount = 0;

  constructor(private config: Config) {}

  get(shopId: string, questionHash: string, productId?: string): string | null {
    const key = this.key(shopId, questionHash, productId);
    const entry = this.entries.get(key);
    if (!entry) return null;

    if (Date.now() - entry.createdAt > this.config.cache.ttl_ms) {
      this.entries.delete(key);
      this.globalCount -= 1;
      return null;
    }

    // LRU: 移到末尾
    this.entries.delete(key);
    this.entries.set(key, entry);
    entry.lastAccessedAt = Date.now();
    entry.hitCount += 1;
    return entry.answer;
  }

  set(shopId: string, questionHash: string, answer: string, productId?: string, questionText?: string): void {
    const key = this.key(shopId, questionHash, productId);
    const existed = this.entries.has(key);

    // 容量淘汰（仅新增条目时才需要淘汰）
    if (!existed) this.evictIfFull(shopId);

    this.entries.set(key, {
      key,
      answer,
      questionText,
      productId,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      hitCount: 0,
    });
    if (!existed) this.globalCount += 1;
  }

  getSemantic(
    shopId: string,
    questionText: string,
    productId?: string,
  ): { answer: string; similarity: number } | null {
    if (!this.config.cache.semantic_enabled) return null;

    // 问候类消息跳过：不应命中语义缓存，避免错误复用答非所问的内容
    if (/^(你好|您好|hi|hello|在吗|有人吗|哈喽|嗨)/i.test(questionText.trim())) {
      return null;
    }

    const threshold = getDynamicThreshold(questionText);
    const queryBigrams = this.bigrams(questionText);
    if (queryBigrams.size === 0) return null;

    let best: { answer: string; similarity: number } | null = null;
    const now = Date.now();
    // 先收集候选并按文本长度差排序：Map 迭代是插入序，盲扫前 N 条会让
    // 最旧条目（最可能相似度高的）在条目多时永远不被比较，缓存命中率静默下降。
    // 按长度差排序后优先比较更可能相似的条目，截断后仍能保证质量。
    const MAX_SEMANTIC_COMPARE = 2000;
    const candidates: Array<{ entry: CacheEntry; lenDiff: number }> = [];
    for (const entry of this.entries.values()) {
      if (!entry.key.startsWith(`${shopId}:`)) continue;
      if (productId && entry.productId !== productId) continue;
      if (now - entry.createdAt > this.config.cache.ttl_ms) continue;
      if (!entry.questionText) continue;
      candidates.push({
        entry,
        lenDiff: Math.abs(entry.questionText.length - questionText.length),
      });
    }
    candidates.sort((a, b) => a.lenDiff - b.lenDiff);

    const compareLimit = Math.min(candidates.length, MAX_SEMANTIC_COMPARE);
    for (let i = 0; i < compareLimit; i++) {
      const { entry } = candidates[i];
      const entryBigrams = this.bigrams(entry.questionText!);
      const sim = this.jaccard(queryBigrams, entryBigrams);

      // 对短文本补充编辑距离相似度，缓解 bigram 在短文本上不稳定的问题
      let finalSim = sim;
      if (questionText.length < 20 || (entry.questionText?.length ?? 0) < 20) {
        const editSim =
          1 -
          levenshtein(questionText, entry.questionText!) /
            Math.max(questionText.length, entry.questionText!.length, 1);
        finalSim = Math.max(sim, editSim * 0.9);
      }

      if (!best || finalSim > best.similarity) {
        best = { answer: entry.answer, similarity: finalSim };
      }
      // 近似完全匹配，提前结束扫描
      if (finalSim >= 0.98) break;
    }
    return best && best.similarity >= threshold ? best : null;
  }

  private bigrams(text: string): Set<string> {
    const set = new Set<string>();
    for (let i = 0; i < text.length - 1; i++) {
      set.add(text.slice(i, i + 2));
    }
    return set;
  }

  private jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const x of a) if (b.has(x)) intersection++;
    return intersection / (a.size + b.size - intersection);
  }

  invalidateShop(shopId: string): void {
    for (const [key] of this.entries) {
      if (key.startsWith(`${shopId}:`)) {
        this.entries.delete(key);
        this.globalCount -= 1;
      }
    }
  }

  /** 获取缓存统计信息（供诊断面板使用） */
  getStats(): {
    totalEntries: number;
    shopEntries: Record<string, number>;
    totalHitCount: number;
    oldestCreatedAt: number | null;
  } {
    const shopEntries: Record<string, number> = {};
    let totalHitCount = 0;
    let oldestCreatedAt: number | null = null;

    for (const entry of this.entries.values()) {
      const shopId = entry.key.split(':')[0];
      shopEntries[shopId] = (shopEntries[shopId] ?? 0) + 1;
      totalHitCount += entry.hitCount;
      if (oldestCreatedAt === null || entry.createdAt < oldestCreatedAt) {
        oldestCreatedAt = entry.createdAt;
      }
    }

    return {
      totalEntries: this.globalCount,
      shopEntries,
      totalHitCount,
      oldestCreatedAt,
    };
  }

  invalidateProduct(shopId: string, productId: string): void {
    for (const [key, entry] of this.entries) {
      if (key.startsWith(`${shopId}:`) && entry.productId === productId) {
        this.entries.delete(key);
        this.globalCount -= 1;
      }
    }
  }

  private key(shopId: string, questionHash: string, productId?: string): string {
    return [shopId, productId ?? '', questionHash].join(':');
  }

  private evictIfFull(shopId: string): void {
    // 全局上限
    while (this.globalCount >= this.config.cache.max_entries_global) {
      this.evictOldest();
    }
    // 单店铺上限
    let shopCount = 0;
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${shopId}:`)) shopCount += 1;
    }
    while (shopCount >= this.config.cache.max_entries_per_shop) {
      this.evictOldest(shopId);
      shopCount -= 1;
    }
  }

  private evictOldest(shopId?: string): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this.entries) {
      if (shopId && !key.startsWith(`${shopId}:`)) continue;
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.entries.delete(oldestKey);
      this.globalCount -= 1;
    }
  }
}
