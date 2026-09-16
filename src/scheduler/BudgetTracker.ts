/**
 * 成本预算追踪器
 * 维护每店铺、全局的日/月成本记录
 * 在日切时自动重置日成本
 *
 * 持久化：成本状态写入 data/state/budget.json，
 * 进程重启后恢复当日累计，防止用户通过重启绕过每日成本上限
 */
import fs from 'fs-extra';
import path from 'path';
import type { CostRecord, ShopPriority } from './types';
import type { Config } from '../config/schema';

interface ShopBudget {
  shopId: string;
  dailyCost: number;
  monthlyCost: number;
  dailyDate: string;
  priority: ShopPriority;
}

interface PersistedBudget {
  date: string;
  month: string;
  globalDailyCost: number;
  globalMonthlyCost: number;
  shops: Record<string, ShopBudget>;
}

export class BudgetTracker {
  private shops = new Map<string, ShopBudget>();
  private globalDailyCost = 0;
  private globalMonthlyCost = 0;
  private currentDate = this.todayString();
  private currentMonth = this.monthString();
  private config: Config;
  private readonly persistPath: string | null;

  constructor(config: Config, persistPath?: string | null) {
    this.config = config;
    const dataDir = (config as { app?: { data_dir?: string } }).app?.data_dir;
    // 注意：不能用 `persistPath ?? default`——null 会落入默认路径；显式 null 表示禁用持久化
    this.persistPath = persistPath !== undefined
      ? persistPath
      : (dataDir ? path.join(dataDir, 'state', 'budget.json') : null);
    this.loadPersisted();
  }

  record(record: CostRecord): void {
    this.checkDayRollover();
    const shop = this.getOrCreateShop(record.shopId);
    shop.dailyCost += record.costYuan;
    shop.monthlyCost += record.costYuan;
    this.globalDailyCost += record.costYuan;
    this.globalMonthlyCost += record.costYuan;
    this.persist();
  }

  getDailyCost(shopId: string): number {
    this.checkDayRollover();
    return this.getOrCreateShop(shopId).dailyCost;
  }

  getGlobalDailyCost(): number {
    this.checkDayRollover();
    return this.globalDailyCost;
  }

  getGlobalMonthlyCost(): number {
    this.checkDayRollover();
    return this.globalMonthlyCost;
  }

  isShopOverBudget(shopId: string): boolean {
    this.checkDayRollover();
    const shop = this.getOrCreateShop(shopId);
    return shop.dailyCost >= this.getShopDailyLimit(shopId);
  }

  isGlobalOverBudget(): boolean {
    this.checkDayRollover();
    return this.globalDailyCost >= this.config.scheduler.budget.global_daily_yuan;
  }

  isGlobalMonthlyOverBudget(): boolean {
    this.checkDayRollover();
    return this.globalMonthlyCost >= this.config.scheduler.budget.global_monthly_yuan;
  }

  getShopDailyLimit(shopId: string): number {
    const shop = this.getOrCreateShop(shopId);
    const base = this.config.scheduler.budget.per_shop_daily_yuan;
    switch (shop.priority) {
      case 'high':
        return base * 2;
      case 'normal':
        return base;
      case 'low':
        return base * 0.5;
    }
  }

  setShopPriority(shopId: string, priority: ShopPriority): void {
    this.getOrCreateShop(shopId).priority = priority;
    this.persist();
  }

  getShopPriority(shopId: string): ShopPriority {
    return this.getOrCreateShop(shopId).priority;
  }

  /** 从磁盘恢复当日累计成本（跨进程重启保持预算约束） */
  private loadPersisted(): void {
    if (!this.persistPath) return;
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const data = fs.readJsonSync(this.persistPath) as PersistedBudget;
      // 日累计只在同一天恢复；月累计在同一个月内跨天、跨进程继续恢复。
      if (data.month === this.currentMonth) {
        const sameDay = data.date === this.currentDate;
        this.globalDailyCost = sameDay ? Number(data.globalDailyCost) || 0 : 0;
        this.globalMonthlyCost = Number(data.globalMonthlyCost) || 0;
        for (const [shopId, shop] of Object.entries(data.shops ?? {})) {
          if (!shop || typeof shop !== 'object') continue;
          this.shops.set(shopId, {
            shopId,
            dailyCost: sameDay && Number.isFinite(shop.dailyCost) ? shop.dailyCost : 0,
            monthlyCost: Number.isFinite(shop.monthlyCost) ? shop.monthlyCost : 0,
            dailyDate: sameDay ? shop.dailyDate ?? this.currentDate : this.currentDate,
            priority: shop.priority ?? this.config.scheduler.default_priority,
          });
        }
      }
    } catch (err) {
      // 状态文件损坏时忽略，从零开始（成本上限失效仅一个周期，可接受）
      console.warn('[BudgetTracker] 恢复预算状态失败:', err instanceof Error ? err.message : String(err));
    }
  }

  /** 同步落盘（文件 <1KB，调用频率 = API 调用频率，可接受） */
  private persist(): void {
    if (!this.persistPath) return;
    try {
      fs.ensureDirSync(path.dirname(this.persistPath));
      const data: PersistedBudget = {
        date: this.currentDate,
        month: this.currentMonth,
        globalDailyCost: this.globalDailyCost,
        globalMonthlyCost: this.globalMonthlyCost,
        shops: Object.fromEntries(this.shops.entries()),
      };
      fs.writeJsonSync(this.persistPath, data, { spaces: 2 });
    } catch (err) {
      // 持久化失败不影响主流程（预算仍按内存值约束）
      console.warn('[BudgetTracker] 持久化预算状态失败:', err instanceof Error ? err.message : String(err));
    }
  }

  private checkDayRollover(): void {
    const today = this.todayString();
    if (today !== this.currentDate) {
      this.currentDate = today;
      for (const shop of this.shops.values()) {
        shop.dailyCost = 0;
        shop.dailyDate = today;
      }
      this.globalDailyCost = 0;
    }
    const month = this.monthString();
    if (month !== this.currentMonth) {
      this.currentMonth = month;
      for (const shop of this.shops.values()) {
        shop.monthlyCost = 0;
      }
      this.globalMonthlyCost = 0;
    }
  }

  private getOrCreateShop(shopId: string): ShopBudget {
    if (!this.shops.has(shopId)) {
      this.shops.set(shopId, {
        shopId,
        dailyCost: 0,
        monthlyCost: 0,
        dailyDate: this.currentDate,
        priority: this.config.scheduler.default_priority,
      });
    }
    return this.shops.get(shopId)!;
  }

  private todayString(): string {
    // 本地时区日期：此前用 toISOString()（UTC），中国时区下预算在本地 08:00 才重置，
    // 与限流窗口（本地时区）错位
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  private monthString(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  updateConfig(config: Config): void {
    this.config = config;
  }
}
