/**
 * 故障注入测试：视觉服务故障场景
 *
 * 覆盖场景：
 * - C-05: 视觉服务 stdout 超时 → detect 超时 reject
 * - C-06: 视觉服务进程异常退出 → 重启上限后触发 vision_service_exit 告警
 *
 * 对应文档：docs/开发文档-综合版.md 第 12.4 节、第 18 章监控与告警
 */
import { EventEmitter } from 'events';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

import { spawn } from 'child_process';
import { VisionClient } from '@/vision/VisionClient';
import { MetricsCollector } from '@/monitor/MetricsCollector';
import { AlertManager } from '@/monitor/AlertManager';
import { createTestConfig } from '../unit/helpers/testConfig';

const mockSpawn = spawn as jest.Mock;

class MockChildProcess extends EventEmitter {
  stdin = { write: jest.fn(), end: jest.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill = jest.fn();
  pid = 12345;
}

describe('Chaos: 视觉服务故障', () => {
  describe('C-05: 视觉服务 stdout 超时', () => {
    let client: VisionClient;
      const config = createTestConfig({
      vision: {
        ...createTestConfig().vision,
        enabled: true,
        start_timeout_ms: 500,
        request_timeout_ms: 200,
        poll_interval_ms: 50,
        max_restart_per_hour: 10,
      },
    });

    beforeEach(() => {
      mockSpawn.mockClear();
      client = new VisionClient(config);
    });

    afterEach(async () => {
      try {
        await client.stop();
      } catch {
        // ignore
      }
      mockSpawn.mockReset();
    });

    it('子进程不响应时 detect 在 request_timeout_ms 后 reject', async () => {
      const proc = new MockChildProcess();
      mockSpawn.mockReturnValue(proc);

      const startPromise = client.start();
      proc.emit('spawn');
      proc.stderr.emit('data', Buffer.from('vision service ready, waiting for requests...\n'));
      await startPromise;

      // 发起 detect 但不写回 stdout 响应
      const detectPromise = client.detect({
        shopId: 'shop-chaos-05',
        windowHandle: '0x12345',
        captureRegion: { x: 0, y: 0, width: 800, height: 600 },
        mode: 'detect_message',
      });

      await expect(detectPromise).rejects.toThrow();
    });
  });

  describe('C-06: 视觉服务进程异常退出触发告警', () => {
    it('退出次数超过阈值时触发 vision_service_exit 告警', async () => {
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

      // 注入 3 次视觉服务退出指标（达到阈值 threshold >= 3）
      metrics.emit('flush', [
        { name: 'vision_service_exit_total', value: 3, shopId: undefined, timestamp: Date.now() },
      ]);
      await new Promise((r) => setTimeout(r, 50));

      expect(alerts.some((a) => a.name === 'vision_service_exit' && a.level === 'critical')).toBe(true);

      await alertManager.stop();
    });
  });
});
