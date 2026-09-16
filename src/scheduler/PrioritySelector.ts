/**
 * 店铺优先级调度器
 * 根据店铺等级决定资源分配优先级
 */
import type { ShopPriority } from './types';
import type { Config } from '../config/schema';

export class PrioritySelector {
  private shopPriorities = new Map<string, ShopPriority>();
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  getPriority(shopId: string): ShopPriority {
    return this.shopPriorities.get(shopId) ?? this.config.scheduler.default_priority;
  }

  setPriority(shopId: string, priority: ShopPriority): void {
    this.shopPriorities.set(shopId, priority);
  }

  selectForDegrade(shopIds: string[], budgetRatio: number): string[] {
    const sorted = [...shopIds].sort((a, b) => {
      return this.priorityWeight(this.getPriority(a)) - this.priorityWeight(this.getPriority(b));
    });
    const degradeCount = Math.max(1, Math.ceil(shopIds.length * (1 - budgetRatio)));
    return sorted.slice(0, degradeCount);
  }

  private priorityWeight(p: ShopPriority): number {
    switch (p) {
      case 'high':
        return 3;
      case 'normal':
        return 2;
      case 'low':
        return 1;
    }
  }

  updateConfig(config: Config): void {
    this.config = config;
  }
}
