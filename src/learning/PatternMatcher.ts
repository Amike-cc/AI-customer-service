/**
 * PatternMatcher - 学习模式匹配器
 *
 * 从 learned_patterns 表加载已学习的优质对话模式，在 ShopSupervisor
 * generateReply 管道中规则引擎未命中之后、Multi-Agent 之前尝试匹配。
 *
 * 匹配策略：
 *   1. 精确匹配 - questionHash === MD5(normalize(questionText))
 *   2. 语义匹配 - bigram + Jaccard 相似度 >= semantic_threshold
 */
import { createHash } from 'crypto';
import type { AppLogger } from '../logging/logger';
import type { Config } from '../config/schema';
import type { LearningRepo, LearnedPattern } from '../db/repos/LearningRepo';
import { bigrams, jaccard, normalizeQuestion } from '../cache/similarity';
import type { PatternMatchResult } from './types';

interface PatternMatcherDeps {
  learningRepo: LearningRepo;
  config: Config;
  logger: AppLogger;
}

interface CachedPattern {
  id: number;
  shopId: string;
  questionPattern: string;
  answerTemplate: string;
  questionHash: string;
  matchCount: number;
  feedbackSum: number;
}

export class PatternMatcher {
  private cache = new Map<string, CachedPattern[]>();

  constructor(private deps: PatternMatcherDeps) {}

  loadAll(): void {
    const patterns = this.deps.learningRepo.listAllActivePatterns();
    const grouped = new Map<string, CachedPattern[]>();
    for (const p of patterns) {
      const list = grouped.get(p.shopId) ?? [];
      list.push(this.toCached(p));
      grouped.set(p.shopId, list);
    }
    this.cache = grouped;
    this.deps.logger.info(
      { shops: grouped.size, total: patterns.length },
      '学习模式加载完成',
    );
  }

  reload(shopId: string): void {
    const patterns = this.deps.learningRepo.listPatterns(shopId, 'active');
    this.cache.set(
      shopId,
      patterns.map((p) => this.toCached(p)),
    );
    this.deps.logger.debug({ shopId, count: patterns.length }, '店铺学习模式已重载');
  }

  match(shopId: string, questionText: string): PatternMatchResult {
    const patterns = this.cache.get(shopId);
    if (!patterns || patterns.length === 0) {
      return { matched: false };
    }

    const normalized = normalizeQuestion(questionText);
    if (!normalized) return { matched: false };

    const questionHash = createHash('md5').update(normalized).digest('hex');

    for (const p of patterns) {
      if (p.questionHash === questionHash) {
        this.deps.learningRepo.incrementMatchCount(p.id);
        return {
          matched: true,
          answer: p.answerTemplate,
          patternId: p.id,
          matchType: 'exact',
        };
      }
    }

    const threshold = this.deps.config.learning.semantic_threshold;
    const queryBigrams = bigrams(normalized);
    if (queryBigrams.size === 0) return { matched: false };

    let best: { pattern: CachedPattern; similarity: number } | null = null;
    for (const p of patterns) {
      const entryBigrams = bigrams(normalizeQuestion(p.questionPattern));
      const sim = jaccard(queryBigrams, entryBigrams);
      if (!best || sim > best.similarity) {
        best = { pattern: p, similarity: sim };
      }
    }

    if (best && best.similarity >= threshold) {
      this.deps.learningRepo.incrementMatchCount(best.pattern.id);
      return {
        matched: true,
        answer: best.pattern.answerTemplate,
        patternId: best.pattern.id,
        similarity: best.similarity,
        matchType: 'semantic',
      };
    }

    return { matched: false };
  }

  recordFeedback(patternId: number, rating: number): void {
    this.deps.learningRepo.addFeedback(patternId, rating);
    for (const [, patterns] of this.cache) {
      for (const p of patterns) {
        if (p.id === patternId) {
          p.feedbackSum += rating;
          return;
        }
      }
    }
  }

  private toCached(p: LearnedPattern): CachedPattern {
    return {
      id: p.id,
      shopId: p.shopId,
      questionPattern: p.questionPattern,
      answerTemplate: p.answerTemplate,
      questionHash: p.questionHash,
      matchCount: p.matchCount,
      feedbackSum: p.feedbackSum,
    };
  }
}
