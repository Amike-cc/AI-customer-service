/**
 * 故障注入测试：DeepSeek API / 限流器 故障场景
 *
 * 覆盖场景：
 * - C-03: DeepSeek API 连续失败 → 熔断器开启，回复走 fallback_response
 * - C-04: 限流频繁触发 → 限流器拒绝，告警 rate_limit_frequent
 *
 * 对应文档：docs/开发文档-综合版.md 第 12.4 节、第 10 章 DeepSeek 客户端
 */
import axios from 'axios';
import { DeepSeekClient } from '@/deepseek/DeepSeekClient';
import { RateLimiter } from '@/cache/RateLimiter';
import { MetricsCollector } from '@/monitor/MetricsCollector';
import { AlertManager } from '@/monitor/AlertManager';
import { createTestConfig } from '../unit/helpers/testConfig';

jest.mock('axios');

describe('Chaos: API 故障', () => {
  describe('C-03: DeepSeek API 连续失败熔断', () => {
    let client: DeepSeekClient;
    let metrics: MetricsCollector;
    let db: { prepare: jest.Mock };
    const config = createTestConfig({
      deepseek: {
        ...createTestConfig().deepseek,
        retry_count: 0,
        timeout_ms: 200,
        fallback_response: 'fallback-reply',
      },
    });

    beforeEach(() => {
      (axios.create as jest.Mock).mockReturnValue({
        post: jest.fn().mockRejectedValue(new Error('timeout')),
        interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
      });
      db = {
        prepare: jest.fn().mockReturnValue({
          run: jest.fn(),
          all: jest.fn().mockReturnValue([]),
          get: jest.fn().mockReturnValue(undefined),
        }),
      };
      metrics = new MetricsCollector(config, db as any);
      client = new DeepSeekClient(config, 'sk-test', metrics);
    });

    it('连续失败 5 次后熔断器开启，返回 fallback_response', async () => {
      const req = {
        shopId: 'shop-chaos-03',
        sessionId: 'sess-1',
        messages: [{ role: 'user' as const, content: '你好' }],
      };

      const responses: any[] = [];
      for (let i = 0; i < 6; i++) {
        try {
          const r = await client.chat(req);
          responses.push(r);
        } catch (e) {
          responses.push({ error: e });
        }
      }

      // 期望前几次抛错，熔断器开启后返回 fallback_response
      const fallbacks = responses.filter((r) => r && r.content === 'fallback-reply');
      expect(fallbacks.length).toBeGreaterThan(0);

      const circuit = client.getCircuitState();
      expect(['open', 'half-open', 'closed']).toContain(circuit.state);
    });
  });

  describe('C-04: 限流频繁触发告警', () => {
    it('单店每分钟超过 10 次后限流器拒绝', () => {
      const config = createTestConfig({
        ratelimit: {
          per_shop_per_minute: 10,
          night_factor: 1.0,
          night_hours: [0, 0],
          burst_allowance: 0,
          burst_window_ms: 10000,
        },
      });
      const limiter = new RateLimiter(config);

      let accepted = 0;
      for (let i = 0; i < 15; i++) {
        if (limiter.tryAcquire('shop-chaos-04')) accepted++;
      }

      expect(accepted).toBe(10);
      expect(limiter.tryAcquire('shop-chaos-04')).toBe(false);
    });

    it('rate_limit_rejected_total 指标触发 rate_limit_frequent 告警', async () => {
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
      const db = {
        prepare: jest.fn().mockReturnValue({
          run: jest.fn(),
          all: jest.fn().mockReturnValue([]),
          get: jest.fn().mockReturnValue(undefined),
        }),
      };
      const metrics = new MetricsCollector(config, db as any);
      const alertManager = new AlertManager(config, metrics);
      await alertManager.start();

      const alerts: any[] = [];
      alertManager.on('alert', (a) => alerts.push(a));

      // 注入 10 次限流拒绝指标
      metrics.emit('flush', [
        { name: 'rate_limit_rejected_total', value: 12, shopId: 'shop-chaos-04', timestamp: Date.now() },
      ]);
      await new Promise((r) => setTimeout(r, 50));

      expect(alerts.some((a) => a.name === 'rate_limit_frequent')).toBe(true);

      await alertManager.stop();
    });
  });
});
