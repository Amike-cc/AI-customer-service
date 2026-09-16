/**
 * 故障注入测试：告警去重 + critical 抑制 warn
 *
 * 覆盖场景：
 * - C-10: 同店铺先 critical 后 warn → warn 被抑制；critical 恢复后 warn 可再触发
 *
 * 对应文档：docs/开发文档-综合版.md 第 12.4 节、第 18 章监控与告警
 */
import { MetricsCollector, type MetricPoint } from '@/monitor/MetricsCollector';
import { AlertManager } from '@/monitor/AlertManager';
import { createTestConfig } from '../unit/helpers/testConfig';

describe('Chaos: 告警抑制与去重', () => {
  let metrics: MetricsCollector;
  let alertManager: AlertManager;

  beforeEach(() => {
    const db = {
      prepare: jest.fn().mockReturnValue({
        run: jest.fn(),
        all: jest.fn().mockReturnValue([]),
        get: jest.fn().mockReturnValue(undefined),
      }),
    };
    const config = createTestConfig({
      monitor: {
        metrics_flush_interval_ms: 999999,
        metrics_retention_days: 7,
        alert: {
          feishu_webhook: '',
          feishu_secret: '',
          sms_access_key: '',
          sms_access_secret: '',
          sms_phone_numbers: [],
          dedup_window_ms: 100,
          maintenance_windows: [],
        },
      },
    });
    metrics = new MetricsCollector(config, db as any);
    alertManager = new AlertManager(config, metrics);
  });

  afterEach(async () => {
    await alertManager.stop();
  });

  it('C-10: critical 活跃期间同店铺 warn 被自动抑制', async () => {
    await alertManager.start();
    const alerts: any[] = [];
    alertManager.on('alert', (a) => alerts.push(a));

    // 1. 触发 critical（shop_in_error）
    metrics.emit('flush', [
      { name: 'shop_in_error', value: 1, shopId: 'shop-chaos-10', timestamp: Date.now() },
    ] as MetricPoint[]);
    await new Promise((r) => setTimeout(r, 50));
    expect(alerts.some((a) => a.name === 'shop_in_error' && a.level === 'critical')).toBe(true);

    // 2. 同店铺触发 warn（api_error_rate_high）— 应被抑制
    metrics.emit('flush', [
      { name: 'api_call_total', value: 10, shopId: 'shop-chaos-10', timestamp: Date.now(), tags: { status: 'error' } },
    ] as MetricPoint[]);
    await new Promise((r) => setTimeout(r, 50));
    expect(alerts.some((a) => a.name === 'api_error_rate_high' && a.shopId === 'shop-chaos-10')).toBe(false);

    // 3. critical 恢复
    metrics.emit('flush', [
      { name: 'shop_in_error', value: 0, shopId: 'shop-chaos-10', timestamp: Date.now() },
    ] as MetricPoint[]);
    await new Promise((r) => setTimeout(r, 50));

    // 4. 重置店铺状态后，warn 应能再次触发
    alertManager.resetShopState('shop-chaos-10');
    metrics.emit('flush', [
      { name: 'api_call_total', value: 10, shopId: 'shop-chaos-10', timestamp: Date.now(), tags: { status: 'error' } },
    ] as MetricPoint[]);
    await new Promise((r) => setTimeout(r, 50));
    expect(alerts.some((a) => a.name === 'api_error_rate_high' && a.shopId === 'shop-chaos-10')).toBe(true);
  });
});
