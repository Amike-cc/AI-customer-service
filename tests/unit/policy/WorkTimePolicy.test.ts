import { WorkTimePolicy, type WorkTimeConfig } from '@/policy/WorkTimePolicy';
import type { AppLogger } from '@/logging/logger';
import type { PendingMessageRepo } from '@/db/repos/PendingMessageRepo';

function makeLogger(): AppLogger {
  return {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  } as unknown as AppLogger;
}

function makeConfig(overrides: Partial<WorkTimeConfig> = {}): WorkTimeConfig {
  return {
    enabled: true,
    timezone: 'Asia/Shanghai',
    workDays: [1, 2, 3, 4, 5],
    workStart: '09:00',
    workEnd: '18:00',
    offHoursReply: '工作时间 {start}-{end}',
    pendingProcessBatchSize: 10,
    pendingProcessIntervalMs: 1000,
    ...overrides,
  };
}

function makeRepo() {
  const pending = [{
    id: 1,
    shopId: '1',
    sessionId: 's1',
    buyerName: 'buyer',
    messageText: 'hello',
    receivedAt: Date.now(),
    processedAt: null,
  }];
  const processed = new Set<number>();
  const repo = {
    listPending: jest.fn(() => pending.filter((m) => !processed.has(m.id))),
    countPending: jest.fn(() => pending.filter((m) => !processed.has(m.id)).length),
    markProcessed: jest.fn((id: number) => { processed.add(id); }),
  } as unknown as PendingMessageRepo;
  return { repo, processed };
}

describe('WorkTimePolicy', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('统一使用配置时区判断工作日和工作时间', () => {
    const policy = new WorkTimePolicy(makeConfig({
      timezone: 'America/Los_Angeles',
      workDays: [1],
      workStart: '08:00',
      workEnd: '09:00',
    }), makeLogger());

    // 洛杉矶为周一 08:30；在亚洲宿主机上已经是周二。
    expect(policy.isWorkingNow(new Date('2024-01-08T16:30:00Z'))).toBe(true);
    expect(policy.msUntilNextWorkStart(new Date('2024-01-08T15:30:00Z'))).toBe(30 * 60 * 1000);
  });

  it('跨天班次在凌晨使用前一天的工作日', () => {
    const policy = new WorkTimePolicy(makeConfig({
      timezone: 'Asia/Shanghai',
      workDays: [1],
      workStart: '22:00',
      workEnd: '08:00',
    }), makeLogger());
    expect(policy.isWorkingNow(new Date('2024-01-08T17:00:00Z'))).toBe(true); // 周二 01:00，属于周一夜班
  });

  it('到达工作时间后自动处理暂存消息', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-08T01:30:00Z')); // 上海周一 09:30
    const { repo, processed } = makeRepo();
    const processor = jest.fn(async () => {});
    const policy = new WorkTimePolicy(makeConfig(), makeLogger(), repo);
    policy.registerProcessor('1', processor);

    await jest.advanceTimersByTimeAsync(0);
    expect(processor).toHaveBeenCalledTimes(1);
    expect(processed.has(1)).toBe(true);
    policy.stopPendingTimer();
  });

  it('处理器失败时保留消息供下次重试', async () => {
    const { repo, processed } = makeRepo();
    const processor = jest.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValue(undefined);
    const policy = new WorkTimePolicy(makeConfig(), makeLogger(), repo);
    policy.registerProcessor('1', processor);

    await policy.drainPendingMessages(repo);
    expect(processed.has(1)).toBe(false);
    await policy.drainPendingMessages(repo);
    expect(processed.has(1)).toBe(true);
    policy.stopPendingTimer();
  });
});
