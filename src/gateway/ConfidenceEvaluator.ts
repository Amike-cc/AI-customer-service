/**
 * 置信度评估器
 * 评估模型回复的可信度，用于级联升级决策
 *
 * 5 维加权评分：
 *   confidence = 0.30 * finishReasonScore
 *              + 0.20 * lengthScore
 *              + 0.20 * uncertaintyScore
 *              + 0.15 * structureScore
 *              + 0.15 * tierScore
 */
import type { ModelTier } from '../scheduler/types';

const UNCERTAINTY_PATTERNS = [
  '可能', '也许', '不确定', '无法确定', '不清楚',
  '建议咨询', '请联系人工', '无法回答', '不太确定',
  '大概', '应该',
];

const TIER_SCORES: Record<ModelTier, number> = {
  tier1: 0.7,
  tier2: 0.85,
  tier3: 0.95,
};

export interface ConfidenceEvalParams {
  content: string;
  finishReason?: string;
  truncated: boolean;
  model: string;
  tier: ModelTier;
  maxTokens: number;
}

export class ConfidenceEvaluator {
  evaluate(params: ConfidenceEvalParams): number {
    // fallback / 熔断器开启 等失败响应不应被当作正常回复：直接给 0 分，
    // 让 ModelGateway.cascade 因 confidence < threshold 而继续降级到其它 provider
    if (params.model === 'fallback' || params.model === 'circuit-open') {
      return 0;
    }
    const finishScore = this.evalFinishReason(params.finishReason, params.truncated);
    const lengthScore = this.evalLength(params.content, params.maxTokens);
    const uncertaintyScore = this.evalUncertainty(params.content);
    const structureScore = this.evalStructure(params.content);
    const tierScore = TIER_SCORES[params.tier] ?? 0.8;

    const confidence =
      0.30 * finishScore +
      0.20 * lengthScore +
      0.20 * uncertaintyScore +
      0.15 * structureScore +
      0.15 * tierScore;

    return Math.max(0, Math.min(1, confidence));
  }

  shouldUpgrade(confidence: number, currentTier: ModelTier, thresholds: Record<ModelTier, number>): boolean {
    const threshold = thresholds[currentTier];
    return confidence < threshold;
  }

  private evalFinishReason(finishReason?: string, truncated?: boolean): number {
    if (truncated || finishReason === 'length') return 0.3;
    if (finishReason === 'stop') return 1.0;
    return 0.7;
  }

  private evalLength(content: string, maxTokens: number): number {
    const len = content.length;
    // 中文 1 token ≈ 1.5~2 字符，先用字符数估算 token 数，再与 maxTokens 比较，
    // 避免直接用字符数对比 token 阈值导致 lengthScore 永远偏松
    const estTokens = Math.ceil(len / 1.5);
    if (len < 10) return 0.2;
    if (estTokens > maxTokens * 0.95) return 0.5;
    if (len >= 50) return 1.0;
    return 0.7;
  }

  private evalUncertainty(content: string): number {
    let hitCount = 0;
    for (const pattern of UNCERTAINTY_PATTERNS) {
      if (content.includes(pattern)) hitCount++;
    }
    return Math.max(0.2, 1.0 - hitCount * 0.2);
  }

  private evalStructure(content: string): number {
    const trimmed = content.trim();
    if (trimmed.length === 0) return 0.2;
    const lastChar = trimmed.slice(-1);
    if (['。', '！', '？', '~', '】', ')', '）'].includes(lastChar)) return 1.0;
    if (['，', '、', '；', ','].includes(lastChar)) return 0.4;
    return 0.6;
  }
}
