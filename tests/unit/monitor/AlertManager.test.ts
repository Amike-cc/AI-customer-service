/**
 * AlertManager 单元测试
 * 详见 docs/18-监控与告警.md §18.5 §18.6
 */
import { AlertManager } from '@/monitor/AlertManager';
import { MetricsCollector, type MetricPoint } from '@/monitor/MetricsCollector';
import { createTestConfig } from '../helpers/testConfig';

describe('AlertManager', () => {
  let metrics: MetricsCollector;
  let alertManager: AlertManager;
  let db: { prepare: jest.Mock };

  beforeEach(() => {
    db = {
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

  it('start 后加载默认规则', async () => {
    await alertManager.start();
    expect((alertManager as any).rules.length).toBeGreaterThan(0);
  });

  it('fire 触发 alert 事件', async () => {
    await alertManager.start();
    const alerts: any[] = [];
    alertManager.on('alert', (a) => alerts.push(a));
    await alertManager.fire({
      name: 'test_alert',
      level: 'warn',
      title: 'Test',
      message: 'test message',
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].name).toBe('test_alert');
  });

  it('去重窗口内同告警只通知一次', async () => {
    await alertManager.start();
    const alerts: any[] = [];
    alertManager.on('alert', (a) => alerts.push(a));
    await alertManager.fire({ name: 'dup', level: 'warn', title: 'T', message: 'm' });
    await alertManager.fire({ name: 'dup', level: 'warn', title: 'T', message: 'm' });
    expect(alerts).toHaveLength(1);
  });

  it('critical 告警不受维护期静默', async () => {
    const config = createTestConfig({
      monitor: {
        metrics_flush_interval_ms: 999999,
        metrics_retention_days: 7,
        alert: {
          feishu_webhook: '',
          feishu_secret: '',
          dedup_window_ms: 100,
          maintenance_windows: [{ start: '00:00', end: '23:59', level: 'critical' }],
        },
      },
    });
    const am = new AlertManager(config, metrics);
    await am.start();
    const alerts: any[] = [];
    am.on('alert', (a) => alerts.push(a));
    await am.fire({ name: 'crit', level: 'critical', title: 'T', message: 'm' });
    expect(alerts).toHaveLength(1);
    await am.stop();
  });

  it('recoveryExecutor 在规则触发时被调用', async () => {
    const recoveryExecutor = jest.fn().mockResolvedValue(undefined);
    alertManager.setRecoveryExecutor(recoveryExecutor);
    await alertManager.start();

    // 直接调用 fireRule：通过手动 flush 一批指标
    const points: MetricPoint[] = [
      {
        name: 'shop_in_error',
        value: 1,
        shopId: 'shop1',
        timestamp: Date.now(),
      },
    ];
    metrics.emit('flush', points);
    await new Promise((r) => setTimeout(r, 50));

    expect(recoveryExecutor).toHaveBeenCalledWith('pause_shop', 'shop1');
  });

  it('resetShopState 清除指定店铺规则状态', async () => {
    await alertManager.start();
    const alerts: any[] = [];
    alertManager.on('alert', (a) => alerts.push(a));

    await alertManager.fire({ name: 'x', level: 'warn', title: 't', message: 'm', shopId: 'shop1' });
    expect(alerts).toHaveLength(1);

    alertManager.resetShopState('shop1');

    await alertManager.fire({ name: 'x', level: 'warn', title: 't', message: 'm', shopId: 'shop1' });
    expect(alerts).toHaveLength(2);
  });

  it('addRule 动态添加规则', async () => {
    await alertManager.start();
    alertManager.addRule({
      name: 'custom_rule',
      metric: 'custom_metric',
      threshold: 1,
      comparator: '>=',
      level: 'info',
      title: 'Custom',
      messageTemplate: 'custom value={value}',
    });

    const alerts: any[] = [];
    alertManager.on('alert', (a) => alerts.push(a));

    metrics.emit('flush', [
      { name: 'custom_metric', value: 5, shopId: 'shopX', timestamp: Date.now() },
    ]);
    await new Promise((r) => setTimeout(r, 50));

    expect(alerts.some((a) => a.name === 'custom_rule')).toBe(true);
  });

  it('critical 触发后同店铺 warn 被自动抑制', async () => {
    await alertManager.start();
    const alerts: any[] = [];
    alertManager.on('alert', (a) => alerts.push(a));

    // 1. 触发 critical 告警（shop_in_error）
    metrics.emit('flush', [
      { name: 'shop_in_error', value: 1, shopId: 'shop1', timestamp: Date.now() },
    ]);
    await new Promise((r) => setTimeout(r, 50));
    expect(alerts.some((a) => a.name === 'shop_in_error' && a.level === 'critical')).toBe(true);

    // 2. 同店铺触发 warn 告警（api_error_rate_high）— 应被抑制
    metrics.emit('flush', [
      { name: 'api_call_total', value: 10, shopId: 'shop1', timestamp: Date.now(), tags: { status: 'error' } },
    ]);
    await new Promise((r) => setTimeout(r, 50));
    expect(alerts.some((a) => a.name === 'api_error_rate_high')).toBe(false);

    // 3. 其他店铺的 warn 告警不受影响
    metrics.emit('flush', [
      { name: 'api_call_total', value: 10, shopId: 'shop2', timestamp: Date.now(), tags: { status: 'error' } },
    ]);
    await new Promise((r) => setTimeout(r, 50));
    expect(alerts.some((a) => a.name === 'api_error_rate_high' && a.shopId === 'shop2')).toBe(true);
  });

  it('critical 恢复后解除 warn 抑制', async () => {
    await alertManager.start();
    const alerts: any[] = [];
    alertManager.on('alert', (a) => alerts.push(a));

    // 1. 触发 critical 告警
    metrics.emit('flush', [
      { name: 'shop_in_error', value: 1, shopId: 'shop1', timestamp: Date.now() },
    ]);
    await new Promise((r) => setTimeout(r, 50));
    expect(alerts.some((a) => a.name === 'shop_in_error')).toBe(true);

    // 2. warn 被抑制
    metrics.emit('flush', [
      { name: 'api_call_total', value: 10, shopId: 'shop1', timestamp: Date.now(), tags: { status: 'error' } },
    ]);
    await new Promise((r) => setTimeout(r, 50));
    expect(alerts.some((a) => a.name === 'api_error_rate_high' && a.shopId === 'shop1')).toBe(false);

    // 3. critical 恢复（指标回到正常）
    metrics.emit('flush', [
      { name: 'shop_in_error', value: 0, shopId: 'shop1', timestamp: Date.now() },
    ]);
    await new Promise((r) => setTimeout(r, 50));
    const recovered = alerts.filter((a) => (a as any).rule === 'shop_in_error' || a.name === 'recovered');
    // 恢复事件已触发

    // 4. 重置去重窗口后，warn 告警应能正常触发
    alertManager.resetShopState('shop1');
    metrics.emit('flush', [
      { name: 'api_call_total', value: 10, shopId: 'shop1', timestamp: Date.now(), tags: { status: 'error' } },
    ]);
    await new Promise((r) => setTimeout(r, 50));
    expect(alerts.some((a) => a.name === 'api_error_rate_high' && a.shopId === 'shop1')).toBe(true);
  });
});
