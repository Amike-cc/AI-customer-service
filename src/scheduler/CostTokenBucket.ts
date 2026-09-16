/**
 * 成本令牌桶
 * token 代表成本（¥），不是请求数
 *
 * 设计：
 * - 容量 = daily_budget_yuan
 * - 补充速率 = daily_budget_yuan / 86400_000 (每毫秒补充)
 * - 消费 = 实际 API 调用成本（input_tokens * price_input + output_tokens * price_output）
 * - 当桶内余额 < 请求成本时，拒绝或降级到更便宜的模型
 */
import type { Config } from '../config/schema';

export class CostTokenBucket {
  private tokens: number;
  private lastRefillTime: number;
  private capacity: number;
  private refillRatePerMs: number;
  private currentConfig: Config;

  constructor(config: Config) {
    this.currentConfig = config;
    this.capacity = config.scheduler.token_bucket.daily_budget_yuan;
    this.tokens = this.capacity;
    this.refillRatePerMs = this.capacity / 86400000;
    this.lastRefillTime = Date.now();
  }

  tryConsume(costYuan: number): { success: boolean; remaining: number } {
    this.refill();
    if (this.tokens >= costYuan) {
      this.tokens -= costYuan;
      return { success: true, remaining: this.tokens };
    }
    return { success: false, remaining: this.tokens };
  }

  peek(costYuan: number): { canAfford: boolean; remaining: number } {
    this.refill();
    return { canAfford: this.tokens >= costYuan, remaining: this.tokens };
  }

  consume(costYuan: number): void {
    this.refill();
    this.tokens = Math.max(0, this.tokens - costYuan);
  }

  /** 实际费用低于预留时退还差额。 */
  refund(costYuan: number): void {
    if (!Number.isFinite(costYuan) || costYuan <= 0) return;
    this.refill();
    this.tokens = Math.min(this.capacity, this.tokens + costYuan);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillTime;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRatePerMs);
    this.lastRefillTime = now;
  }

  get remaining(): number {
    this.refill();
    return this.tokens;
  }

  reset(): void {
    this.tokens = this.capacity;
    this.lastRefillTime = Date.now();
  }

  updateConfig(config: Config): void {
    this.currentConfig = config;
    // 预算热重载必须重建容量与补充速率，否则新预算只换配置对象、桶仍按旧值运转
    const newCapacity = config.scheduler.token_bucket.daily_budget_yuan;
    this.capacity = newCapacity;
    this.refillRatePerMs = newCapacity / 86400000;
    // 容量缩小时同步收缩当前余额（避免旧的剩余额度继续可用）
    this.tokens = Math.min(this.tokens, newCapacity);
  }
}
