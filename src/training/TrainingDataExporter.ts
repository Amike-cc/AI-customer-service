/**
 * 训练数据导出器
 * 
 * 将收集到的对话数据（AuditRepo + LearningRepo）导出为标准 JSONL 格式，
 * 可用于 DeepSeek / OpenAI 等平台的模型微调（Fine-tuning）。
 * 
 * 输出格式 (JSONL)：
 *   {"messages": [{"role": "system", "content": "..."}, {"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
 * 
 * 使用场景：
 *   1. 从 ai_reply_audit 表导出高质量对话样本
 *   2. 从 learned_patterns 表导出已验证的模式作为训练数据
 *   3. 按质量分数过滤，确保训练数据质量
 * 
 * 关联模块：
 *   - LearningPipeline: 数据收集与模式提取
 *   - QualityEvaluator: 质量评分
 *   - AuditRepo: 审计数据源
 */

import fs from 'fs-extra';
import path from 'path';
import type { Database } from '../db/Database';
import type { AppLogger } from '../logging/logger';
import type { AuditRecordWithMeta } from '../db/repos/AuditRepo';
import type { Config } from '../config/schema';

// 导出前 PII 脱敏正则（与 logging/logger.ts 保持一致）：手机号/身份证/邮箱/银行卡/订单号
const PII_PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  { regex: /1[3-9]\d{9}/g, replacement: '1**********' },
  { regex: /\d{17}[\dXx]/g, replacement: '******************' },
  { regex: /[\w.+-]+@[\w-]+\.[\w.-]+/g, replacement: '***@***.***' },
  { regex: /\b\d{15,19}\b/g, replacement: '****************' },
  // 收货地址常见形态：省市区 + 详细地址（含数字门牌）→ 保留省市，隐藏详细部分
  { regex: /((?:[\u4e00-\u9fa5]{2,}(?:省|市|自治区|区|县))[^\s，。]{0,12}?)([\u4e00-\u9fa5]{2,}?(?:路|街|道|巷|号|小区|大厦|楼|村))[^\s，。]{0,30}/g, replacement: '$1$2***' },
];

/** 对导出的对话文本做 PII 脱敏（微调数据可能离开本地，必须去除个人信息） */
function sanitizeText(value: string): string {
  let msg = value;
  for (const { regex, replacement } of PII_PATTERNS) {
    msg = msg.replace(regex, replacement);
  }
  return msg;
}

// ─── 类型定义 ───────────────────────────────────────────

export interface TrainingExample {
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
}

export interface TrainingExportOptions {
  /** 输出目录（默认: data/training/） */
  outputDir?: string;
  /** 最短用户消息长度（默认 5） */
  minUserMessageLength?: number;
  /** 最短 AI 回复长度（默认 10） */
  minAiReplyLength?: number;
  /** 最低质量分 threshold（默认 0.75） */
  qualityThreshold?: number;
  /** 每个 shop 最多导出条数（默认 5000） */
  maxPerShop?: number;
  /** 是否包含系统 prompt（默认 true） */
  includeSystemPrompt?: boolean;
  /** 系统 prompt 内容 */
  systemPrompt?: string;
  /** 训练/验证集比例（默认 0.9） */
  trainSplitRatio?: number;
  /** 导出的最大天数范围（默认 90 天） */
  lookbackDays?: number;
}

export interface ExportResult {
  /** 输出文件路径 */
  files: {
    train: string;
    validation: string;
    stats: string;
  };
  /** 统计信息 */
  stats: {
    totalExported: number;
    trainCount: number;
    validationCount: number;
    byShop: Record<string, number>;
    qualityDistribution: {
      high: number;   // >= 0.9
      medium: number; // >= 0.75
      low: number;    // < 0.75
    };
  };
}

// ─── 训练数据导出器 ─────────────────────────────────────

export class TrainingDataExporter {
  private db: Database;
  private logger: AppLogger;
  private config: Config;

  constructor(db: Database, logger: AppLogger, config: Config) {
    this.db = db;
    this.logger = logger;
    this.config = config;
  }

  /**
   * 导出训练数据
   * 从审计记录中收集高质量对话，输出 JSONL 格式文件
   */
  async export(options: TrainingExportOptions = {}): Promise<ExportResult> {
    const opts = this.resolveOptions(options);
    const outputDir = opts.outputDir;
    await fs.ensureDir(outputDir);

    const lookbackMs = opts.lookbackDays * 86400000;
    const since = Date.now() - lookbackMs;

    this.logger.info({ since: new Date(since).toISOString() }, '开始导出训练数据');

    const trainFile = path.join(outputDir, 'train.jsonl');
    const validationFile = path.join(outputDir, 'validation.jsonl');
    const statsFile = path.join(outputDir, 'export-stats.json');

    // 先清空输出文件，再分批读取 + 流式写入，避免一次性全量载入审计记录导致 OOM
    await fs.writeFile(trainFile, '', 'utf-8');
    await fs.writeFile(validationFile, '', 'utf-8');

    const byShop: Record<string, number> = {};
    const qualityDist = { high: 0, medium: 0, low: 0 };
    let totalExported = 0;
    let trainCount = 0;
    let validationCount = 0;

    const shopCounts = new Map<string, number>();
    const BATCH = 1000;
    const trainBuf: string[] = [];
    const valBuf: string[] = [];

    const flush = async (): Promise<void> => {
      if (trainBuf.length > 0) {
        await fs.appendFile(trainFile, trainBuf.join('\n') + '\n', 'utf-8');
        trainBuf.length = 0;
      }
      if (valBuf.length > 0) {
        await fs.appendFile(validationFile, valBuf.join('\n') + '\n', 'utf-8');
        valBuf.length = 0;
      }
    };

    // 按 id 游标分批读取，避免全量载入内存
    let lastId = 0;
    for (;;) {
      const batch = this.db
        .prepare(
          `SELECT id, shop_id AS shopId, session_id AS sessionId, user_message AS userMessage,
             ai_reply AS aiReply, model_version AS modelVersion, prompt_hash AS promptHash,
             product_id AS productId, token_input AS tokenInput, token_output AS tokenOutput,
             latency_ms AS latencyMs, confidence, created_at AS createdAt, prev_hash AS prevHash
           FROM ai_reply_audit
           WHERE created_at >= ? AND id > ?
           ORDER BY id ASC LIMIT ?`,
        )
        .all(since, lastId, BATCH) as AuditRecordWithMeta[];

      if (batch.length === 0) break;

      for (const record of batch) {
        if (!this.passesFilter(record, opts, shopCounts)) continue;
        const example = this.toTrainingExample(record, opts);
        if (!example) continue;

        const line = JSON.stringify(example);
        // 逐条随机分配训练/验证集，等效于流式 shuffle，无需全量驻留内存
        if (Math.random() < opts.trainSplitRatio) {
          trainBuf.push(line);
          trainCount++;
        } else {
          valBuf.push(line);
          validationCount++;
        }
        totalExported++;
        byShop[record.shopId] = (byShop[record.shopId] || 0) + 1;

        if (record.confidence != null) {
          if (record.confidence >= 0.9) qualityDist.high++;
          else if (record.confidence >= 0.75) qualityDist.medium++;
          else qualityDist.low++;
        } else {
          qualityDist.medium++; // 无置信度时默认中等
        }
      }

      lastId = batch[batch.length - 1].id;
      if (trainBuf.length >= BATCH || valBuf.length >= BATCH) await flush();
    }
    await flush();

    const stats = {
      totalExported,
      trainCount,
      validationCount,
      byShop,
      qualityDistribution: qualityDist,
      exportTime: new Date().toISOString(),
      options: opts,
    };
    await fs.writeJson(statsFile, stats, { spaces: 2 });

    this.logger.info(
      { trainCount, validationCount, outputDir },
      '训练数据导出完成'
    );

    return {
      files: { train: trainFile, validation: validationFile, stats: statsFile },
      stats: {
        totalExported,
        trainCount,
        validationCount,
        byShop,
        qualityDistribution: qualityDist,
      },
    };
  }

  /**
   * 导出 learned_patterns 表的学习模式作为增强训练数据
   */
  async exportPatterns(options: TrainingExportOptions = {}): Promise<ExportResult> {
    const opts = this.resolveOptions(options);
    const outputDir = path.join(opts.outputDir, 'patterns');
    await fs.ensureDir(outputDir);

    const patterns = this.db.learning.listAllActivePatterns();
    this.logger.info({ total: patterns.length }, '从学习模式表读取数据');

    const examples: TrainingExample[] = [];
    const byShop: Record<string, number> = {};

    for (const pattern of patterns) {
      if (!pattern.answerTemplate || pattern.answerTemplate.trim().length < 10) continue;
      if (pattern.avgQuality < (opts.qualityThreshold ?? 0.75)) continue;

      const example: TrainingExample = {
        messages: [
          { role: 'system', content: '你是一个专业的电商客服助手。' },
          { role: 'user', content: sanitizeText(pattern.questionPattern) },
          { role: 'assistant', content: sanitizeText(pattern.answerTemplate) },
        ],
      };

      examples.push(example);
      byShop[pattern.shopId] = (byShop[pattern.shopId] || 0) + 1;
    }

    const shuffled = this.shuffle(examples);
    const splitIdx = Math.floor(shuffled.length * 0.9);
    const trainSet = shuffled.slice(0, splitIdx);
    const validationSet = shuffled.slice(splitIdx);

    const trainFile = path.join(outputDir, 'patterns-train.jsonl');
    const validationFile = path.join(outputDir, 'patterns-validation.jsonl');
    const statsFile = path.join(outputDir, 'patterns-stats.json');

    const writeJsonl = async (filePath: string, data: TrainingExample[]) => {
      const lines = data.map((ex) => JSON.stringify(ex));
      await fs.writeFile(filePath, lines.join('\n'), 'utf-8');
    };

    await writeJsonl(trainFile, trainSet);
    await writeJsonl(validationFile, validationSet);

    const stats = {
      totalExported: examples.length,
      trainCount: trainSet.length,
      validationCount: validationSet.length,
      byShop,
    };
    await fs.writeJson(statsFile, stats, { spaces: 2 });

    return {
      files: { train: trainFile, validation: validationFile, stats: statsFile },
      stats: {
        totalExported: examples.length,
        trainCount: trainSet.length,
        validationCount: validationSet.length,
        byShop,
        qualityDistribution: { high: 0, medium: 0, low: 0 },
      },
    };
  }

  // ─── 私有方法 ────────────────────────────────────────

  private resolveOptions(options: TrainingExportOptions): Required<TrainingExportOptions> {
    return {
      outputDir: options.outputDir ?? path.join(this.config.app.data_dir, 'training'),
      minUserMessageLength: options.minUserMessageLength ?? 5,
      minAiReplyLength: options.minAiReplyLength ?? 10,
      qualityThreshold: options.qualityThreshold ?? 0.75,
      maxPerShop: options.maxPerShop ?? 5000,
      includeSystemPrompt: options.includeSystemPrompt ?? true,
      systemPrompt:
        options.systemPrompt ??
        '你是一个专业的电商客服助手。请礼貌、耐心地回答客户的问题，提供准确的产品信息和帮助。',
      trainSplitRatio: options.trainSplitRatio ?? 0.9,
      lookbackDays: options.lookbackDays ?? 90,
    };
  }

  private passesFilter(
    record: AuditRecordWithMeta,
    opts: Required<TrainingExportOptions>,
    shopCounts: Map<string, number>,
  ): boolean {
    // 长度过滤
    if (!record.userMessage || record.userMessage.trim().length < opts.minUserMessageLength) return false;
    if (!record.aiReply || record.aiReply.trim().length < opts.minAiReplyLength) return false;

    // 敏感词拦截的回复不纳入训练
    if (record.modelVersion.includes('sensitive_blocked')) return false;
    if (record.aiReply.includes('sensitive_blocked')) return false;

    // 低置信度过滤
    if (record.confidence != null && record.confidence < opts.qualityThreshold) return false;

    // 每 shop 上限
    const shopId = record.shopId;
    const count = shopCounts.get(shopId) ?? 0;
    if (count >= opts.maxPerShop) return false;
    shopCounts.set(shopId, count + 1);

    return true;
  }

  private toTrainingExample(
    record: AuditRecordWithMeta,
    opts: Required<TrainingExportOptions>,
  ): TrainingExample | null {
    if (!record.userMessage || !record.aiReply) return null;

    const messages: TrainingExample['messages'] = [];

    if (opts.includeSystemPrompt) {
      messages.push({ role: 'system', content: opts.systemPrompt });
    }

    // PII 脱敏：买家消息可能含手机号/地址/订单号，导出前必须清洗
    messages.push({ role: 'user', content: sanitizeText(record.userMessage) });
    messages.push({ role: 'assistant', content: sanitizeText(record.aiReply) });

    return { messages };
  }

  private shuffle<T>(array: T[]): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
}
