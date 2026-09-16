/**
 * AccuracyMonitor 单元测试
 */
import { AccuracyMonitor } from '@/monitor/AccuracyMonitor';
import type { Database } from '@/db/Database';
import type { AlertManager } from '@/monitor/AlertManager';
import type { AuditRecordWithMeta } from '@/db/repos/AuditRepo';
import type { FeedbackRecord } from '@/db/repos/FeedbackRepo';

function makeDb(audits: AuditRecordWithMeta[], feedbacks: FeedbackRecord[]): Database {
  return {
    audit: {
      listRecentSince: jest.fn().mockReturnValue(audits),
      listRecent: jest.fn().mockReturnValue(audits),
    },
    feedback: {
      listByShop: jest.fn().mockReturnValue(feedbacks),
    },
  } as unknown as Database;
}

function makeAlertManager(): AlertManager {
  return { fire: jest.fn().mockResolvedValue(undefined) } as unknown as AlertManager;
}

function makeAudit(overrides: Partial<AuditRecordWithMeta> = {}): AuditRecordWithMeta {
  return {
    id: 1,
    shopId: 'shop1',
    sessionId: 'sess1',
    userMessage: '你好',
    aiReply: '您好',
    modelVersion: 'deepseek-v4-flash',
    promptHash: 'hash',
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeFeedback(rating: number, auditId: number = 1): FeedbackRecord {
  return {
    id: 1,
    auditId,
    shopId: 'shop1',
    sessionId: 'sess1',
    rating,
    comment: null,
    createdAt: Date.now(),
  };
}

describe('AccuracyMonitor', () => {
  let monitor: AccuracyMonitor;
  let alertManager: AlertManager;

  beforeEach(() => {
    alertManager = makeAlertManager();
  });

  it('getStats 无数据时 accuracy=100', () => {
    const db = makeDb([], []);
    monitor = new AccuracyMonitor(db, alertManager);
    const stats = monitor.getStats('shop1', 'day');
    expect(stats.accuracy).toBe(100);
    expect(stats.totalReplies).toBe(0);
    expect(stats.meetsTarget).toBe(true);
  });

  it('getStats 计算准确率 = 好评 / (好评+差评) * 100', () => {
    const audits = Array.from({ length: 10 }, (_, i) => makeAudit({ id: i + 1 }));
    const feedbacks = [
      makeFeedback(1, 1),
      makeFeedback(-1, 2),
    ];
    const db = makeDb(audits, feedbacks);
    monitor = new AccuracyMonitor(db, alertManager);
    const stats = monitor.getStats('shop1', 'week');
    expect(stats.totalReplies).toBe(10);
    expect(stats.thumbsDown).toBe(1);
    // 新口径：基于有反馈样本（好评 1 / 总反馈 2 = 50%），避免无反馈回复稀释分母
    expect(stats.accuracy).toBe(50);
  });

  it('getStats 无反馈时 accuracy=100（中性）', () => {
    const audits = Array.from({ length: 10 }, (_, i) => makeAudit({ id: i + 1 }));
    const db = makeDb(audits, []);
    monitor = new AccuracyMonitor(db, alertManager);
    const stats = monitor.getStats('shop1', 'day');
    expect(stats.accuracy).toBe(100);
    expect(stats.noFeedback).toBe(10);
  });

  it('getStats meetsTarget 判定（>=95）', () => {
    const audits = Array.from({ length: 100 }, (_, i) => makeAudit({ id: i + 1 }));
    // 99 好评 + 1 差评 → 99%，达标
    const feedbacks = [
      ...Array.from({ length: 99 }, (_, i) => makeFeedback(1, i + 1)),
      makeFeedback(-1, 100),
    ];
    const db = makeDb(audits, feedbacks);
    monitor = new AccuracyMonitor(db, alertManager);
    const stats = monitor.getStats('shop1', 'month');
    expect(stats.accuracy).toBe(99);
    expect(stats.meetsTarget).toBe(true);
  });

  it('getTrend 返回 days 个数据点', () => {
    const db = makeDb([], []);
    monitor = new AccuracyMonitor(db, alertManager);
    const trend = monitor.getTrend('shop1', 7);
    expect(trend).toHaveLength(7);
    expect(trend.every((t) => typeof t.accuracy === 'number')).toBe(true);
  });

  it('checkAndAlert accuracy<90 触发 critical', () => {
    const audits = Array.from({ length: 20 }, (_, i) => makeAudit({ id: i + 1 }));
    const feedbacks = Array.from({ length: 3 }, (_, i) => makeFeedback(-1, i + 1));
    const db = makeDb(audits, feedbacks);
    monitor = new AccuracyMonitor(db, alertManager);
    monitor.checkAndAlert('shop1');
    expect(alertManager.fire).toHaveBeenCalled();
  });

  it('checkAndAlert accuracy<95 触发 warn', () => {
    const audits = Array.from({ length: 20 }, (_, i) => makeAudit({ id: i + 1 }));
    const feedbacks = [makeFeedback(-1, 1), makeFeedback(-1, 2)];
    const db = makeDb(audits, feedbacks);
    monitor = new AccuracyMonitor(db, alertManager);
    monitor.checkAndAlert('shop1');
    expect(alertManager.fire).toHaveBeenCalled();
  });

  it('getOptimizationSuggestions 无负反馈返回空', () => {
    const db = makeDb([], []);
    monitor = new AccuracyMonitor(db, alertManager);
    const suggestions = monitor.getOptimizationSuggestions('shop1');
    expect(suggestions).toHaveLength(0);
  });

  it('getOptimizationSuggestions 负反馈聚类生成建议', () => {
    const audits = [
      makeAudit({ id: 1, userMessage: '怎么退货' }),
      makeAudit({ id: 2, userMessage: '退款怎么办' }),
      makeAudit({ id: 3, userMessage: '换货流程' }),
    ];
    const feedbacks = [
      makeFeedback(-1, 1),
      makeFeedback(-1, 2),
      makeFeedback(-1, 3),
    ];
    const db = makeDb(audits, feedbacks);
    monitor = new AccuracyMonitor(db, alertManager);
    const suggestions = monitor.getOptimizationSuggestions('shop1');
    expect(suggestions.length).toBeGreaterThan(0);
    const faqSuggestion = suggestions.find((s) => s.type === 'new_faq');
    expect(faqSuggestion).toBeDefined();
  });
});
