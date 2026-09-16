/**
 * 状态机单元测试
 * 详见 docs/16-状态机设计.md
 */
import { ShopStateMachine, type StateMachineCallbacks } from '@/state/ShopStateMachine';

describe('ShopStateMachine', () => {
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

 describe('基础行为', () => {
   it('构造后处于初始状态', () => {
     const sm = new ShopStateMachine('shop1', 'Healthy');
     expect(sm.currentState).toBe('Healthy');
     expect(sm.shopId).toBe('shop1');
   });

    it('transition 触发 transition 事件', async () => {
     const sm = new ShopStateMachine('shop1', 'Healthy');
     const events: Array<{ from: string; to: string }> = [];
     sm.on('transition', (e) => events.push({ from: e.from, to: e.to }));
      await sm.transition('ManualMode');
     expect(events).toHaveLength(1);
     expect(events[0]).toEqual({ from: 'Healthy', to: 'ManualMode' });
   });

    it('相同状态不触发 transition', async () => {
     const sm = new ShopStateMachine('shop1', 'Healthy');
     const events: string[] = [];
     sm.on('transition', (e) => events.push(e.to));
      await sm.transition('Healthy');
     expect(events).toHaveLength(0);
   });
 });

  describe('Healthy 状态', () => {
    it('心跳成功不切换状态', async () => {
      const sm = new ShopStateMachine('shop1', 'Healthy', callbacks, {
        heartbeatIntervalMs: 50,
      });
      sm.start();
      await new Promise((r) => setTimeout(r, 120));
      sm.destroy();
      expect(callbacks.onCdpHeartbeat).toHaveBeenCalled();
      expect(sm.currentState).toBe('Healthy');
    });

    it('连续 2 次心跳失败 → Degrading（过渡态）→ VisualMode', async () => {
      callbacks.onCdpHeartbeat.mockResolvedValue(false);
      const sm = new ShopStateMachine('shop1', 'Healthy', callbacks, {
        heartbeatIntervalMs: 30,
      });
      sm.start();
      await new Promise((r) => setTimeout(r, 150));
      sm.destroy();
      // Degrading 是过渡态，onEnterDegrading 成功后会自动转到 VisualMode
      expect(['Degrading', 'VisualMode']).toContain(sm.currentState);
    });
  });

  describe('Degrading → VisualMode', () => {
    it('onEnterDegrading 成功后切换到 VisualMode', async () => {
      callbacks.onEnterDegrading.mockResolvedValue(undefined);
      const sm = new ShopStateMachine('shop1', 'Degrading', callbacks, {
        degradingTimeoutMs: 5000,
      });
      sm.start();
      await new Promise((r) => setTimeout(r, 50));
      sm.destroy();
      expect(callbacks.onEnterDegrading).toHaveBeenCalled();
      expect(sm.currentState).toBe('VisualMode');
    });

    it('onEnterDegrading 失败 → Error', async () => {
      callbacks.onEnterDegrading.mockRejectedValue(new Error('test'));
      const sm = new ShopStateMachine('shop1', 'Degrading', callbacks, {
        degradingTimeoutMs: 5000,
      });
      // 监听 error 事件避免 unhandled
      sm.on('error', () => {});
      sm.start();
      await new Promise((r) => setTimeout(r, 50));
      sm.destroy();
      expect(sm.currentState).toBe('Error');
    });

    it('Degrading 超时 → Error', async () => {
      // onEnterDegrading 不 resolve，触发超时
      callbacks.onEnterDegrading.mockImplementation(
        () => new Promise(() => {}),
      );
      const sm = new ShopStateMachine('shop1', 'Degrading', callbacks, {
        degradingTimeoutMs: 50,
      });
      sm.start();
      await new Promise((r) => setTimeout(r, 100));
      sm.destroy();
      expect(sm.currentState).toBe('Error');
    });
  });

  describe('VisualMode → Recovering → Healthy', () => {
    it('onCdpRecoverProbe 成功 → Recovering → Healthy', async () => {
      callbacks.onCdpRecoverProbe.mockResolvedValue(true);
      const sm = new ShopStateMachine('shop1', 'VisualMode', callbacks, {
        recoverProbeIntervalMs: 30,
        recoverCooldownMs: 0,
        recoverVerifyCount: 2,
        recoverVerifyIntervalMs: 10,
        recoverVerifyTimeoutMs: 1000,
      });
      sm.start();
      await new Promise((r) => setTimeout(r, 200));
      sm.destroy();
      expect(sm.currentState).toBe('Healthy');
    });

    it('onCdpRecoverProbe 失败保持 VisualMode', async () => {
      callbacks.onCdpRecoverProbe.mockResolvedValue(false);
      const sm = new ShopStateMachine('shop1', 'VisualMode', callbacks, {
        recoverProbeIntervalMs: 30,
        recoverCooldownMs: 0,
      });
      sm.start();
      await new Promise((r) => setTimeout(r, 100));
      sm.destroy();
      expect(sm.currentState).toBe('VisualMode');
    });
  });

 describe('SilentWait', () => {
    it('onIdentifyFailure 累计 2 次进入 SilentWait', async () => {
     const sm = new ShopStateMachine('shop1', 'Healthy', callbacks);
     const transitionDone = new Promise<void>((resolve) => sm.on('transition', () => resolve()));
     sm.start();
     sm.onIdentifyFailure();
     sm.onIdentifyFailure();
     await transitionDone;
     expect(sm.currentState).toBe('SilentWait');
     sm.destroy();
   });

    it('SilentWait 累计 max_consecutive 进入 Error', async () => {
      const sm = new ShopStateMachine('shop1', 'SilentWait', callbacks, {
        silentWaitDurationMs: 20,
        silentWaitMaxConsecutive: 2,
      });
      sm.start(); // 第 1 次 SilentWait
      await new Promise((r) => setTimeout(r, 60)); // 等 SilentWait 结束 → VisualMode
      // 重新触发识别失败进入 SilentWait（第 2 次）
      sm.onIdentifyFailure();
      sm.onIdentifyFailure();
      await new Promise((r) => setTimeout(r, 50));
      sm.destroy();
      expect(sm.currentState).toBe('Error');
    });
  });

 describe('人工接管', () => {
    it('onManualTakeover → ManualMode', async () => {
     const sm = new ShopStateMachine('shop1', 'Healthy', callbacks);
     const transitionDone = new Promise<void>((resolve) => sm.on('transition', () => resolve()));
     sm.start();
     sm.onManualTakeover();
     await transitionDone;
     expect(sm.currentState).toBe('ManualMode');
     sm.destroy();
   });

    it('onManualRelease 从 ManualMode 回到指定状态', async () => {
     const sm = new ShopStateMachine('shop1', 'ManualMode', callbacks);
     const transitionDone = new Promise<void>((resolve) => sm.on('transition', () => resolve()));
     sm.start();
     sm.onManualRelease('Healthy');
     await transitionDone;
     expect(sm.currentState).toBe('Healthy');
     sm.destroy();
   });
 });

 describe('序列化', () => {
    it('toRecord/fromRecord 往返一致', async () => {
     const sm = new ShopStateMachine('shop1', 'VisualMode', callbacks);
     const transitionDone = new Promise<void>((resolve) => sm.on('transition', () => resolve()));
     sm.start();
     sm.onIdentifyFailure();
     sm.onIdentifyFailure();
     await transitionDone;
     const record = sm.toRecord();
     sm.destroy();

      const restored = ShopStateMachine.fromRecord(record, callbacks);
      expect(restored.currentState).toBe('SilentWait');
      expect(restored.shopId).toBe('shop1');
      restored.destroy();
    });
  });

  describe('destroy', () => {
    it('destroy 后所有定时器清理', () => {
      const sm = new ShopStateMachine('shop1', 'Healthy', callbacks, {
        heartbeatIntervalMs: 10,
      });
      sm.start();
      sm.destroy();
      // 不报错即认为正常
      expect(sm.currentState).toBe('Healthy');
    });
  });

  describe('边界条件', () => {
    it('Error 状态不响应 onCdpHeartbeatFailure', () => {
      const sm = new ShopStateMachine('shop1', 'Error', callbacks);
      sm.start();
      sm.onCdpHeartbeatFailure();
      sm.onCdpHeartbeatFailure();
      expect(sm.currentState).toBe('Error');
      sm.destroy();
    });

    it('Error 状态不响应 onIdentifyFailure', () => {
      const sm = new ShopStateMachine('shop1', 'Error', callbacks);
      sm.start();
      sm.onIdentifyFailure();
      sm.onIdentifyFailure();
      expect(sm.currentState).toBe('Error');
      sm.destroy();
    });

    it('onManualRelease 仅在 ManualMode 生效', () => {
      const sm = new ShopStateMachine('shop1', 'Healthy', callbacks);
      sm.start();
      sm.onManualRelease('VisualMode');
      expect(sm.currentState).toBe('Healthy');
      sm.destroy();
    });

    it('onIdentifySuccess 重置 silentWaitCount', async () => {
     const sm = new ShopStateMachine('shop1', 'Healthy', callbacks);
     const transitionDone = new Promise<void>((resolve) => sm.on('transition', () => resolve()));
     sm.start();
     sm.onIdentifyFailure();
     sm.onIdentifyFailure();
     await transitionDone;
     expect(sm.currentState).toBe('SilentWait');
     // 模拟 SilentWait 结束后 onIdentifySuccess 重置计数
     sm.onIdentifySuccess();
     expect(sm.contextSnapshot.silentWaitCount).toBe(0);
     sm.destroy();
   });

    it('Recovering 状态心跳失败 → Degrading', async () => {
      callbacks.onCdpRecoverProbe.mockResolvedValue(true);
      const sm = new ShopStateMachine('shop1', 'VisualMode', callbacks, {
        recoverProbeIntervalMs: 10,
        recoverCooldownMs: 0,
        recoverVerifyCount: 2,
        recoverVerifyIntervalMs: 5,
        recoverVerifyTimeoutMs: 1000,
      });
      sm.start();
      // 等待到达 Healthy
      await new Promise<void>((resolve) => {
        sm.on('transition', (e) => {
          if (e.to === 'Healthy') resolve();
        });
      });
      // 触发心跳失败，等待进入 Degrading
      callbacks.onCdpHeartbeat.mockResolvedValue(false);
      const degradingDone = new Promise<void>((resolve) => {
        sm.on('transition', (e) => {
          if (e.to === 'Degrading') resolve();
        });
      });
      sm.onCdpHeartbeatFailure();
      sm.onCdpHeartbeatFailure();
      await degradingDone;
      expect(sm.currentState).toBe('Degrading');
      sm.destroy();
    });

    it('toRecord 保存完整上下文', () => {
      const sm = new ShopStateMachine('shop1', 'Healthy', callbacks);
      sm.start();
      sm.onIdentifyFailure();
      const record = sm.toRecord();
      expect(record.shopId).toBe('shop1');
      expect(record.state).toBe('Healthy');
      expect(record.identifyFailures).toBe(1);
      expect(record.silentWaitCount).toBe(0);
      sm.destroy();
    });
  });

  describe('人工接管发送闸门（SAFE-TAKEOVER-001）', () => {
    it('onManualTakeover 返回 Promise，await 后状态已进入 ManualMode', async () => {
      const sm = new ShopStateMachine('shop1', 'Healthy', callbacks);
      sm.start();
      const p = sm.onManualTakeover();
      expect(p).toBeInstanceOf(Promise);
      await p;
      // await 必须保证状态转换已完成，而不是仅发起转换
      expect(sm.currentState).toBe('ManualMode');
      sm.destroy();
    });

    it('onManualRelease 等待恢复目标状态完成', async () => {
      const sm = new ShopStateMachine('shop1', 'Healthy', callbacks);
      sm.start();
      await sm.onManualTakeover();
      await sm.onManualRelease('Healthy');
      expect(sm.currentState).toBe('Healthy');
      sm.destroy();
    });

    it('onManualRelease 非 ManualMode 时立即 resolve 且不切状态', async () => {
      const sm = new ShopStateMachine('shop1', 'Healthy', callbacks);
      sm.start();
      await sm.onManualRelease('Healthy');
      expect(sm.currentState).toBe('Healthy');
      sm.destroy();
    });

    it('waitForIdle 等待排队中的转换完成', async () => {
      const sm = new ShopStateMachine('shop1', 'Healthy', callbacks);
      sm.start();
      void sm.transition('ManualMode');
      await sm.waitForIdle();
      expect(sm.currentState).toBe('ManualMode');
      sm.destroy();
    });
  });
});
