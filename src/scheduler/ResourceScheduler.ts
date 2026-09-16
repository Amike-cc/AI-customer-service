/**
 * 资源调度器：成本预算控制 + 令牌桶 + 动态模型选择
 * 在 ModelGateway 调用 Provider 之前进行资源检查
 */
import type { ScheduleRequest, ScheduleDecision, CostRecord, ModelTier } from './types';
import type { CostTokenBucket } from './CostTokenBucket';
import type { BudgetTracker } from './BudgetTracker';
import type { PrioritySelector } from './PrioritySelector';
import type { Config } from '../config/schema';
import type { MetricsCollector } from '../monitor/MetricsCollector';
import type { AppLogger } from '../logging/logger';

export interface ResourceSchedulerDeps {
  tokenBucket: CostTokenBucket;
  budgetTracker: BudgetTracker;
  prioritySelector: PrioritySelector;
  metrics: MetricsCollector;
  logger: AppLogger;
  config: Config;
}

const TIER_ORDER: ModelTier[] = ['tier1', 'tier2', 'tier3'];

export class ResourceScheduler {
  private reservations = new Map<string, { shopId: string; costYuan: number }>();
  private reservedGlobal = 0;
  private reservedByShop = new Map<string, number>();
  private nextReservationId = 1;

  constructor(private deps: ResourceSchedulerDeps) {}

  async acquire(req: ScheduleRequest): Promise<ScheduleDecision> {
    if (!this.deps.config.scheduler.enabled) {
      return { allowed: true, allocatedTier: req.tier };
    }

    const candidates: Array<{ tier: ModelTier; costYuan: number }> = [
      { tier: req.tier, costYuan: req.estimatedCostYuan },
    ];
    const startIndex = TIER_ORDER.indexOf(req.tier);
    // tier1 最便宜、tier3 最贵；余额不足时向更低索引降级。
    for (let i = startIndex - 1; i >= 0; i--) {
      const tier = TIER_ORDER[i];
      candidates.push({
        tier,
        costYuan: req.estimatedCostByTier?.[tier] ?? this.estimateCheaperCost(tier, req),
      });
    }

    let budgetReject: ScheduleDecision['rejectReason'];
    let hadBudgetAffordableCandidate = false;
    for (const candidate of candidates) {
      const rejectReason = this.getBudgetRejectReason(req.shopId, candidate.costYuan);
      if (rejectReason) {
        budgetReject ??= rejectReason;
        continue;
      }
      hadBudgetAffordableCandidate = true;
      const consumed = this.deps.tokenBucket.tryConsume(candidate.costYuan);
      if (!consumed.success) continue;
      const reservationId = this.createReservation(req.shopId, candidate.costYuan);
      return {
        allowed: true,
        allocatedTier: candidate.tier,
        reservationId,
        reservedCostYuan: candidate.costYuan,
      };
    }

    const waitMs = this.estimateWaitTime(req.estimatedCostYuan);
    return {
      allowed: false,
      allocatedTier: req.tier,
      rejectReason: hadBudgetAffordableCandidate ? 'insufficient_budget' : budgetReject ?? 'insufficient_budget',
      waitMs,
    };
  }

  recordCost(record: CostRecord, reservationId?: string): void {
    const reservation = reservationId ? this.takeReservation(reservationId) : undefined;
    if (reservation) {
      // 即使请求执行期间热关闭了 scheduler，也要结清此前已经扣除的预留。
      const delta = record.costYuan - reservation.costYuan;
      if (delta > 0) this.deps.tokenBucket.consume(delta);
      if (delta < 0) this.deps.tokenBucket.refund(-delta);
    } else if (this.deps.config.scheduler.enabled) {
      // 兼容未使用预留 API 的调用方。
      this.deps.tokenBucket.consume(record.costYuan);
    }
    this.deps.budgetTracker.record(record);
    this.deps.metrics.inc(
      'cost_yuan_total',
      Math.round(record.costYuan * 10000),
      { tier: record.tier, provider: record.provider },
      record.shopId,
    );
    this.deps.metrics.inc(
      'cost_tokens_total',
      record.tokens,
      { tier: record.tier },
      record.shopId,
    );
  }

  releaseReservation(reservationId?: string): void {
    if (!reservationId) return;
    const reservation = this.takeReservation(reservationId);
    if (reservation) this.deps.tokenBucket.refund(reservation.costYuan);
  }

  getDailyCost(shopId: string): number {
    return this.deps.budgetTracker.getDailyCost(shopId);
  }

  getGlobalDailyCost(): number {
    return this.deps.budgetTracker.getGlobalDailyCost();
  }

  setShopPriority(shopId: string, priority: 'high' | 'normal' | 'low'): void {
    this.deps.prioritySelector.setPriority(shopId, priority);
    this.deps.budgetTracker.setShopPriority(shopId, priority);
  }

  updateConfig(config: Config): void {
    this.deps.config = config;
    this.deps.tokenBucket.updateConfig(config);
    this.deps.budgetTracker.updateConfig(config);
    this.deps.prioritySelector.updateConfig(config);
  }

  private getBudgetRejectReason(
    shopId: string,
    estimatedCostYuan: number,
  ): ScheduleDecision['rejectReason'] | undefined {
    const globalWithReservation =
      this.deps.budgetTracker.getGlobalDailyCost() + this.reservedGlobal + estimatedCostYuan;
    if (globalWithReservation > this.deps.config.scheduler.budget.global_daily_yuan) {
      return 'global_daily_budget_exceeded';
    }
    const monthlyWithReservation =
      this.deps.budgetTracker.getGlobalMonthlyCost() + this.reservedGlobal + estimatedCostYuan;
    if (monthlyWithReservation > this.deps.config.scheduler.budget.global_monthly_yuan) {
      return 'global_monthly_budget_exceeded';
    }
    const shopWithReservation =
      this.deps.budgetTracker.getDailyCost(shopId) +
      (this.reservedByShop.get(shopId) ?? 0) +
      estimatedCostYuan;
    if (shopWithReservation > this.deps.budgetTracker.getShopDailyLimit(shopId)) {
      return 'shop_daily_budget_exceeded';
    }
    return undefined;
  }

  private createReservation(shopId: string, costYuan: number): string {
    const id = `budget-${Date.now().toString(36)}-${this.nextReservationId++}`;
    this.reservations.set(id, { shopId, costYuan });
    this.reservedGlobal += costYuan;
    this.reservedByShop.set(shopId, (this.reservedByShop.get(shopId) ?? 0) + costYuan);
    return id;
  }

  private takeReservation(reservationId: string): { shopId: string; costYuan: number } | undefined {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return undefined;
    this.reservations.delete(reservationId);
    this.reservedGlobal = Math.max(0, this.reservedGlobal - reservation.costYuan);
    const shopReserved = Math.max(
      0,
      (this.reservedByShop.get(reservation.shopId) ?? 0) - reservation.costYuan,
    );
    if (shopReserved === 0) this.reservedByShop.delete(reservation.shopId);
    else this.reservedByShop.set(reservation.shopId, shopReserved);
    return reservation;
  }

  private estimateCheaperCost(tier: ModelTier, req: ScheduleRequest): number {
    const ratio: Record<ModelTier, number> = { tier1: 0.1, tier2: 0.3, tier3: 1.0 };
    return req.estimatedCostYuan * ratio[tier];
  }

  private estimateWaitTime(costYuan: number): number {
    const remaining = this.deps.tokenBucket.remaining;
    if (remaining >= costYuan) return 0;
    const deficit = costYuan - remaining;
    const refillRatePerMs =
      this.deps.config.scheduler.token_bucket.daily_budget_yuan / 86400000;
    // 防御：预算为 0 时 refillRatePerMs=0 → deficit/0=Infinity，返回有限值
    if (!Number.isFinite(refillRatePerMs) || refillRatePerMs <= 0) {
      return 86400000; // 预算耗尽视为等待一天后重试
    }
    return Math.ceil(deficit / refillRatePerMs);
  }
}
