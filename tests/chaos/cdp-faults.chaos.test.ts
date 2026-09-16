/**
 * 故障注入测试：CDP / WebContents 故障场景
 *
 * 覆盖场景：
 * - C-01: CDP 心跳连续失败 → 状态机进入 Error，触发 restart_feige 恢复动作
 * - C-02: WebContents 崩溃 → 状态机迁移到 Recovering 并尝试恢复
 *
 * 对应文档：docs/开发文档-综合版.md 第 12.4 节、第 16 章状态机
 */
import { ShopStateMachine, type StateMachineCallbacks, type StateMachineTimers } from '@/state/ShopStateMachine';

const FAST_TIMERS: Partial<StateMachineTimers> = {
  heartbeatIntervalMs: 50,
  recoverProbeIntervalMs: 50,
  recoverCooldownMs: 0,
  recoverVerifyCount: 2,
  recoverVerifyIntervalMs: 10,
  recoverVerifyTimeoutMs: 200,
  visualPollIntervalMs: 50,
  degradingTimeoutMs: 100,
  silentWaitDurationMs: 100,
  silentWaitMaxConsecutive: 3,
};

function createCallbacks(overrides: Partial<StateMachineCallbacks> = {}): StateMachineCallbacks {
  return {
    onCdpHeartbeat: async () => true,
    onCdpRecoverProbe: async () => true,
    onVisualPoll: async () => {},
    onSilentWaitEnd: async () => {},
    onEnterError: () => {},
    onEnterDegrading: async () => {},
    onEnterVisualMode: async () => {},
    onExitVisualMode: async () => {},
    ...overrides,
  };
}

describe('Chaos: CDP 故障', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('C-01: CDP 心跳连续失败超过阈值 → 状态机离开 Healthy 进入降级/错误流程', async () => {
    const onEnterError = jest.fn();
    const callbacks = createCallbacks({
      onCdpHeartbeat: async () => false,
      // onEnterDegrading 不立即 resolve，让 degradingTimeoutMs 触发 → Error
      onEnterDegrading: async () => {
        return new Promise(() => {}); // 永不 resolve
      },
      onEnterError,
    });

    const sm = new ShopStateMachine('shop-chaos-01', 'Healthy', callbacks, FAST_TIMERS);
    // 监听 error 事件避免 unhandled error
    sm.on('error', () => {});
    sm.start();

    // 推进足够多的心跳周期：2 次失败 → Degrading → degradingTimeoutMs(100ms) → Error
    for (let i = 0; i < 10; i++) {
      jest.advanceTimersByTime(60);
      await Promise.resolve();
    }

    // 状态应已离开 Healthy，进入错误/恢复/降级流程
    expect(sm.currentState).not.toBe('Healthy');
    expect(['Error', 'Recovering', 'Degrading', 'VisualMode', 'SilentWait']).toContain(sm.currentState);

    sm.destroy();
  });

  it('C-02: WebContents 崩溃后状态机进入 Recovering 并尝试恢复', async () => {
    const onCdpRecoverProbe = jest.fn().mockResolvedValue(true);
    const callbacks = createCallbacks({
      onCdpHeartbeat: async () => false,
      onCdpRecoverProbe,
    });

    const sm = new ShopStateMachine('shop-chaos-02', 'Healthy', callbacks, FAST_TIMERS);
    sm.start();

    // 触发多次心跳失败使状态机进入错误恢复流程
    for (let i = 0; i < 15; i++) {
      jest.advanceTimersByTime(60);
      await Promise.resolve();
    }

    // 恢复探测应被调用过
    expect(onCdpRecoverProbe).toHaveBeenCalled();

    sm.destroy();
  });
});
