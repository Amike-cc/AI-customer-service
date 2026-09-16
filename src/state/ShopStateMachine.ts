/**
 * 状态机模块
 * 详见 docs/16-状态机设计.md
 */
import { EventEmitter } from 'events';

export type StateName =
  | 'Healthy'
  | 'Degrading'
  | 'VisualMode'
  | 'Recovering'
  | 'SilentWait'
  | 'Error'
  | 'ManualMode';

export interface StateContext {
  shopId: string;
  silentWaitCount: number;
  cdpRecoverAttempts: number;
  cdpHeartbeatFailures: number;
  cdpRecoverSuccesses: number;
  identifyFailures: number;
  enteredAt: number;
}

export interface StateTransitionEvent {
  from: StateName;
  to: StateName;
  context: StateContext;
  timestamp: number;
}

export interface StateMachineCallbacks {
  onCdpHeartbeat: () => Promise<boolean>;
  onCdpRecoverProbe: () => Promise<boolean>;
  onVisualPoll: () => Promise<void>;
  onSilentWaitEnd: () => Promise<void>;
  onEnterError: () => void;
  onEnterDegrading: () => Promise<void>;
  onEnterVisualMode: () => Promise<void>;
  onExitVisualMode: () => Promise<void>;
}

const DEFAULT_CALLBACKS: StateMachineCallbacks = {
  onCdpHeartbeat: async () => true,
  onCdpRecoverProbe: async () => false,
  onVisualPoll: async () => {},
  onSilentWaitEnd: async () => {},
  onEnterError: () => {},
  onEnterDegrading: async () => {},
  onEnterVisualMode: async () => {},
  onExitVisualMode: async () => {},
};

export interface StateMachineTimers {
  heartbeatIntervalMs: number;
  recoverProbeIntervalMs: number;
  recoverCooldownMs: number;
  recoverVerifyCount: number;
  recoverVerifyIntervalMs: number;
  recoverVerifyTimeoutMs: number;
  visualPollIntervalMs: number;
  degradingTimeoutMs: number;
  silentWaitDurationMs: number;
  silentWaitMaxConsecutive: number;
}

export class ShopStateMachine extends EventEmitter {
  private state: StateName;
  private context: StateContext;
  private timers = new Map<string, NodeJS.Timeout>();
  private callbacks: StateMachineCallbacks;
  private timerConfig: StateMachineTimers;
  private lastRecoverProbeAt = 0;
  /** 串行化异步状态切换，避免 exitState 尚未完成时重复进入同一状态。 */
  private transitionQueue: Promise<void> = Promise.resolve();
  private pendingStates = new Set<StateName>();

  constructor(
    shopId: string,
    initialState: StateName = 'Degrading',
    callbacks: Partial<StateMachineCallbacks> = {},
    timerConfig: Partial<StateMachineTimers> = {},
  ) {
    super();
    this.context = {
      shopId,
      silentWaitCount: 0,
      cdpRecoverAttempts: 0,
      cdpHeartbeatFailures: 0,
      cdpRecoverSuccesses: 0,
      identifyFailures: 0,
      enteredAt: Date.now(),
    };
    this.state = initialState;
    this.callbacks = { ...DEFAULT_CALLBACKS, ...callbacks };
    this.timerConfig = {
      heartbeatIntervalMs: 10000,
      recoverProbeIntervalMs: 30000,
      recoverCooldownMs: 60000,
      recoverVerifyCount: 3,
      recoverVerifyIntervalMs: 5000,
      recoverVerifyTimeoutMs: 30000,
      visualPollIntervalMs: 2000,
      degradingTimeoutMs: 5000,
      silentWaitDurationMs: 60000,
      silentWaitMaxConsecutive: 3,
      ...timerConfig,
    };
    // 不在构造函数中自动进入状态，避免回调未就绪；调用方应显式调用 start()
  }

  get currentState(): StateName {
    return this.state;
  }

  get shopId(): string {
    return this.context.shopId;
  }

  get contextSnapshot(): StateContext {
    return { ...this.context };
  }

  /** 启动状态机，进入初始状态的行为 */
  start(): void {
    this.enterState(this.state);
  }

  transition(next: StateName): Promise<void> {
    if (next === this.state || this.pendingStates.has(next)) return this.transitionQueue;
    this.pendingStates.add(next);

    this.transitionQueue = this.transitionQueue
      .then(async () => {
        if (next === this.state) return;
        const prev = this.state;
        // 等待旧状态退出（如 onExitVisualMode 释放视觉资源）完成后再进入新状态，
        // 避免 enter/exit 视觉资源竞争。
        await this.exitState(prev);
        this.state = next;
        this.context.enteredAt = Date.now();
        this.enterState(next);
        const event: StateTransitionEvent = {
          from: prev,
          to: next,
          context: { ...this.context },
          timestamp: Date.now(),
        };
        this.emit('transition', event);
      })
      .catch((err: unknown) => {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        this.pendingStates.delete(next);
      });

    return this.transitionQueue;
  }

  private enterState(s: StateName): void {
    switch (s) {
      case 'Healthy':
        this.startHealthy();
        break;
      case 'Degrading':
        this.startDegrading();
        break;
      case 'VisualMode':
        this.startVisualMode();
        break;
      case 'Recovering':
        this.startRecovering();
        break;
      case 'SilentWait':
        this.startSilentWait();
        break;
      case 'Error':
        this.startError();
        break;
      case 'ManualMode':
        // 人工接管模式，无定时器
        break;
    }
  }

  private async exitState(s: StateName): Promise<void> {
    void s;
    this.clearAllTimers();
    if (s === 'VisualMode') {
      await this.callbacks.onExitVisualMode();
    }
  }

  // ============ Healthy ============
  private startHealthy(): void {
    this.context.cdpHeartbeatFailures = 0;
    this.startInterval('heartbeat', this.timerConfig.heartbeatIntervalMs, () =>
      this.runHeartbeat(),
    );
    // Healthy 状态下也启动视觉轮询，用于扫描当前会话中未回复的买家气泡消息
    // MutationObserver 只能检测新消息，无法发现历史未回复消息，需要定期补偿扫描
    this.startInterval('visual_poll', this.timerConfig.visualPollIntervalMs, () =>
      this.runVisualPoll(),
    );
  }

  private async runHeartbeat(): Promise<void> {
    try {
      const ok = await this.callbacks.onCdpHeartbeat();
      if (ok) {
        this.context.cdpHeartbeatFailures = 0;
      } else {
        this.onCdpHeartbeatFailure();
      }
    } catch {
      this.onCdpHeartbeatFailure();
    }
  }

  // ============ Degrading ============
  private startDegrading(): void {
    this.startTimer(
      'degrading_timeout',
      this.timerConfig.degradingTimeoutMs,
      () => {
        this.emit('alert', {
          level: 'critical',
          message: `Degrading 超时 ${this.timerConfig.degradingTimeoutMs}ms 未切换`,
        });
        void this.transition('Error');
      },
    );
    void this.callbacks.onEnterDegrading().then(
      () => {
        // onEnterDegrading 成功：先取消超时定时器，避免竞态切换到 Error 造成视觉资源泄漏
        const t = this.timers.get('degrading_timeout');
        if (t) {
          clearTimeout(t);
          this.timers.delete('degrading_timeout');
        }
        if (this.state === 'Degrading') {
          void this.transition('VisualMode');
        }
      },
      (err) => {
        this.emit('error', err);
        if (this.state === 'Degrading') void this.transition('Error');
      },
    );
  }

  // ============ VisualMode ============
  private startVisualMode(): void {
    void this.callbacks.onEnterVisualMode();
    this.startInterval('cdp_probe', this.timerConfig.recoverProbeIntervalMs, () =>
      this.runRecoverProbe(),
    );
    this.startInterval('visual_poll', this.timerConfig.visualPollIntervalMs, () =>
      this.runVisualPoll(),
    );
  }

  private async runVisualPoll(): Promise<void> {
    try {
      await this.callbacks.onVisualPoll();
    } catch (err) {
      this.emit('error', err);
    }
  }

  private async runRecoverProbe(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRecoverProbeAt < this.timerConfig.recoverCooldownMs) {
      return;
    }
    this.lastRecoverProbeAt = now;
    try {
      const ok = await this.callbacks.onCdpRecoverProbe();
      if (ok && this.state === 'VisualMode') {
        void this.transition('Recovering');
      }
    } catch {
      // 探测失败，保持 VisualMode
    }
  }

  // ============ Recovering ============
  private startRecovering(): void {
    this.context.cdpRecoverSuccesses = 0;
    this.startTimer(
      'recovering_timeout',
      this.timerConfig.recoverVerifyTimeoutMs,
      () => {
        if (this.state === 'Recovering') void this.transition('VisualMode');
      },
    );
    void this.runRecoverVerify();
  }

  private async runRecoverVerify(): Promise<void> {
    for (let i = 0; i < this.timerConfig.recoverVerifyCount; i++) {
      if (this.state !== 'Recovering') return;
      try {
        const ok = await this.callbacks.onCdpRecoverProbe();
        if (!ok) {
          void this.transition('VisualMode');
          return;
        }
        this.context.cdpRecoverSuccesses += 1;
      } catch {
        void this.transition('VisualMode');
        return;
      }
      if (i < this.timerConfig.recoverVerifyCount - 1) {
        await this.sleep(this.timerConfig.recoverVerifyIntervalMs);
      }
    }
    if (this.state === 'Recovering') {
      void this.transition('Healthy');
    }
  }

  // ============ SilentWait ============
  private startSilentWait(): void {
    this.context.silentWaitCount += 1;
    if (this.context.silentWaitCount >= this.timerConfig.silentWaitMaxConsecutive) {
      void this.transition('Error');
      return;
    }
    this.emit('alert', {
      level: 'warn',
      message: `SilentWait #${this.context.silentWaitCount}`,
    });
    this.startTimer('silent_wait', this.timerConfig.silentWaitDurationMs, () =>
      this.endSilentWait(),
    );
  }

  private async endSilentWait(): Promise<void> {
    try {
      await this.callbacks.onSilentWaitEnd();
    } catch (err) {
      this.emit('error', err);
    }
    // 重置识别失败计数，给一次重新识别的机会
    this.context.identifyFailures = 0;
    // 根据当前 CDP 状态决定回到 Healthy 还是 VisualMode
    // 默认回到 VisualMode，由调用方通过 forceTransition 覆盖
    if (this.state === 'SilentWait') {
      void this.transition('VisualMode');
    }
  }

  // ============ Error ============
  private startError(): void {
    this.emit('alert', { level: 'critical', message: '进入 Error 状态' });
    this.callbacks.onEnterError();
  }

  // ============ 外部事件入口 ============
  onCdpHeartbeatFailure(): void {
    if (this.state !== 'Healthy' && this.state !== 'Recovering') return;
    this.context.cdpHeartbeatFailures += 1;
    if (this.context.cdpHeartbeatFailures >= 2) {
      void this.transition('Degrading');
    }
  }

  onCdpHeartbeatSuccess(): void {
    this.context.cdpHeartbeatFailures = 0;
  }

  onIdentifyFailure(): void {
    this.context.identifyFailures += 1;
    if (this.context.identifyFailures >= 2 && this.state !== 'SilentWait' && this.state !== 'Error') {
      void this.transition('SilentWait');
    }
  }

  onIdentifySuccess(): void {
    this.context.identifyFailures = 0;
    this.context.silentWaitCount = 0;
  }

  /**
   * 人工接管：返回可等待的 Promise，调用方必须等待状态真正进入 ManualMode
   * 后才能认为自动发送已被阻断（否则生成中的任务可能在转换完成前发送）。
   */
  onManualTakeover(): Promise<void> {
    return this.transition('ManualMode');
  }

  /** 人工释放：同样返回 Promise，调用方可等待恢复目标状态完成。 */
  onManualRelease(targetState: StateName = 'Healthy'): Promise<void> {
    if (this.state !== 'ManualMode') return Promise.resolve();
    return this.transition(targetState);
  }

  /** 等待当前排队中的全部状态转换完成（用于发送闸门收敛） */
  async waitForIdle(): Promise<void> {
    await this.transitionQueue;
  }

  /** 重置 SilentWait 累计计数（识别成功后调用） */
  resetSilentWaitCount(): void {
    this.context.silentWaitCount = 0;
  }

  /** 序列化为持久化记录 */
  toRecord(): StateContext & { state: StateName } {
    return { ...this.context, state: this.state };
  }

  /** 从持久化记录恢复（不触发回调，需手动调用 start） */
  static fromRecord(
    record: StateContext & { state: StateName },
    callbacks: Partial<StateMachineCallbacks> = {},
    timerConfig: Partial<StateMachineTimers> = {},
  ): ShopStateMachine {
    const sm = new ShopStateMachine(record.shopId, record.state, callbacks, timerConfig);
    sm.context = { ...record };
    return sm;
  }

  // ============ 工具方法 ============
  private startTimer(name: string, ms: number, fn: () => void): void {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    this.timers.set(name, timer);
  }

  private startInterval(name: string, ms: number, fn: () => void): void {
    const timer = setInterval(fn, ms);
    timer.unref?.();
    this.timers.set(name, timer);
  }

  private clearAllTimers(): void {
    for (const t of this.timers.values()) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers.clear();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => {
      const t = setTimeout(r, ms);
      t.unref?.();
    });
  }

  /** 销毁状态机，清理所有定时器 */
  destroy(): void {
    this.clearAllTimers();
    this.removeAllListeners();
  }
}
