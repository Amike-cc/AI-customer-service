/**
 * 视觉服务客户端
 * 详见 docs/技术选型决策记录.md §5.3
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import type { Config } from '../config/schema';
import type { AppLogger } from '../logging/logger';

export interface VisionRequest {
  shopId: string;
  windowHandle: string;
  captureRegion: { x: number; y: number; width: number; height: number };
  /**
   * 显示器缩放系数（DIP → 物理像素）。captureRegion 为 DIP，Win32 截图用物理像素，
   * 高 DPI 显示器上必须换算，否则截取区域错位。省略时按 1.0 处理。
   */
  scaleFactor?: number;
  mode: 'detect_message' | 'locate_controls';
  timeoutMs?: number;
  controls?: {
    inputBox?: { bbox: [number, number, number, number]; confidence: number };
    sendButton?: { bbox: [number, number, number, number]; confidence: number };
  };
}

export interface VisionMessage {
  bbox: [number, number, number, number];
  text: string;
  confidence: number;
  isBuyer: boolean;
  timestamp: number;
}

export interface VisionResponse {
  requestId: string;
  status: 'ok' | 'error';
  data?: {
    messages: VisionMessage[];
    inputBox?: { bbox: [number, number, number, number]; confidence: number };
    sendButton?: { bbox: [number, number, number, number]; confidence: number };
  };
  timingMs?: {
    capture?: number;
    preprocess: number;
    detect?: number;
    ocr: number;
    total: number;
  };
  error?: string;
}

interface PendingRequest {
  resolve: (value: VisionResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export class VisionClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private pending = new Map<string, PendingRequest>();
  private restartCount = 0;
  private restartWindowStart = Date.now();
  private restartTimer: NodeJS.Timeout | null = null;
  private logger: AppLogger | null = null;
  private ready = false;
  private procExitHandler: ((code: number | null) => void) | null = null;

  constructor(private config: Config, logger?: AppLogger) {
    super();
    this.logger = logger ?? null;
  }

  get isStarted(): boolean {
    return this.proc !== null && !this.proc.killed && this.ready;
  }

  async start(): Promise<void> {
    const { python_path, script_path, start_timeout_ms } = this.config.vision;
    this.ready = false;
    const proc = spawn(python_path, [script_path], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as unknown as ChildProcessWithoutNullStreams;
    this.proc = proc;

    proc.stdout.on('data', (chunk: Buffer) => this.onStdoutData(chunk));
    // 捕获 vision 服务的 stderr 输出（Python 异常堆栈、警告等），便于诊断视觉调用失败原因
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim();
      if (text) {
        this.logger?.warn({ visionStderr: text }, 'vision service stderr');
      }
    });
    await new Promise<void>((resolve, reject) => {
      let startupOutput = '';
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        proc.stderr?.off('data', onReadyOutput);
        proc.off('error', onError);
        proc.off('exit', onEarlyExit);
      };
      const succeed = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.ready = true;
        resolve();
      };
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.ready = false;
        if (this.proc === proc) this.proc = null;
        reject(err);
      };
      const onReadyOutput = (chunk: Buffer): void => {
        startupOutput = (startupOutput + chunk.toString('utf8')).slice(-8192);
        if (startupOutput.includes('vision service ready')) succeed();
      };
      const onError = (err: Error): void => fail(err);
      const onEarlyExit = (code: number | null): void =>
        fail(new Error(`vision service exited before ready code=${code}`));
      const timer = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch { /* 进程已退出 */ }
        fail(new Error('vision service start timeout'));
      }, start_timeout_ms);

      proc.stderr?.on('data', onReadyOutput);
      proc.once('error', onError);
      proc.once('exit', onEarlyExit);
    });

    // 仅在服务真正 ready 后监听运行期退出。启动失败或超时后终止子进程
    // 不应触发自动重启，否则会形成重复启动和未处理 Promise 拒绝。
    this.procExitHandler = (code) => {
      if (this.proc === proc) this.onProcExit(code);
    };
    proc.once('exit', this.procExitHandler);

    this.restartCount = 0;
    this.restartWindowStart = Date.now();
  }

  async detect(req: VisionRequest, timeoutMs?: number): Promise<VisionResponse> {
    if (!this.isStarted || !this.proc) {
      throw new Error('vision service not started');
    }
    const requestId = uuid();
    const timeout = timeoutMs ?? this.config.vision.request_timeout_ms;
    const payload = JSON.stringify({ requestId, ...req });

    return new Promise<VisionResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`vision request timeout ${requestId}`));
      }, timeout);

      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.proc!.stdin.write(payload + '\n');
      } catch (err) {
        // Python 崩溃瞬间写入会触发 EPIPE/流错误，必须捕获并拒绝该请求，避免未处理异常
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async stop(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.proc) {
      const proc = this.proc;
      if (this.procExitHandler) {
        proc.off('exit', this.procExitHandler);
        this.procExitHandler = null;
      }
      try {
        proc.kill('SIGTERM');
        // 500ms 后 SIGKILL 兜底，确保 Python 子进程退出，避免僵尸进程
        setTimeout(() => {
          if (!proc.killed) {
            try { proc.kill('SIGKILL'); } catch { /* 已退出，忽略 */ }
          }
        }, 500);
      } catch {
        // 进程已退出，忽略
      }
      this.proc = null;
      this.ready = false;
    } else {
      this.proc = null;
    }
    this.clearPending(new Error('vision service stopped'));
  }

  private onStdoutData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf-8');
    // 防御：Python 输出不换行时缓冲无限增长；超过 10MB 丢弃最旧一半
    if (this.buffer.length > 10 * 1024 * 1024) {
      this.buffer = this.buffer.slice(this.buffer.length - 5 * 1024 * 1024);
      this.logger?.warn('VisionClient stdout 缓冲超过 10MB，已截断（Python 输出可能无换行）');
    }
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const resp = JSON.parse(line) as VisionResponse;
        const slot = this.pending.get(resp.requestId);
        if (slot) {
          clearTimeout(slot.timer);
          this.pending.delete(resp.requestId);
          slot.resolve(resp);
        }
      } catch (err) {
        this.logger?.error({ err, line }, 'VisionClient parse error');
      }
    }
  }

  private onProcExit(code: number | null): void {
    this.procExitHandler = null;
    this.clearPending(new Error(`vision service exited code=${code}`));
    this.proc = null;
    this.ready = false;

    // 补发退出指标：AlertManager 的 vision_service_exit 规则依赖该指标
    this.emit('exit', code);

    const now = Date.now();
    if (now - this.restartWindowStart > 3600000) {
      this.restartCount = 0;
      this.restartWindowStart = now;
    }
    if (this.restartCount < this.config.vision.max_restart_per_hour) {
      this.restartCount += 1;
      const count = this.restartCount;
      // 指数退避：2s, 4s, 8s ... 上限 300s，避免路径错误时 20s 内耗尽 max_restart_per_hour 配额
      const delay = Math.min(2000 * Math.pow(2, count - 1), 300000);
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
      }
      this.restartTimer = setTimeout(async () => {
        this.restartTimer = null;
        try {
          await this.start();
          this.emit('restarted', { count });
        } catch (err) {
          this.logger?.error({ err, restartCount: count }, '视觉服务自动重启失败');
          // EventEmitter 的 error 事件在没有监听器时会直接抛出；只有上层明确
          // 订阅时才转发，避免定时器回调产生未处理 Promise 拒绝。
          if (this.listenerCount('error') > 0) this.emit('error', err);
        }
      }, delay);
    } else {
      // 重启配额耗尽：告警，避免静默失败（仍发出 restart_exhausted 事件供上层处理）
      this.logger?.error(
        { code, max: this.config.vision.max_restart_per_hour, windowStart: this.restartWindowStart },
        'vision service 重启配额已耗尽，停止自动重启',
      );
      this.emit('restart_exhausted', { code, max: this.config.vision.max_restart_per_hour });
    }
  }

  private clearPending(reason: Error): void {
    for (const [, slot] of this.pending) {
      clearTimeout(slot.timer);
      slot.reject(reason);
    }
    this.pending.clear();
  }
}
