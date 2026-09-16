/**
 * 指标 Repository
 * 详见 docs/17-数据持久化与配置管理.md §17.4.3
 */
import type SqliteDatabase from 'better-sqlite3';

export interface MetricRecord {
  id: number;
  shopId: string | null;
  metricName: string;
  metricValue: number;
  tags: Record<string, string> | null;
  createdAt: number;
}

export interface BulkMetricPoint {
  shopId?: string;
  name: string;
  value: number;
  tags?: Record<string, string>;
  timestamp: number;
}

export class MetricsRepo {
  constructor(private db: SqliteDatabase.Database) {}

  bulkInsert(points: BulkMetricPoint[]): number {
    if (points.length === 0) return 0;
    const stmt = this.db.prepare(
      `INSERT INTO metrics (shop_id, metric_name, metric_value, tags, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    let inserted = 0;
    const tx = this.db.transaction(() => {
      for (const p of points) {
        stmt.run(
          p.shopId ?? null,
          p.name,
          p.value,
          p.tags ? JSON.stringify(p.tags) : null,
          p.timestamp,
        );
        inserted += 1;
      }
    });
    tx();
    return inserted;
  }

  /** 查询指定指标在时间窗口内的总和 */
  sumMetric(metricName: string, sinceMs: number, shopId?: string): number {
    const sql = shopId
      ? `SELECT COALESCE(SUM(metric_value), 0) AS total FROM metrics
         WHERE metric_name = ? AND shop_id = ? AND created_at >= ?`
      : `SELECT COALESCE(SUM(metric_value), 0) AS total FROM metrics
         WHERE metric_name = ? AND created_at >= ?`;
    const params = shopId ? [metricName, shopId, sinceMs] : [metricName, sinceMs];
    const row = this.db.prepare(sql).get(...params) as { total: number };
    return row.total;
  }

  /** 查询指标在时间窗口内的平均值 */
  avgMetric(metricName: string, sinceMs: number, shopId?: string): number {
    const sql = shopId
      ? `SELECT AVG(metric_value) AS avg FROM metrics
         WHERE metric_name = ? AND shop_id = ? AND created_at >= ?`
      : `SELECT AVG(metric_value) AS avg FROM metrics
         WHERE metric_name = ? AND created_at >= ?`;
    const params = shopId ? [metricName, shopId, sinceMs] : [metricName, sinceMs];
    const row = this.db.prepare(sql).get(...params) as { avg: number | null };
    return row.avg ?? 0;
  }

  /** 查询按 tag 分组的指标总和，可限定到单个店铺 */
  sumByTag(
    metricName: string,
    sinceMs: number,
    tagKey: string,
    shopId?: string,
  ): Map<string, number> {
    const sql = shopId
      ? `SELECT tags, SUM(metric_value) AS total FROM metrics
         WHERE metric_name = ? AND shop_id = ? AND created_at >= ? AND tags IS NOT NULL
         GROUP BY tags`
      : `SELECT tags, SUM(metric_value) AS total FROM metrics
         WHERE metric_name = ? AND created_at >= ? AND tags IS NOT NULL
         GROUP BY tags`;
    const params = shopId ? [metricName, shopId, sinceMs] : [metricName, sinceMs];
    const rows = this.db.prepare(sql).all(...params) as Array<{ tags: string; total: number }>;
    const result = new Map<string, number>();
    for (const r of rows) {
      try {
        const tags = JSON.parse(r.tags) as Record<string, string>;
        const tagValue = tags[tagKey];
        if (tagValue) {
          result.set(tagValue, (result.get(tagValue) ?? 0) + r.total);
        }
      } catch {
        // skip invalid tags
      }
    }
    return result;
  }

  /** 清理过期指标 */
  cleanup(olderThanMs: number): number {
    const threshold = Date.now() - olderThanMs;
    return Number(
      this.db.prepare(`DELETE FROM metrics WHERE created_at < ?`).run(threshold).changes,
    );
  }

  /** 按时间桶聚合查询指标数据（用于图表趋势） */
  listBuckets(
    metricName: string,
    sinceMs: number,
    untilMs: number,
    bucketMs: number,
    shopId?: string,
  ): Array<{ bucketStart: number; total: number; count: number }> {
    const sql = shopId
      ? `SELECT FLOOR(created_at / ?) * ? AS bucket, SUM(metric_value) AS total, COUNT(*) AS count
         FROM metrics WHERE metric_name = ? AND shop_id = ? AND created_at >= ? AND created_at <= ?
         GROUP BY bucket ORDER BY bucket ASC`
      : `SELECT FLOOR(created_at / ?) * ? AS bucket, SUM(metric_value) AS total, COUNT(*) AS count
         FROM metrics WHERE metric_name = ? AND created_at >= ? AND created_at <= ?
         GROUP BY bucket ORDER BY bucket ASC`;
    const params = shopId
      ? [bucketMs, bucketMs, metricName, shopId, sinceMs, untilMs]
      : [bucketMs, bucketMs, metricName, sinceMs, untilMs];
    const rows = this.db.prepare(sql).all(...params) as Array<{
      bucket: number;
      total: number;
      count: number;
    }>;
    return rows.map((r) => ({
      bucketStart: r.bucket,
      total: r.total,
      count: r.count,
    }));
  }
}
