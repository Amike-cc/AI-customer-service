/**
 * 闭环学习系统类型定义
 */

export interface QualityDimension {
  confidence: number;
  latency: number;
  structure: number;
  safety: number;
  feedback: number;
  overall: number;
}

export interface QualityWeights {
  confidence: number;
  latency: number;
  structure: number;
  safety: number;
  feedback: number;
}

export interface QualityEvaluationInput {
  confidence?: number | null;
  latencyMs?: number | null;
  reply: string;
  modelVersion: string;
  feedbackRating?: number | null;
}

export interface PatternMatchResult {
  matched: boolean;
  answer?: string;
  patternId?: number;
  similarity?: number;
  matchType?: 'exact' | 'semantic';
}

export interface LearnedPatternStats {
  totalPatterns: number;
  activePatterns: number;
  totalMatches: number;
  avgQuality: number;
  positiveFeedback: number;
  negativeFeedback: number;
}

export const DEFAULT_QUALITY_WEIGHTS: QualityWeights = {
  confidence: 0.30,
  latency: 0.15,
  structure: 0.15,
  safety: 0.20,
  feedback: 0.20,
};
