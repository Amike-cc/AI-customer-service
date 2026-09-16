/**
 * 质量评估器 - 6 维加权评分
 *
 * 维度：
 *   confidence (0.30) - 模型置信度
 *   latency    (0.15) - 响应延迟（越低越好）
 *   structure  (0.15) - 回复结构完整性
 *   safety     (0.20) - 安全性（已过敏感词检查为 1.0）
 *   feedback   (0.20) - 用户反馈（赞1.0/踩0.0/无0.5）
 */
import {
  type QualityDimension,
  type QualityEvaluationInput,
  type QualityWeights,
  DEFAULT_QUALITY_WEIGHTS,
} from './types';

export class QualityEvaluator {
  private readonly latencyMaxMs = 5000;

  constructor(private weights: QualityWeights = DEFAULT_QUALITY_WEIGHTS) {}

  evaluate(input: QualityEvaluationInput): QualityDimension {
    const confidence = this.scoreConfidence(input.confidence);
    const latency = this.scoreLatency(input.latencyMs);
    const structure = this.scoreStructure(input.reply);
    const safety = this.scoreSafety(input.modelVersion);
    const feedback = this.scoreFeedback(input.feedbackRating);

    const overall =
      confidence * this.weights.confidence +
      latency * this.weights.latency +
      structure * this.weights.structure +
      safety * this.weights.safety +
      feedback * this.weights.feedback;

    return {
      confidence,
      latency,
      structure,
      safety,
      feedback,
      overall: Math.min(1, Math.max(0, overall)),
    };
  }

  private scoreConfidence(confidence?: number | null): number {
    if (confidence == null || Number.isNaN(confidence)) return 0.5;
    return Math.min(1, Math.max(0, confidence));
  }

  private scoreLatency(latencyMs?: number | null): number {
    // NaN 防御：NaN <= 0 为 false 会穿透首个分支，导致 NaN 传播到 overall
    // 使学习评分/模式更新（avgOverall 比较）静默失效
    if (latencyMs == null || !Number.isFinite(latencyMs) || latencyMs <= 0) return 0.5;
    if (latencyMs >= this.latencyMaxMs) return 0;
    return 1 - latencyMs / this.latencyMaxMs;
  }

  private scoreStructure(reply: string): number {
    if (!reply || reply.trim().length === 0) return 0;

    let score = 0;
    const length = reply.length;
    if (length >= 50 && length <= 500) {
      score += 0.4;
    } else if (length >= 20 && length < 50) {
      score += 0.25;
    } else if (length > 500 && length <= 1000) {
      score += 0.3;
    } else if (length < 20) {
      score += 0.1;
    }

    if (/[\n。！？!?]/.test(reply)) score += 0.3;

    if (/[。！？!?,，；;]/.test(reply)) score += 0.15;

    if (reply.includes('\n')) score += 0.15;

    return Math.min(1, score);
  }

  private scoreSafety(modelVersion: string): number {
    if (modelVersion.includes('sensitive_blocked')) return 0;
    return 1.0;
  }

  private scoreFeedback(feedbackRating?: number | null): number {
    if (feedbackRating == null) return 0.5;
    if (feedbackRating > 0) return 1.0;
    if (feedbackRating < 0) return 0.0;
    return 0.5;
  }
}
