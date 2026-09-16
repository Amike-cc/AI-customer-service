/**
 * 工作时间策略
 *
 * 工作时间外收到买家消息时，自动回复预设话术并暂存消息，
 * 次日工作时间开始时按 FIFO 顺序自动续处理。
 *
 * 配置项见 config/schema.ts 的 work_time 段。
 */
import type { AppLogger } from '../logging/logger';
import type { Config } from '../config/schema';
import type { PendingMessageRepo } from '../db/repos/PendingMessageRepo';

export interface WorkTimeConfig {
  enabled: boolean;
  /** 时区，如 Asia/Shanghai */
  timezone: string;
  /** 工作日，1=周一 ... 7=周日 */
  workDays: number[];
  /** 工作开始时间 HH:mm */
  workStart: string;
  /** 工作结束时间 HH:mm */
  workEnd: string;
  /** 非工作时间自动回复话术，支持 {start}/{end} 占位符 */
  offHoursReply: string;
  /** 暂存消息批量处理大小 */
  pendingProcessBatchSize: number;
  /** 暂存消息处理间隔（毫秒） */
  pendingProcessIntervalMs: number;
}

/** 暂存消息处理回调类型：由 ShopInstance 提供，调用其内部 generateReply 流程 */
export type PendingMessageProcessor = (msg: {
  shopId: string;
  sessionId: string;
  buyerName: string;
  messageText: string;
  receivedAt: number;
}) => Promise<void>;

interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export class WorkTimePolicy {
  private config: WorkTimeConfig;
  private pendingTimers = new Map<string, NodeJS.Timeout>();
  private processors = new Map<string, PendingMessageProcessor>();
  private drainingShops = new Set<string>();

  constructor(
    config: WorkTimeConfig,
    private logger: AppLogger,
    private pendingRepo?: PendingMessageRepo,
  ) {
    this.config = config;
  }

  /** 配置热重载 */
  updateConfig(config: WorkTimeConfig): void {
    const wasEnabled = this.config.enabled;
    this.config = config;
    if (!config.enabled && wasEnabled) {
      // 关闭时清理定时器
      this.stopPendingTimer();
    } else if (config.enabled) {
      // 启用状态或排班参数变化后，按新配置重新调度全部店铺。
      for (const shopId of this.processors.keys()) {
        this.scheduleNextRun(shopId);
      }
    }
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * 将时间转换为配置时区下的"本地时刻"（分钟）
   * 解决跨时区部署（本机非配置时区）时上下班判断错误的问题
   */
  private getValidTimeZone(): string | null {
    const tz = this.config.timezone || 'Asia/Shanghai';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
      return tz;
    } catch {
      return null;
    }
  }

  private getZonedParts(now: Date): ZonedDateParts {
    const tz = this.getValidTimeZone();
    if (!tz) {
      return {
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        day: now.getDate(),
        hour: now.getHours(),
        minute: now.getMinutes(),
      };
    }
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(now);
    const values: Record<string, number> = {};
    for (const part of parts) {
      if (part.type !== 'literal') values[part.type] = Number(part.value);
    }
    return {
      year: values.year,
      month: values.month,
      day: values.day,
      hour: values.hour % 24,
      minute: values.minute,
    };
  }

  private configDay(year: number, month: number, day: number, offsetDays = 0): number {
    const jsDay = new Date(Date.UTC(year, month - 1, day + offsetDays)).getUTCDay();
    return jsDay === 0 ? 7 : jsDay;
  }

  /** 将配置时区中的本地年月日时分转换为绝对时间。 */
  private zonedLocalToEpoch(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
  ): number {
    const tz = this.getValidTimeZone();
    if (!tz) return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();

    const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    let epoch = desiredAsUtc;
    // 时区偏移可能因 DST 改变，迭代收敛到目标墙上时间。
    for (let i = 0; i < 4; i++) {
      const actual = this.getZonedParts(new Date(epoch));
      const actualAsUtc = Date.UTC(
        actual.year,
        actual.month - 1,
        actual.day,
        actual.hour,
        actual.minute,
        0,
        0,
      );
      const correction = desiredAsUtc - actualAsUtc;
      if (correction === 0) break;
      epoch += correction;
    }
    return epoch;
  }

  /**
   * 判断当前是否处于工作时间。
   *
   * @param now 当前时间（用于测试注入）
   */
  isWorkingNow(now: Date = new Date()): boolean {
    if (!this.config.enabled) return true; // 未启用时视为始终工作时间
    const zoned = this.getZonedParts(now);
    const currentMinutes = zoned.hour * 60 + zoned.minute;
    const startMinutes = this.parseTime(this.config.workStart);
    const endMinutes = this.parseTime(this.config.workEnd);
    // 支持跨天班次（如 22:00-08:00 夜班）：end < start 时按"跨越午夜"处理
    if (endMinutes < startMinutes) {
      const workDay = currentMinutes < endMinutes
        ? this.configDay(zoned.year, zoned.month, zoned.day, -1)
        : this.configDay(zoned.year, zoned.month, zoned.day);
      return this.config.workDays.includes(workDay) &&
        (currentMinutes >= startMinutes || currentMinutes < endMinutes);
    }
    const workDay = this.configDay(zoned.year, zoned.month, zoned.day);
    return this.config.workDays.includes(workDay) &&
      currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  /**
   * 计算距离下一次工作时间开始的毫秒数。
   * 若当前在工作时间内，返回 0。
   */
  msUntilNextWorkStart(now: Date = new Date()): number {
    if (this.isWorkingNow(now)) return 0;

    const startMinutes = this.parseTime(this.config.workStart);
    const oneDayMs = 24 * 60 * 60 * 1000;
    const zonedNow = this.getZonedParts(now);

    // 在配置时区的日历上逐日探测，避免使用宿主机时区 setHours。
    for (let offsetDays = 0; offsetDays <= 7; offsetDays++) {
      const calendarDate = new Date(Date.UTC(
        zonedNow.year,
        zonedNow.month - 1,
        zonedNow.day + offsetDays,
      ));
      const year = calendarDate.getUTCFullYear();
      const month = calendarDate.getUTCMonth() + 1;
      const day = calendarDate.getUTCDate();
      if (!this.config.workDays.includes(this.configDay(year, month, day))) continue;

      const targetEpoch = this.zonedLocalToEpoch(
        year,
        month,
        day,
        Math.floor(startMinutes / 60),
        startMinutes % 60,
      );
      if (targetEpoch <= now.getTime()) continue;
      return targetEpoch - now.getTime();
    }
    // 极端情况：工作日为空，返回 1 天作为兜底
    return oneDayMs;
  }

  /** 构造非工作时间自动回复内容 */
  buildOffHoursReply(): string {
    return this.config.offHoursReply
      .replace(/\{start\}/g, this.config.workStart)
      .replace(/\{end\}/g, this.config.workEnd);
  }

  /**
   * 注册暂存消息处理器并启动定时器。
   * 在 ShopInstance.start 中调用。
   */
  registerProcessor(shopId: string, processor: PendingMessageProcessor): void {
    this.processors.set(shopId, processor);
    if (this.config.enabled) {
      this.scheduleNextRun(shopId);
    }
  }

  /** 注销某店铺的处理器并停止其定时器（店铺停止时调用） */
  unregisterProcessor(shopId: string): void {
    this.processors.delete(shopId);
    const timer = this.pendingTimers.get(shopId);
    if (timer) {
      clearTimeout(timer);
      this.pendingTimers.delete(shopId);
    }
  }

  /**
   * 触发一次暂存消息处理（可被外部定时调度）。
   * 内部会限制并发，避免重复处理。
   */
  async drainPendingMessages(repo: PendingMessageRepo): Promise<void> {
    if (this.processors.size === 0) {
      this.logger.warn('WorkTimePolicy.drainPendingMessages: 未注册处理器，跳过');
      return;
    }
    for (const [shopId, processor] of this.processors) {
      await this.drainShopLocked(repo, shopId, processor);
    }
  }

  private async drainShopLocked(
    repo: PendingMessageRepo,
    shopId: string,
    processor: PendingMessageProcessor,
  ): Promise<void> {
    if (this.drainingShops.has(shopId)) return;
    this.drainingShops.add(shopId);
    try {
      await this.drainShop(repo, shopId, processor);
    } finally {
      this.drainingShops.delete(shopId);
    }
  }

  private async drainShop(
    repo: PendingMessageRepo,
    shopId: string,
    processor: PendingMessageProcessor,
  ): Promise<void> {
    const batchSize = this.config.pendingProcessBatchSize;
    const pending = repo.listPending(shopId, batchSize);
    if (pending.length === 0) return;

    this.logger.info({ shopId, count: pending.length }, '开始处理非工作时间暂存消息');
    let processed = 0;
    for (const msg of pending) {
      try {
        await processor({
          shopId: msg.shopId,
          sessionId: msg.sessionId,
          buyerName: msg.buyerName,
          messageText: msg.messageText,
          receivedAt: msg.receivedAt,
        });
        repo.markProcessed(msg.id);
        processed++;
      } catch (err) {
        this.logger.error(
          { err, msgId: msg.id, shopId, sessionId: msg.sessionId },
          '处理暂存消息失败，保留待下次重试',
        );
        // 单条失败不阻塞后续处理，但保留未处理状态
      }
    }
    this.logger.info({ shopId, processed, failed: pending.length - processed }, '非工作时间暂存消息处理完成');
  }

  /** 停止全部定时器（ShopInstance.stop 调用） */
  stopPendingTimer(): void {
    for (const timer of this.pendingTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
  }

  private scheduleNextRun(shopId: string): void {
    if (!this.config.enabled) return;
    const existing = this.pendingTimers.get(shopId);
    if (existing) {
      clearTimeout(existing);
    }
    const ms = this.msUntilNextWorkStart();
    if (ms <= 0) {
      const hasPending = (this.pendingRepo?.countPending(shopId) ?? 0) > 0;
      const delay = hasPending ? 0 : 60 * 60 * 1000;
      this.pendingTimers.set(shopId, setTimeout(() => void this.onTimerTick(shopId), delay));
    } else {
      // 等待到工作时间开始
      this.pendingTimers.set(shopId, setTimeout(() => void this.onTimerTick(shopId), ms));
    }
  }

  private async onTimerTick(shopId: string): Promise<void> {
    if (!this.config.enabled) return;
    if (this.isWorkingNow()) {
      const processor = this.processors.get(shopId);
      if (this.pendingRepo && processor) {
        await this.drainShopLocked(this.pendingRepo, shopId, processor);
        if (this.pendingRepo.countPending(shopId) > 0) {
          this.pendingTimers.set(
            shopId,
            setTimeout(() => void this.onTimerTick(shopId), this.config.pendingProcessIntervalMs),
          );
          return;
        }
      } else if (!this.pendingRepo) {
        this.logger.warn({ shopId }, '缺少 PendingMessageRepo，无法处理暂存消息');
      }
    }
    // 重新调度
    this.scheduleNextRun(shopId);
  }

  private parseTime(hhmm: string): number {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (!m) {
      this.logger.warn({ hhmm }, '工作时间配置格式错误，使用默认 09:00');
      return 9 * 60;
    }
    const h = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (h < 0 || h > 23 || mm < 0 || mm > 59) {
      this.logger.warn({ hhmm }, '工作时间配置越界，使用默认 09:00');
      return 9 * 60;
    }
    return h * 60 + mm;
  }
}

/** 从全局 Config 提取 WorkTimeConfig */
export function getWorkTimeConfig(config: Config): WorkTimeConfig {
  const wt = config.work_time;
  return {
    enabled: wt?.enabled ?? false,
    timezone: wt?.timezone ?? 'Asia/Shanghai',
    workDays: wt?.workDays ?? [1, 2, 3, 4, 5],
    workStart: wt?.workStart ?? '09:00',
    workEnd: wt?.workEnd ?? '18:00',
    offHoursReply: wt?.offHoursReply ?? '亲，当前是非工作时间，我们会暂存您的消息，工作时间会第一时间为您处理~',
    pendingProcessBatchSize: wt?.pendingProcessBatchSize ?? 10,
    pendingProcessIntervalMs: wt?.pendingProcessIntervalMs ?? 30000,
  };
}
