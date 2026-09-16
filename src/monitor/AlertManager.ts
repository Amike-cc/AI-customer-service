/**
 * 告警管理器
 * 详见 docs/18-监控与告警.md §18.5 §18.6
 *
 * 职责：
 * - 加载告警规则（内置 + YAML 配置）
 * - 订阅 MetricsCollector 的 flush 事件
 * - 对每个指标点匹配规则，超阈值时触发告警
 * - 告警去重 + 维护期静默 + 自动恢复动作
 */
import { EventEmitter } from 'events';
import type { Config } from '../config/schema';
import type { MetricsCollector, MetricPoint } from './MetricsCollector';
import { FeishuNotifier } from './notifiers/FeishuNotifier';
import type { AppLogger } from '../logging/logger';

export type AlertLevel = 'info' | 'warn' | 'critical';

export interface Alert {
  name: string;
  level: AlertLevel;
  title: string;
  message: string;
  shopId?: string;
  timestamp: number;
}

type Comparator = '>' | '>=' | '<' | '<=' | '==';

export interface AlertRule {
  name: string;
  metric: string;
  threshold: number;
  comparator: Comparator;
  level: AlertLevel;
  title: string;
  messageTemplate: string;
  /** 同一规则同一店铺的去重窗口（毫秒），未设置则使用全局 dedup_window_ms */
  dedupMs?: number;
  /** 触发告警的最小连续次数（默认 1） */
  consecutiveCount?: number;
  /** 自动恢复动作名 */
  recoveryAction?: 'restart_feige' | 'restart_vision' | 'pause_shop' | 'notify_only';
}

interface RuleState {
  consecutiveHits: number;
  lastAlertAt: number;
  recovering: boolean;
}

export interface AlertManagerOptions {
  /** 外部自动恢复动作执行器（由 ShopSupervisor 注入） */
  recoveryExecutor?: (action: AlertRule['recoveryAction'], shopId?: string) => Promise<void>;
}

export class AlertManager extends EventEmitter {
  private feishu: FeishuNotifier | null = null;
  private recentAlerts = new Map<string, number>();
  private rules: AlertRule[] = [];
  private ruleStates = new Map<string, RuleState>();
  private flushHandler: ((points: MetricPoint[]) => void) | null = null;
  private recoveryExecutor: AlertManagerOptions['recoveryExecutor'] | null = null;
  private stopped = false;
  /** 记录当前有 critical 告警活跃的店铺（shopId 或 '' 表示全局），用于自动抑制同店铺的 warn 告警 */
  private criticalActiveShops = new Set<string>();

  constructor(
    private config: Config,
    private metrics: MetricsCollector,
    private logger?: AppLogger,
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.config.monitor.alert.feishu_webhook) {
      this.feishu = new FeishuNotifier(
        this.config.monitor.alert.feishu_webhook,
        this.config.monitor.alert.feishu_secret || undefined,
      );
    }

    this.loadDefaultRules();

    // 订阅指标 flush 事件
    this.flushHandler = (points) => this.evaluatePoints(points);
    this.metrics.on('flush', this.flushHandler);
  }

  setRecoveryExecutor(fn: AlertManagerOptions['recoveryExecutor']): void {
    this.recoveryExecutor = fn;
  }

  /** 加载默认告警规则（基于 docs/18-监控与告警.md §18.5.2） */
  private loadDefaultRules(): void {
    this.rules = [
      {
        name: 'cdp_heartbeat_failure',
        metric: 'cdp_heartbeat_failure_total',
        threshold: 3,
        comparator: '>=',
        level: 'critical',
        title: 'CDP 心跳连续失败',
        messageTemplate: '店铺 {shopId} CDP 心跳连续失败 {value} 次，已超过阈值 {threshold}',
        recoveryAction: 'restart_feige',
        consecutiveCount: 1,
      },
      {
        name: 'visual_mode_persist',
        metric: 'visual_mode_active',
        threshold: 1,
        comparator: '>=',
        level: 'warn',
        title: '视觉模式持续运行',
        messageTemplate: '店铺 {shopId} 视觉模式已持续运行，请检查 CDP 健康状态',
        dedupMs: 1800000,
        recoveryAction: 'notify_only',
      },
      {
        name: 'shop_in_error',
        metric: 'shop_in_error',
        threshold: 1,
        comparator: '>=',
        level: 'critical',
        title: '店铺进入 Error 状态',
        messageTemplate: '店铺 {shopId} 进入 Error 状态，需人工介入',
        recoveryAction: 'pause_shop',
      },
      {
        name: 'api_error_rate_high',
        metric: 'api_call_total',
        threshold: 5,
        comparator: '>=',
        level: 'warn',
        title: 'DeepSeek API 错误率升高',
        messageTemplate: '店铺 {shopId} DeepSeek API 错误次数 {value}，请检查网络或余额',
        dedupMs: 600000,
      },
      {
        name: 'rate_limit_frequent',
        metric: 'rate_limit_rejected_total',
        threshold: 10,
        comparator: '>=',
        level: 'warn',
        title: '限流频繁触发',
        messageTemplate: '店铺 {shopId} 限流触发 {value} 次，请检查是否有异常买家刷单',
        dedupMs: 900000,
      },
      {
        name: 'sensitive_block_high',
        metric: 'sensitive_block_total',
        threshold: 3,
        comparator: '>=',
        level: 'critical',
        title: '敏感词拦截频繁',
        messageTemplate: '店铺 {shopId} 敏感词拦截 {value} 次，请检查 Prompt 模板',
        dedupMs: 1800000,
      },
      {
        name: 'reply_failed_high',
        metric: 'reply_failed_total',
        threshold: 3,
        comparator: '>=',
        level: 'critical',
        title: '回复失败率高',
        messageTemplate: '店铺 {shopId} 回复失败 {value} 次，CDP 或客户端可能异常',
        recoveryAction: 'restart_feige',
        dedupMs: 600000,
      },
      {
        name: 'vision_service_exit',
        metric: 'vision_service_exit_total',
        threshold: 3,
        comparator: '>=',
        level: 'critical',
        title: '视觉服务异常退出',
        messageTemplate: '视觉服务退出 {value} 次，将触发自动重启',
        recoveryAction: 'restart_vision',
        dedupMs: 600000,
      },
    ];
  }

  /** 评估一批指标点 */
  private evaluatePoints(points: MetricPoint[]): void {
    if (this.stopped) return;
    // 按规则名+店铺聚合
    const aggregated = new Map<string, { rule: AlertRule; shopId?: string; value: number }>();

    for (const p of points) {
      for (const rule of this.rules) {
        if (p.name !== rule.metric) continue;
        if (rule.metric === 'api_call_total') {
          // 特殊处理：只统计 status=error 的 API 调用
          if (p.tags?.status && p.tags.status !== 'ok' && p.tags.status !== 'cached') {
            this.aggregate(aggregated, rule, p.shopId, p.value);
          }
        } else {
          this.aggregate(aggregated, rule, p.shopId, p.value);
        }
      }
    }

    for (const [, { rule, shopId, value }] of aggregated) {
      this.evaluateRule(rule, value, shopId);
    }
  }

  private aggregate(
    aggregated: Map<string, { rule: AlertRule; shopId?: string; value: number }>,
    rule: AlertRule,
    shopId: string | undefined,
    value: number,
  ): void {
    const key = `${rule.name}:${shopId ?? ''}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.value += value;
    } else {
      aggregated.set(key, { rule, shopId, value });
    }
  }

  private evaluateRule(rule: AlertRule, value: number, shopId?: string): void {
    const stateKey = `${rule.name}:${shopId ?? ''}`;
    const state = this.ruleStates.get(stateKey) ?? { consecutiveHits: 0, lastAlertAt: 0, recovering: false };
    const shopKey = shopId ?? '';

    if (this.matchCondition(value, rule.threshold, rule.comparator)) {
      state.consecutiveHits += 1;
      const required = rule.consecutiveCount ?? 1;
      if (state.consecutiveHits >= required) {
        // critical 触发后 warn 自动抑制：同店铺有 critical 活跃时，跳过 warn 告警
        if (rule.level === 'warn' && this.criticalActiveShops.has(shopKey)) {
          this.logger?.debug(
            { rule: rule.name, shopId, activeCriticals: Array.from(this.criticalActiveShops) },
            'warn 告警被 critical 抑制',
          );
          this.ruleStates.set(stateKey, state);
          return;
        }
        // critical 告警触发时，记录活跃店铺用于抑制后续 warn
        if (rule.level === 'critical') {
          this.criticalActiveShops.add(shopKey);
        }
        void this.fireRule(rule, value, shopId, state);
      }
    } else {
      if (state.consecutiveHits > 0) {
        state.consecutiveHits = 0;
        if (state.recovering) {
          state.recovering = false;
          this.emit('recovered', { rule: rule.name, shopId });
          // critical 告警恢复时，清除该店铺的 critical 活跃标记，解除 warn 抑制
          if (rule.level === 'critical') {
            this.criticalActiveShops.delete(shopKey);
            this.logger?.info({ rule: rule.name, shopId }, 'critical 已恢复，解除 warn 抑制');
          }
        }
      }
    }
    this.ruleStates.set(stateKey, state);
  }

  private matchCondition(value: number, threshold: number, cmp: Comparator): boolean {
    switch (cmp) {
      case '>':
        return value > threshold;
      case '>=':
        return value >= threshold;
      case '<':
        return value < threshold;
      case '<=':
        return value <= threshold;
      case '==':
        return value === threshold;
    }
  }

  private async fireRule(rule: AlertRule, value: number, shopId: string | undefined, state: RuleState): Promise<void> {
    const dedupMs = rule.dedupMs ?? this.config.monitor.alert.dedup_window_ms;
    if (state.lastAlertAt && Date.now() - state.lastAlertAt < dedupMs) {
      return;
    }
    state.lastAlertAt = Date.now();
    state.recovering = true;

    const message = rule.messageTemplate
      .replace('{shopId}', shopId ?? '全局')
      .replace('{value}', String(value))
      .replace('{threshold}', String(rule.threshold));

    const alert: Omit<Alert, 'timestamp'> = {
      name: rule.name,
      level: rule.level,
      title: rule.title,
      message,
      shopId,
    };

    await this.fire(alert, dedupMs);

    // 触发自动恢复动作
    if (rule.recoveryAction && rule.recoveryAction !== 'notify_only' && this.recoveryExecutor) {
      try {
        await this.recoveryExecutor(rule.recoveryAction, shopId);
        this.logger?.info({ rule: rule.name, action: rule.recoveryAction, shopId }, '已触发自动恢复动作');
      } catch (err) {
        this.logger?.error({ rule: rule.name, action: rule.recoveryAction, err }, '自动恢复动作失败');
      }
    }
  }

  /** 主动触发告警（外部 API，供 ShopSupervisor 等调用） */
  async fire(alert: Omit<Alert, 'timestamp'>, dedupMsOverride?: number): Promise<void> {
    const fullAlert: Alert = { ...alert, timestamp: Date.now() };

    const key = `${alert.name}:${alert.shopId ?? ''}`;
    const lastTime = this.recentAlerts.get(key);
    // 优先使用调用方传入的去重窗口（规则自定义 dedupMs），避免被全局窗口覆盖导致规则去重失效
    const dedupMs = dedupMsOverride ?? this.config.monitor.alert.dedup_window_ms;
    if (lastTime && Date.now() - lastTime < dedupMs) {
      return;
    }
    this.recentAlerts.set(key, Date.now());

    if (this.isInMaintenance(fullAlert.level)) {
      return;
    }

    this.emit('alert', fullAlert);
    this.logger?.warn({ name: alert.name, level: alert.level, shopId: alert.shopId, title: alert.title }, '告警触发');

    if (this.feishu) {
      try {
        await this.feishu.send(alert.level, alert.title, alert.message);
      } catch (err) {
        this.logger?.error({ err, alert: alert.name }, '告警发送失败');
      }
    }
  }

  private isInMaintenance(level: AlertLevel): boolean {
    if (level === 'critical') return false;
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    for (const w of this.config.monitor.alert.maintenance_windows) {
      if (hhmm >= w.start && hhmm < w.end && level === w.level) {
        return true;
      }
    }
    return false;
  }

  /** 手动添加规则（运行时动态添加） */
  addRule(rule: AlertRule): void {
    this.rules.push(rule);
  }

  /** 清除所有规则状态（用于店铺重启后重置告警状态） */
  resetShopState(shopId: string): void {
    for (const key of Array.from(this.ruleStates.keys())) {
      if (key.endsWith(`:${shopId}`)) {
        this.ruleStates.delete(key);
      }
    }
    for (const key of Array.from(this.recentAlerts.keys())) {
      if (key.endsWith(`:${shopId}`)) {
        this.recentAlerts.delete(key);
      }
    }
    this.criticalActiveShops.delete(shopId);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.flushHandler) {
      this.metrics.off('flush', this.flushHandler);
      this.flushHandler = null;
    }
    this.removeAllListeners();
  }
}
