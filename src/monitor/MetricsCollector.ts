/**
 * 指标采集器
 * 详见 docs/18-监控与告警.md §18.4
 */
import { EventEmitter } from 'events';
import type { Config } from '../config/schema';
import type { Database } from '../db/Database';

export interface MetricPoint {
  shopId?: string;
  name: string;
  value: number;
  tags?: Record<string, string>;
  timestamp: number;
}

export class MetricsCollector extends EventEmitter {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, number[]>();
  private flushTimer: NodeJS.Timeout;

  constructor(private config: Config, private db: Database) {
    super();
    this.flushTimer = setInterval(
      () => void this.flush(),
      config.monitor.metrics_flush_interval_ms,
    );
    this.flushTimer.unref?.();
  }

  inc(name: string, value = 1, tags?: Record<string, string>, shopId?: string): void {
    const key = this.key(name, tags, shopId);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  set(name: string, value: number, tags?: Record<string, string>, shopId?: string): void {
    const key = this.key(name, tags, shopId);
    this.gauges.set(key, value);
  }

  observe(name: string, value: number, tags?: Record<string, string>, shopId?: string): void {
    const key = this.key(name, tags, shopId);
    if (!this.histograms.has(key)) this.histograms.set(key, []);
    const arr = this.histograms.get(key)!;
    arr.push(value);
    if (arr.length > 1000) arr.shift();
  }

  private key(name: string, tags?: Record<string, string>, shopId?: string): string {
    return [name, shopId ?? '', tags ? JSON.stringify(tags) : ''].join('|');
  }

  private async flush(): Promise<void> {
    const points: MetricPoint[] = [];
    const now = Date.now();

    // key 格式 name|shopId|tagsJson——tagsJson 内部可能含 |（错误信息等），
    // 必须从第 3 段起拼接，否则指标名被截断、tags 解析失败
    const parseKey = (key: string): { name: string; shopId?: string; tags?: Record<string, string> } => {
      const parts = key.split('|');
      const name = parts[0];
      const shopId = parts[1] || undefined;
      const tagsStr = parts.slice(2).join('|');
      if (!tagsStr) return { name, shopId };
      try {
        return { name, shopId, tags: JSON.parse(tagsStr) as Record<string, string> };
      } catch {
        return { name, shopId };
      }
    };

    for (const [key, value] of this.counters.entries()) {
      const { name, shopId, tags } = parseKey(key);
      points.push({
        name,
        shopId,
        value,
        tags,
        timestamp: now,
      });
    }

    for (const [key, value] of this.gauges.entries()) {
      const { name, shopId, tags } = parseKey(key);
      points.push({
        name,
        shopId,
        value,
        tags,
        timestamp: now,
      });
    }

    for (const [key, values] of this.histograms.entries()) {
      if (values.length === 0) continue;
      const { name, shopId, tags } = parseKey(key);
      const sorted = [...values].sort((a, b) => a - b);
      const sum = sorted.reduce((s, v) => s + v, 0);
      const stats: Record<string, number> = {
        count: sorted.length,
        avg: Math.round((sum / sorted.length) * 100) / 100,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        p50: sorted[Math.floor(sorted.length * 0.5)],
        p95: sorted[Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1)],
        p99: sorted[Math.min(Math.floor(sorted.length * 0.99), sorted.length - 1)],
      };
      for (const [stat, val] of Object.entries(stats)) {
        points.push({
          name: `${name}_${stat}`,
          shopId,
          value: val,
          tags,
          timestamp: now,
        });
      }
    }

    if (points.length === 0) return;

    const stmt = this.db.prepare(
      'INSERT INTO metrics (shop_id, metric_name, metric_value, tags, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    // 先开启事务；清空缓冲仅在 COMMIT 成功后执行，INSERT 抛错时数据保留在内存中以待下次回灌
    try {
      this.db.prepare('BEGIN').run();
    } catch (err) {
      // 无监听器的 'error' 事件会抛异常导致进程崩溃，这里只记录到 stderr
      console.error('[MetricsCollector] 指标事务开启失败，本次刷新跳过:', err);
      return;
    }
    try {
      for (const p of points) {
        stmt.run(p.shopId ?? null, p.name, p.value, p.tags ? JSON.stringify(p.tags) : null, p.timestamp);
      }
      this.db.prepare('COMMIT').run();
    } catch (err) {
      // ROLLBACK 自身可能抛错，单独包裹避免进程崩溃
      try {
        this.db.prepare('ROLLBACK').run();
      } catch {
        // 忽略 ROLLBACK 失败
      }
      console.error('[MetricsCollector] 指标写入失败，缓冲保留待下次回灌:', err);
      // 不清除 counters/gauges/histograms，下一轮 flush 重试（回灌），避免指标永久丢失
      return;
    }

    // 事务成功后才清空缓冲
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();

    this.emit('flush', points);
  }

  async stop(): Promise<void> {
    clearInterval(this.flushTimer);
    await this.flush();
  }
}
