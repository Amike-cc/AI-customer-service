/**
 * 学习管道 - 5 阶段闭环
 *
 *   collect → clean → score → extract → validate
 *
 * 定期从审计日志中采集 AI 回复，清洗后评分，从优质对话中提取
 * 可复用模式写入 learned_patterns 表，供 PatternMatcher 在回复管道中匹配。
 */
import { createHash } from 'crypto';
import type { AppLogger } from '../logging/logger';
import type { Config } from '../config/schema';
import type { AuditRepo, AuditRecordWithMeta } from '../db/repos/AuditRepo';
import type { QualityRepo } from '../db/repos/QualityRepo';
import type { LearningRepo, LearnedPatternInput } from '../db/repos/LearningRepo';
import type { FeedbackRepo } from '../db/repos/FeedbackRepo';
import type { PatternMatcher } from './PatternMatcher';
import { QualityEvaluator } from './QualityEvaluator';
import { normalizeQuestion } from '../cache/similarity';

interface PipelineDeps {
  auditRepo: AuditRepo;
  qualityRepo: QualityRepo;
  learningRepo: LearningRepo;
  feedbackRepo: FeedbackRepo;
  qualityEvaluator: QualityEvaluator;
  patternMatcher: PatternMatcher;
  config: Config;
  logger: AppLogger;
}

interface PipelineStageMetrics {
  collectedCount: number;
  cleanedCount: number;
  scoredCount: number;
  extractedCount: number;
  validatedCount: number;
}

interface GroupedRecord {
  questionPattern: string;
  questionHash: string;
  records: Array<{ record: AuditRecordWithMeta; overall: number }>;
}

const INVALID_SESSION_IDS = new Set([
  '会话',
  '当前会话',
  'default',
  '/pc_seller_v2/main/workspace',
]);

function normalizeObservedAuditText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (/^(?:昨天\s*)?\d{1,2}:\d{2}(?::\d{2})?$/.test(line)) return false;
      return !/^(?:已读|未读|智能客服|人工|系统消息|商家配置发送|抖音电商智能客服发送)$/.test(line);
    })
    .join('')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export class LearningPipeline {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private deps: PipelineDeps) {}

  start(): void {
    if (this.timer) return;
    const intervalMs = this.deps.config.learning.run_interval_ms;
    this.timer = setInterval(() => {
      // 互斥：上一次执行未完成时跳过本次（定时与手动触发可能重叠）
      if (this.running) {
        this.deps.logger.debug('学习管道上一次执行未完成，跳过本次定时触发');
        return;
      }
      this.run().catch((err) => {
        this.deps.logger.error({ err }, '学习管道定时执行失败');
      });
    }, intervalMs);
    this.timer.unref?.();
    this.deps.logger.info({ intervalMs }, '学习管道已启动');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.deps.logger.info('学习管道已停止');
    }
  }

  async run(shopId?: string): Promise<PipelineStageMetrics> {
    // 互斥：定时任务与手动触发重叠时，后到者直接复用前者的结果（避免重复 addRun/重复提取）
    if (this.running) {
      this.deps.logger.debug('学习管道正在执行中，本次调用跳过');
      const metrics: PipelineStageMetrics = {
        collectedCount: 0,
        cleanedCount: 0,
        scoredCount: 0,
        extractedCount: 0,
        validatedCount: 0,
      };
      return metrics;
    }
    this.running = true;
    const startedAt = Date.now();
    const shopIds = shopId ? [shopId] : this.collectShopIds();
    const metrics: PipelineStageMetrics = {
      collectedCount: 0,
      cleanedCount: 0,
      scoredCount: 0,
      extractedCount: 0,
      validatedCount: 0,
    };

    let runShopId = shopId ?? null;
    if (!runShopId && shopIds.length === 1) runShopId = shopIds[0];

    const runId = this.deps.learningRepo.addRun({
      shopId: runShopId,
      startedAt,
      completedAt: 0,
      collectedCount: 0,
      extractedCount: 0,
      validatedCount: 0,
      status: 'running',
    });

    try {
      for (const sid of shopIds) {
        const result = this.processShop(sid);
        metrics.collectedCount += result.collectedCount;
        metrics.cleanedCount += result.cleanedCount;
        metrics.scoredCount += result.scoredCount;
        metrics.extractedCount += result.extractedCount;
        metrics.validatedCount += result.validatedCount;
      }

      this.deps.learningRepo.updateRun(runId, {
        completedAt: Date.now(),
        collectedCount: metrics.collectedCount,
        extractedCount: metrics.extractedCount,
        validatedCount: metrics.validatedCount,
        status: 'completed',
        metricsJson: JSON.stringify(metrics),
      });

      this.deps.logger.info(metrics, '学习管道执行完成');
      return metrics;
    } catch (err) {
      this.deps.learningRepo.updateRun(runId, {
        completedAt: Date.now(),
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      this.running = false;
    }
  }

  private collectShopIds(): string[] {
    const lookbackMs = this.deps.config.learning.lookback_hours * 3600000;
    const since = Date.now() - lookbackMs;
    const records = this.deps.auditRepo.listSince(since);
    const shopIds = new Set<string>();
    for (const r of records) shopIds.add(r.shopId);
    return Array.from(shopIds);
  }

  private processShop(shopId: string): PipelineStageMetrics {
    const metrics: PipelineStageMetrics = {
      collectedCount: 0,
      cleanedCount: 0,
      scoredCount: 0,
      extractedCount: 0,
      validatedCount: 0,
    };

    const collected = this.collect(shopId);
    metrics.collectedCount = collected.length;

    const cleaned = this.clean(collected);
    metrics.cleanedCount = cleaned.length;

    const scored = this.score(cleaned, shopId);
    metrics.scoredCount = scored.length;

    const extracted = this.extract(scored, shopId);
    metrics.extractedCount = extracted;

    const validated = this.validate(shopId);
    metrics.validatedCount = validated;

    return metrics;
  }

  private collect(shopId: string): AuditRecordWithMeta[] {
    const lookbackMs = this.deps.config.learning.lookback_hours * 3600000;
    const since = Date.now() - lookbackMs;
    const records = this.deps.auditRepo.listRecentSince(shopId, since, 1000);
    return records.filter((r) => {
      if (r.modelVersion.startsWith('cache')) return false;
      if (r.modelVersion.startsWith('rule:')) return false;
      if (INVALID_SESSION_IDS.has(r.sessionId.trim())) return false;
      return true;
    });
  }

  private clean(records: AuditRecordWithMeta[]): AuditRecordWithMeta[] {
    const seen = new Set<string>();
    const result: AuditRecordWithMeta[] = [];
    // 用 Set 存储已知回复的归一化文本，实现 O(1) 精确匹配（避免 O(N²) 子串扫描）
    const knownReplies = new Set(
      records
        .map((record) => normalizeObservedAuditText(record.aiReply))
        .filter((reply) => reply.length >= 6),
    );

    for (const r of records) {
      if (r.modelVersion.includes('sensitive_blocked')) continue;
      if (!r.userMessage || r.userMessage.trim().length < 5) continue;
      if (!r.aiReply || r.aiReply.trim().length < 10) continue;
      if (/^[\s\p{Emoji}\p{Punctuation}]+$/u.test(r.aiReply)) continue;

      const normalizedUser = normalizeObservedAuditText(r.userMessage);
      // 修正匹配方向：判断该用户消息本身是否已是某个已知 AI 回复（错位/脏数据），
      // 用 Set 精确匹配，而非原反向子串判断 normalizedUser.includes(reply)
      if (knownReplies.has(normalizedUser)) continue;

      const hash = createHash('md5').update(r.userMessage.trim().toLowerCase()).digest('hex');
      if (seen.has(hash)) continue;
      seen.add(hash);
      result.push(r);
    }

    return result;
  }

  private score(
    records: AuditRecordWithMeta[],
    shopId: string,
  ): Array<{ record: AuditRecordWithMeta; overall: number }> {
    const threshold = this.deps.config.learning.min_quality_threshold;
    const result: Array<{ record: AuditRecordWithMeta; overall: number }> = [];

    for (const record of records) {
      const feedback = this.deps.feedbackRepo.getByAudit(record.id);
      const feedbackRating = feedback?.rating ?? null;

      const scores = this.deps.qualityEvaluator.evaluate({
        confidence: record.confidence,
        latencyMs: record.latencyMs,
        reply: record.aiReply,
        modelVersion: record.modelVersion,
        feedbackRating,
      });

      this.deps.qualityRepo.add({
        auditId: record.id,
        shopId,
        confidenceScore: scores.confidence,
        latencyScore: scores.latency,
        structureScore: scores.structure,
        safetyScore: scores.safety,
        feedbackScore: scores.feedback,
        overallScore: scores.overall,
      });

      if (scores.overall >= threshold) {
        result.push({ record, overall: scores.overall });
      }
    }

    return result;
  }

  private extract(
    scored: Array<{ record: AuditRecordWithMeta; overall: number }>,
    shopId: string,
  ): number {
    const groups = new Map<string, GroupedRecord>();
    const minSamples = this.deps.config.learning.min_samples_for_pattern;
    const maxPatterns = this.deps.config.learning.max_patterns_per_shop;

    for (const { record, overall } of scored) {
      const questionPattern = normalizeQuestion(record.userMessage);
      if (!questionPattern) continue;

      const questionHash = createHash('md5').update(questionPattern).digest('hex');
      const key = `${shopId}:${questionHash}`;

      const existing = groups.get(key);
      if (existing) {
        existing.records.push({ record, overall });
      } else {
        groups.set(key, {
          questionPattern,
          questionHash,
          records: [{ record, overall }],
        });
      }
    }

    let extractedCount = 0;
    const currentCount = this.deps.learningRepo.countActivePatterns(shopId);

    for (const group of groups.values()) {
      if (group.records.length < minSamples) continue;
      if (currentCount + extractedCount >= maxPatterns) break;

      const avgOverall = group.records.reduce((s, r) => s + r.overall, 0) / group.records.length;
      const best = group.records.reduce((best, r) => (r.overall > best.overall ? r : best));

      const existingPattern = this.deps.learningRepo.getPatternByHash(shopId, group.questionHash);
      const sourceAuditIds = JSON.stringify(group.records.map((r) => r.record.id));

      if (existingPattern) {
        if (avgOverall > existingPattern.avgQuality) {
          this.deps.learningRepo.updatePatternQuality(
            existingPattern.id,
            avgOverall,
            best.record.aiReply,
            sourceAuditIds,
          );
        }
      } else {
        const input: LearnedPatternInput = {
          shopId,
          questionPattern: group.questionPattern,
          answerTemplate: best.record.aiReply,
          questionHash: group.questionHash,
          avgQuality: avgOverall,
          sourceAuditIds,
        };
        this.deps.learningRepo.addPattern(input);
        extractedCount++;
      }
    }

    if (extractedCount > 0) {
      this.deps.patternMatcher.reload(shopId);
    }

    return extractedCount;
  }

  private validate(shopId: string): number {
    const decayMs = this.deps.config.learning.pattern_decay_days * 86400000;
    const deprecated = this.deps.learningRepo.deprecateStalePatterns(decayMs);
    if (deprecated > 0) {
      // 全局衰减会废弃所有店铺的陈旧模式，必须重载全部店铺的 PatternMatcher
      // （此前只 reload 当前店铺，其他店铺内存缓存仍持有已废弃模式继续命中）
      for (const sid of this.collectShopIds()) {
        this.deps.patternMatcher.reload(sid);
      }
      this.deps.logger.info({ shopId, deprecated }, '学习模式衰减检查完成');
    }
    return deprecated;
  }
}
