import type { Database } from '../db/Database';
import type { AlertManager } from './AlertManager';
import type { AppLogger } from '../logging/logger';

export interface AccuracyStats {
  shopId: string;
  period: 'day' | 'week' | 'month';
  totalReplies: number;
  ruleMatched: number;
  aiReplies: number;
  thumbsUp: number;
  thumbsDown: number;
  noFeedback: number;
  accuracy: number;
  meetsTarget: boolean;
  target: number;
}

export interface AccuracyTrendPoint {
  timestamp: number;
  accuracy: number;
  totalReplies: number;
  thumbsDown: number;
}

export interface OptimizationSuggestion {
  type: 'new_faq' | 'update_rule' | 'review_prompt';
  description: string;
  examples: string[];
  priority: 'high' | 'medium' | 'low';
}

const ACCURACY_TARGET = 95;
const PERIOD_MS: Record<string, number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

export class AccuracyMonitor {
  constructor(
    private db: Database,
    private alertManager: AlertManager,
    private logger?: AppLogger,
  ) {}

  getStats(shopId: string, period: 'day' | 'week' | 'month' = 'day'): AccuracyStats {
    const since = Date.now() - PERIOD_MS[period];
    const audits = this.db.audit.listRecentSince(shopId, since, 10000);
    const feedbacks = this.db.feedback.listByShop(shopId, 10000);

    const recentFeedbacks = feedbacks.filter((f) => f.createdAt >= since);
    const thumbsUp = recentFeedbacks.filter((f) => f.rating > 0).length;
    const thumbsDown = recentFeedbacks.filter((f) => f.rating < 0).length;
    const totalReplies = audits.length;
    // 防御：反馈窗口与 audit 窗口不一致时 noFeedback 不得为负
    const noFeedback = Math.max(0, totalReplies - thumbsUp - thumbsDown);

    const ruleMatched = audits.filter((a) => !a.modelVersion || a.modelVersion === 'rule_engine').length;
    const aiReplies = totalReplies - ruleMatched;

    let accuracy: number;
    if (totalReplies === 0) {
      accuracy = 100;
    } else if (thumbsUp + thumbsDown === 0) {
      // 无任何反馈：无法评估，中性记 100（避免误报低准确率）
      accuracy = 100;
    } else {
      // 基于有反馈样本的口径：好评 / (好评+差评)，避免无反馈回复被计入分母导致口径失真
      accuracy = thumbsUp / (thumbsUp + thumbsDown) * 100;
    }

    return {
      shopId,
      period,
      totalReplies,
      ruleMatched,
      aiReplies,
      thumbsUp,
      thumbsDown,
      noFeedback,
      accuracy: Math.round(accuracy * 100) / 100,
      meetsTarget: accuracy >= ACCURACY_TARGET,
      target: ACCURACY_TARGET,
    };
  }

  getTrend(shopId: string, days = 7): AccuracyTrendPoint[] {
    const points: AccuracyTrendPoint[] = [];
    const dayMs = 24 * 60 * 60 * 1000;
    const now = new Date();

    for (let i = days - 1; i >= 0; i--) {
      // 本地时区日界（此前 UTC 零点对齐导致"当天"口径偏移 8 小时）
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const dayStartAligned = d.getTime();
      const dayEnd = dayStartAligned + dayMs;

      const audits = this.db.audit.listRecentSince(shopId, dayStartAligned, 10000)
        .filter((a) => a.createdAt < dayEnd);
      const feedbacks = this.db.feedback.listByShop(shopId, 10000)
        .filter((f) => f.createdAt >= dayStartAligned && f.createdAt < dayEnd);

      const totalReplies = audits.length;
      const thumbsUp = feedbacks.filter((f) => f.rating > 0).length;
      const thumbsDown = feedbacks.filter((f) => f.rating < 0).length;
      let accuracy: number;
      if (totalReplies === 0) {
        accuracy = 100;
      } else if (thumbsUp + thumbsDown === 0) {
        accuracy = 100;
      } else {
        accuracy = thumbsUp / (thumbsUp + thumbsDown) * 100;
      }

      points.push({
        timestamp: dayStartAligned,
        accuracy: Math.round(accuracy * 100) / 100,
        totalReplies,
        thumbsDown,
      });
    }

    return points;
  }

  checkAndAlert(shopId: string): void {
    const stats = this.getStats(shopId, 'day');
    if (stats.totalReplies < 10) return;

    if (stats.accuracy < 90) {
      void this.alertManager.fire({
        name: 'accuracy_critical',
        level: 'critical',
        title: `店铺 ${shopId} 准确率严重偏低`,
        message: `当日准确率 ${stats.accuracy}%，低于 90% 临界值。负反馈 ${stats.thumbsDown} 条，总回复 ${stats.totalReplies} 条。`,
        shopId,
      });
    } else if (stats.accuracy < ACCURACY_TARGET) {
      void this.alertManager.fire({
        name: 'accuracy_warning',
        level: 'warn',
        title: `店铺 ${shopId} 准确率未达标`,
        message: `当日准确率 ${stats.accuracy}%，低于 ${ACCURACY_TARGET}% 目标。负反馈 ${stats.thumbsDown} 条，总回复 ${stats.totalReplies} 条。`,
        shopId,
      });
    }

    const trend = this.getTrend(shopId, 3);
    const allBelowTarget = trend.every((t) => t.accuracy < ACCURACY_TARGET && t.totalReplies >= 10);
    if (allBelowTarget && trend.length === 3) {
      void this.alertManager.fire({
        name: 'accuracy_continuous_low',
        level: 'critical',
        title: `店铺 ${shopId} 连续 3 天准确率未达标`,
        message: `近 3 天准确率分别为：${trend.map((t) => t.accuracy + '%').join('、')}。建议检查 FAQ 库和规则引擎配置。`,
        shopId,
      });
    }
  }

  getOptimizationSuggestions(shopId: string): OptimizationSuggestion[] {
    const suggestions: OptimizationSuggestion[] = [];
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const feedbacks = this.db.feedback.listByShop(shopId, 1000)
      .filter((f) => f.createdAt >= since && f.rating < 0);

    if (feedbacks.length === 0) {
      return suggestions;
    }

    const negativeAudits = feedbacks
      .map((f) => this.db.audit.listRecent(shopId, 1000).find((a) => a.id === f.auditId))
      .filter((a): a is NonNullable<typeof a> => a !== null && a !== undefined);

    const questionGroups = new Map<string, string[]>();
    for (const audit of negativeAudits) {
      const key = this.categorizeQuestion(audit.userMessage);
      if (!questionGroups.has(key)) {
        questionGroups.set(key, []);
      }
      questionGroups.get(key)!.push(audit.userMessage);
    }

    for (const [category, questions] of questionGroups) {
      if (questions.length >= 2) {
        suggestions.push({
          type: 'new_faq',
          description: `分类 "${category}" 有 ${questions.length} 条负反馈，建议新增 FAQ 覆盖此类问题`,
          examples: questions.slice(0, 3),
          priority: questions.length >= 5 ? 'high' : 'medium',
        });
      }
    }

    if (negativeAudits.length >= 5) {
      suggestions.push({
        type: 'update_rule',
        description: `近 7 天有 ${negativeAudits.length} 条负反馈，建议检查规则引擎匹配是否准确`,
        examples: negativeAudits.slice(0, 3).map((a) => a.userMessage),
        priority: 'medium',
      });
    }

    if (negativeAudits.length >= 10) {
      suggestions.push({
        type: 'review_prompt',
        description: `负反馈数量较多 (${negativeAudits.length})，建议审查 Prompt 模板是否需要优化`,
        examples: [],
        priority: 'high',
      });
    }

    return suggestions.sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return order[a.priority] - order[b.priority];
    });
  }

  private categorizeQuestion(text: string): string {
    const lower = text.toLowerCase();
    if (/退货|退款|退钱|换货/.test(lower)) return '售后问题';
    if (/物流|快递|发货|到货/.test(lower)) return '物流问题';
    if (/尺码|尺寸|大小/.test(lower)) return '尺码问题';
    if (/价格|多少钱|便宜/.test(lower)) return '价格问题';
    if (/质量|破损|损坏/.test(lower)) return '质量问题';
    if (/活动|优惠|满减|券/.test(lower)) return '活动问题';
    return '其他问题';
  }
}
