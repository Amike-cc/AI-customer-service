/**
 * 资源调度器公共类型定义
 */

export type ModelTier = 'tier1' | 'tier2' | 'tier3';
export type ShopPriority = 'high' | 'normal' | 'low';

export interface ScheduleRequest {
  shopId: string;
  estimatedTokens: number;
  estimatedCostYuan: number;
  /** 各层级按实际 Provider 定价计算的预计费用，供降级时准确预留。 */
  estimatedCostByTier?: Partial<Record<ModelTier, number>>;
  tier: ModelTier;
  shopPriority?: ShopPriority;
}

export interface ScheduleDecision {
  allowed: boolean;
  allocatedTier: ModelTier;
  rejectReason?:
    | 'global_daily_budget_exceeded'
    | 'global_monthly_budget_exceeded'
    | 'shop_daily_budget_exceeded'
    | 'insufficient_budget';
  waitMs?: number;
  /** 预算预留标识；Provider 完成或失败后必须结算/释放。 */
  reservationId?: string;
  reservedCostYuan?: number;
}

export interface CostRecord {
  shopId: string;
  costYuan: number;
  tokens: number;
  timestamp: number;
  tier: ModelTier;
  provider: string;
}
