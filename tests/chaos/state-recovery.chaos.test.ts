/**
 * 故障注入测试：状态机循环恢复与 SilentWait 累计
 *
 * 覆盖场景：
 * - C-16: VisualMode → Recovering 验证失败 → VisualMode → 再次 Recovering 成功 → Healthy
 * - C-17: SilentWait 累计达上限 → Error
 *
 * 对应文档：docs/开发文档-综合版.md 第 12.4 节、第 7 章状态机
 */
import { ShopStateMachine, type StateMachineCallbacks } from '@/state/ShopStateMachine';

describe('Chaos: 状态机循环恢复与 SilentWait 累计', () => {
  let callbacks: jest.Mocked<StateMachineCallbacks>;

  beforeEach(() => {
    callbacks = {
      onCdpHeartbeat: jest.fn().mockResolvedValue(true),
      onCdpRecoverProbe: jest.fn().mockResolvedValue(false),
      onVisualPoll: jest.fn().mockResolvedValue(undefined),
      onSilentWaitEnd: jest.fn().mockResolvedValue(undefined),
      onEnterError: jest.fn(),
      onEnterDegrading: jest.fn().mockResolvedValue(undefined),
      onEnterVisualMode: jest.fn().mockResolvedValue(undefined),
      onExitVisualMode: jest.fn().mockResolvedValue(undefined),
    };
  });

  describe('C-16: VisualMode → Recovering 循环恢复', () => {
    it('探测成功后验证全部通过 → 恢复到 Healthy', async () => {
      callbacks.onCdpRecoverProbe.mockResolvedValue(true);
      const sm = new ShopStateMachine('shop-c16', 'VisualMode', callbacks, {
        recoverProbeIntervalMs: 20,
        recoverVerifyCount: 2,
        recoverVerifyIntervalMs: 5,
        recoverVerifyTimeoutMs: 5000,
        recoverCooldownMs: 0,
        visualPollIntervalMs: 1000,
      });
      sm.on('error', () => {});
      sm.start();

      await new Promise((r) => setTimeout(r, 200));
      sm.destroy();

      expect(sm.currentState).toBe('Healthy');
    });

    it('验证失败后回到 VisualMode，再次探测成功并恢复 Healthy', async () => {
      // 调用序列：
      // 1. VisualMode 探测 → true → Recovering
      // 2. Recovering 验证 #1 → false → VisualMode
      // 3. VisualMode 探测 → true → Recovering
      // 4. Recovering 验证 #1 → true
      // 5. Recovering 验证 #2 → true → Healthy
      callbacks.onCdpRecoverProbe
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      const sm = new ShopStateMachine('shop-c16b', 'VisualMode', callbacks, {
        recoverProbeIntervalMs: 20,
        recoverVerifyCount: 2,
        recoverVerifyIntervalMs: 5,
        recoverVerifyTimeoutMs: 5000,
        recoverCooldownMs: 0,
        visualPollIntervalMs: 1000,
      });
      sm.on('error', () => {});
      sm.start();

      await new Promise((r) => setTimeout(r, 300));
      sm.destroy();

      expect(sm.currentState).toBe('Healthy');
    });
  });

  describe('C-17: SilentWait 累计达上限 → Error', () => {
    it('连续 3 次 SilentWait 后进入 Error', async () => {
      const sm = new ShopStateMachine('shop-c17', 'VisualMode', callbacks, {
        recoverProbeIntervalMs: 10000,
        visualPollIntervalMs: 10000,
        silentWaitDurationMs: 30,
        silentWaitMaxConsecutive: 3,
      });
      sm.on('error', () => {});
      sm.on('alert', () => {});
      sm.start();

      // 第 1 次 SilentWait
      sm.onIdentifyFailure();
      sm.onIdentifyFailure();
      await new Promise<void>((resolve) => sm.once('transition', () => resolve()));
      expect(sm.currentState).toBe('SilentWait');
      await new Promise((r) => setTimeout(r, 50));
      // SilentWait 结束后回到 VisualMode
      expect(['VisualMode', 'SilentWait', 'Recovering']).toContain(sm.currentState);

      // 第 2 次 SilentWait
      sm.onIdentifyFailure();
      sm.onIdentifyFailure();
      await new Promise<void>((resolve) => sm.once('transition', () => resolve()));
      expect(sm.currentState).toBe('SilentWait');
      await new Promise((r) => setTimeout(r, 50));

      // 第 3 次 SilentWait → Error
      const errorTransition = new Promise<void>((resolve) => {
        const onTransition = (event: { to: string }): void => {
          if (event.to === 'Error') {
            sm.off('transition', onTransition);
            resolve();
          }
        };
        sm.on('transition', onTransition);
      });
      sm.onIdentifyFailure();
      sm.onIdentifyFailure();
      await errorTransition;
      expect(sm.currentState).toBe('Error');

      sm.destroy();
      expect(callbacks.onEnterError).toHaveBeenCalled();
    });
  });
});
