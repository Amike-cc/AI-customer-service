/**
 * 限流器
 * 详见 docs/20-配置规范.md ratelimit 段
 * 单店每分钟 N 次 + 凌晨降频 + 突发允许
 */
import type { Config } from '../config/schema';

interface ShopRateBucket {
  shopId: string;
  /** 当前窗口内的请求时间戳列表 */
  timestamps: number[];
  /** 突发窗口内的额外请求时间戳 */
  burstTimestamps: number[];
}

export class RateLimiter {
  private buckets = new Map<string, ShopRateBucket>();

  constructor(private config: Config) {}

  /** 检查是否允许回复，允许则记录并返回 true */
  tryAcquire(shopId: string): boolean {
    if (!this.isEnabled) return true;

    const now = Date.now();
    const bucket = this.getOrCreateBucket(shopId);

    // 清理 1 分钟前的记录
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < 60000);
    bucket.burstTimestamps = bucket.burstTimestamps.filter(
      (t) => now - t < this.config.ratelimit.burst_window_ms,
    );

    const limit = this.getCurrentLimit();
    if (bucket.timestamps.length < limit) {
      bucket.timestamps.push(now);
      return true;
    }

    // 检查突发允许
    if (bucket.burstTimestamps.length < this.config.ratelimit.burst_allowance) {
      bucket.burstTimestamps.push(now);
      return true;
    }

    return false;
  }

  /** 当前每分钟回复上限（按时段降频） */
  getCurrentLimit(): number {
    if (!this.isEnabled) return Number.POSITIVE_INFINITY;

    const hour = new Date().getHours();
    const [nightStart, nightEnd] = this.config.ratelimit.night_hours;
    let limit = this.config.ratelimit.per_shop_per_minute;
    const isNight = nightStart < nightEnd
      ? hour >= nightStart && hour < nightEnd
      : nightStart > nightEnd
        ? hour >= nightStart || hour < nightEnd
        : false;
    if (isNight) {
      limit = Math.floor(limit * this.config.ratelimit.night_factor);
    }
    return Math.max(1, limit);
  }

  /** 距离下次允许回复的毫秒数（用于延迟等待） */
  msUntilNextAvailable(shopId: string): number {
    if (!this.isEnabled) return 0;

    const bucket = this.buckets.get(shopId);
    if (!bucket) return 0;

    const now = Date.now();
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < 60000);
    if (bucket.timestamps.length < this.getCurrentLimit()) return 0;

    // 找到最早的请求，等待其过期
    const oldest = Math.min(...bucket.timestamps);
    return Math.max(0, 60000 - (now - oldest) + 100);
  }

  /** 重置店铺限流（人工接管后或调试用） */
  reset(shopId: string): void {
    this.buckets.delete(shopId);
  }

  /** 获取店铺当前剩余配额 */
  remainingQuota(shopId: string): number {
    if (!this.isEnabled) return Number.POSITIVE_INFINITY;

    const bucket = this.buckets.get(shopId);
    if (!bucket) return this.getCurrentLimit();

    const now = Date.now();
    const valid = bucket.timestamps.filter((t) => now - t < 60000);
    return Math.max(0, this.getCurrentLimit() - valid.length);
  }

  private getOrCreateBucket(shopId: string): ShopRateBucket {
    let bucket = this.buckets.get(shopId);
    if (!bucket) {
      bucket = { shopId, timestamps: [], burstTimestamps: [] };
      this.buckets.set(shopId, bucket);
    }
    return bucket;
  }

  private get isEnabled(): boolean {
    return this.config.ratelimit.enabled !== false;
  }
}
