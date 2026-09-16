/**
 * VisionClient 单元测试
 */
import { EventEmitter } from 'events';

// Mock child_process - factory must be self-contained (jest.mock is hoisted)
jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

import { spawn } from 'child_process';
import { VisionClient } from '@/vision/VisionClient';
import { createTestConfig } from '../helpers/testConfig';

const mockSpawn = spawn as jest.Mock;

class MockChildProcess extends EventEmitter {
  stdin = { write: jest.fn(), end: jest.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill = jest.fn();
  pid = 12345;
}

describe('VisionClient', () => {
  let client: VisionClient;
  const config = createTestConfig();

  function createProc(): MockChildProcess {
    const proc = new MockChildProcess();
    mockSpawn.mockReturnValue(proc);
    return proc;
  }

  function emitReady(proc: MockChildProcess): void {
    proc.emit('spawn');
    proc.stderr.emit('data', Buffer.from('vision service ready, waiting for requests...\n'));
  }

  beforeEach(() => {
    mockSpawn.mockClear();
    client = new VisionClient(config);
  });

  afterEach(async () => {
    try {
      await client.stop();
    } catch {
      // ignore - proc may not be started
    }
    mockSpawn.mockReset();
  });

  describe('start', () => {
    it('spawn 进程并标记为已启动', async () => {
      const proc = createProc();
      const startPromise = client.start();
      emitReady(proc);
      await startPromise;
      expect(client.isStarted).toBe(true);
    });

    it('spawn 超时 reject', async () => {
      jest.useFakeTimers();
      const proc = createProc();
      const startPromise = client.start();
      jest.advanceTimersByTime(config.vision.start_timeout_ms + 100);
      await expect(startPromise).rejects.toThrow('start timeout');
      proc.emit('exit', null);
      jest.advanceTimersByTime(2000);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });

    it('spawn error 事件 reject', async () => {
      const proc = createProc();
      const startPromise = client.start();
      proc.emit('error', new Error('spawn failed'));
      await expect(startPromise).rejects.toThrow('spawn failed');
    });
  });

  describe('detect', () => {
    it('发送请求到 stdin 并等待 stdout 响应', async () => {
      const proc = createProc();
      const startPromise = client.start();
      emitReady(proc);
      await startPromise;

      const detectPromise = client.detect({
        shopId: 'shop1',
        windowHandle: 'hwnd',
        captureRegion: { x: 0, y: 0, width: 800, height: 600 },
        mode: 'detect_message',
      });

      const call = proc.stdin.write.mock.calls[0][0];
      const payload = JSON.parse(call);
      const requestId = payload.requestId;
      expect(payload).toMatchObject({
        shopId: 'shop1',
        windowHandle: 'hwnd',
        captureRegion: { x: 0, y: 0, width: 800, height: 600 },
        mode: 'detect_message',
      });
      proc.stdout.emit('data', Buffer.from(JSON.stringify({
        requestId,
        status: 'ok',
        data: { messages: [] },
      }) + '\n'));

      const resp = await detectPromise;
      expect(resp.status).toBe('ok');
    });

    it('请求超时 reject', async () => {
      jest.useFakeTimers();
      const proc = createProc();
      const startPromise = client.start();
      emitReady(proc);
      await startPromise;

      const detectPromise = client.detect({
        shopId: 'shop1',
        windowHandle: 'hwnd',
        captureRegion: { x: 0, y: 0, width: 800, height: 600 },
        mode: 'detect_message',
      }, 100);

      jest.advanceTimersByTime(150);
      await expect(detectPromise).rejects.toThrow('timeout');
      jest.useRealTimers();
    });

    it('未启动时抛错', async () => {
      await expect(client.detect({
        shopId: 'shop1',
        windowHandle: 'hwnd',
        captureRegion: { x: 0, y: 0, width: 800, height: 600 },
        mode: 'detect_message',
      })).rejects.toThrow('not started');
    });
  });

  describe('stop', () => {
    it('结束进程并清理', async () => {
      const proc = createProc();
      const startPromise = client.start();
      emitReady(proc);
      await startPromise;

      await client.stop();
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(client.isStarted).toBe(false);
    });

    it('主动停止后不触发自动重启', async () => {
      jest.useFakeTimers();
      const proc = createProc();
      const startPromise = client.start();
      emitReady(proc);
      await startPromise;

      await client.stop();
      proc.emit('exit', 0);
      jest.advanceTimersByTime(2000);

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });
  });

  describe('进程退出自动重启', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('进程退出后自动重启', async () => {
      const proc1 = createProc();
      const startPromise = client.start();
      emitReady(proc1);
      await startPromise;

      const restartSpy = jest.fn();
      client.on('restarted', restartSpy);

      proc1.emit('exit', 1);

      // Advance timer to trigger the restart callback
      const proc2 = createProc();
      const restartPromise = new Promise<void>((resolve) => {
        client.on('restarted', () => resolve());
      });
      jest.advanceTimersByTime(2000);
      // Give the async callback a chance to call start() which calls spawn()
      await Promise.resolve();
      emitReady(proc2);
      await restartPromise;

      expect(restartSpy).toHaveBeenCalledWith({ count: 1 });
    });

    it('超过重启上限不再调度重启', async () => {
      const maxRestarts = config.vision.max_restart_per_hour;
      const proc = createProc();
      const startPromise = client.start();
      emitReady(proc);
      await startPromise;

      // Simulate rapid exits up to the limit
      // Each exit increments restartCount, but the timer callback is NOT fired
      // (we keep fake timers so callbacks don't execute)
      for (let i = 0; i < maxRestarts; i++) {
        proc.emit('exit', 1);
      }

      // After maxRestarts exits, restartCount should be at the limit
      // One more exit should NOT schedule a restart
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
      proc.emit('exit', 1);

      const restartTimers = setTimeoutSpy.mock.calls.filter(
        (c) => typeof c[1] === 'number' && c[1] === 2000,
      );
      expect(restartTimers.length).toBe(0);

      setTimeoutSpy.mockRestore();
    });
  });

  describe('onStdoutData 缓冲', () => {
    it('处理 partial lines', async () => {
      const proc = createProc();
      const startPromise = client.start();
      emitReady(proc);
      await startPromise;

      const detectPromise = client.detect({
        shopId: 'shop1',
        windowHandle: 'hwnd',
        captureRegion: { x: 0, y: 0, width: 800, height: 600 },
        mode: 'detect_message',
      });

      const call = proc.stdin.write.mock.calls[0][0];
      const requestId = JSON.parse(call).requestId;
      const response = JSON.stringify({ requestId, status: 'ok', data: { messages: [] } });

      proc.stdout.emit('data', Buffer.from(response.slice(0, 10)));
      proc.stdout.emit('data', Buffer.from(response.slice(10) + '\n'));

      const resp = await detectPromise;
      expect(resp.status).toBe('ok');
    });
  });
});
