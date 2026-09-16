/**
 * 跨会话买家记忆 — 画像服务
 *
 * 职责：
 *   1. buildBuyerContext：构造买家画像字符串供 prompt 注入
 *      - 新客（messageCount < 2）返回空字符串
 *      - 5 分钟 TTL 缓存，避免每条消息都查 DB
 *      - 截断保护 maxContextChars
 *   2. recordInteraction：回复发送成功后异步调用
 *      - 实时增量更新计数 + 失效缓存 + VIP 自动升级
 *      - try/catch 包裹不抛错，绝不影响主流程
 *
 * 设计原则：
 *   - 复用 BuyerProfileRepo 持久化层，本服务只管聚合 + 缓存 + 渲染
 *   - 偏好字段只消费已确认写入的结构化数据，不从聊天内容猜测或虚构偏好
 *   - 所有方法均安全失败：异常时返回空画像/不更新计数，主流程不受影响
 */
import type { BuyerProfile, RecordInteractionParams, VipLevel } from '../db/repos/BuyerProfileRepo';
import type { BuyerServiceConfig } from './types';

/** VIP 等级对应的中文名称 */
const VIP_NAMES: Record<VipLevel, string> = ['普通', '银卡会员', '金卡会员', '钻石会员'];

interface CacheEntry {
  /** 渲染后的画像字符串（含【买家画像】头部） */
  contextText: string;
  /** 缓存到期时间戳 */
  expiresAt: number;
}

export class BuyerProfileService {
  /** 内存缓存：key = `${shopId}|${platform}|${buyerName}` */
  private cache = new Map<string, CacheEntry>();
  /** 缓存硬上限：防止买家量大时无界增长（超出后淘汰最旧条目） */
  private static readonly MAX_CACHE_ENTRIES = 5000;

  constructor(private deps: BuyerServiceConfig) {}

  /**
   * 构造买家画像字符串供 prompt 注入。
   *
   * @returns 画像字符串；新客（messageCount < 2）或配置关闭时返回空字符串
   */
  buildBuyerContext(shopId: string, platform: string, buyerName: string): string {
    if (!this.deps.config.enabled) return '';
    if (!buyerName || buyerName.trim().length === 0) return '';

    const cacheKey = `${shopId}|${platform}|${buyerName}`;
    const now = Date.now();

    // 1. 命中缓存直接返回
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.contextText;
    }

    // 2. 查询 / 创建画像
    let profile: BuyerProfile;
    try {
      profile = this.deps.db.buyerProfiles.getOrCreate(shopId, platform, buyerName);
    } catch (err) {
      this.deps.logger.warn({ shopId, platform, buyerName, err }, 'BuyerProfileService 查询画像失败');
      return '';
    }

    // 3. 渲染画像字符串
    const text = this.renderContext(profile);

    // 4. 写入缓存（超上限时先清过期条目，仍超限则淘汰最旧——Map 保持插入序）
    this.cache.set(cacheKey, {
      contextText: text,
      expiresAt: now + this.deps.config.profileCacheTtlMs,
    });
    if (this.cache.size > BuyerProfileService.MAX_CACHE_ENTRIES) {
      const cutoff = now;
      for (const [k, v] of this.cache) {
        if (v.expiresAt <= cutoff) this.cache.delete(k);
      }
      while (this.cache.size > BuyerProfileService.MAX_CACHE_ENTRIES) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
    }

    return text;
  }

  /**
   * 回复发送成功后异步调用，实时增量更新计数 + 失效缓存 + VIP 自动升级。
   * 整个方法 try/catch 包裹，绝不抛错影响主流程。
   */
  recordInteraction(params: RecordInteractionParams): void {
    try {
      if (!this.deps.config.enabled) return;
      const { shopId, platform, buyerName, sessionId, productId } = params;
      if (!buyerName || buyerName.trim().length === 0) return;

      // 1. 增量更新统计字段
      const stats: Partial<Record<keyof typeof STAT_KEYS, number>> = {
        consultationCount: 1,
        messageCount: 1,
      };
      if (params.isComplaint) stats.complaintCount = 1;
      if (params.isConversion) stats.conversionCount = 1;
      if (params.isRefund) stats.refundCount = 1;
      if (params.isEscalation) stats.escalationCount = 1;

      this.deps.db.buyerProfiles.incrementStats(shopId, platform, buyerName, stats, {
        sessionId,
        productId,
      });

      // 2. VIP 自动升级检查
      this.maybeUpgradeVip(shopId, platform, buyerName);

      // 3. 失效缓存（下次 buildBuyerContext 会重算）
      this.cache.delete(`${shopId}|${platform}|${buyerName}`);

      // BUYER-ID-001：仅昵称（无稳定 buyerId）时记录低置信度，提醒同名买家可能被合并，
      // 不把它当成确定身份写入。稳定 ID 存在时以之为准。
      if (!params.buyerId) {
        this.deps.logger.debug(
          { shopId, platform, buyerName, sessionId },
          '买家仅有昵称、无稳定 ID，画像归属置信度为低',
        );
      }
    } catch (err) {
      this.deps.logger.warn({ err, params }, 'BuyerProfileService.recordInteraction 失败');
    }
  }

  /**
   * 主动更新买家备注（覆盖式）。
   * 由 AI 回复中的 [BUYER_REMARK:xxx] 标记触发。
   * 安全失败：异常时仅 warn 日志，绝不影响主流程。
   */
  updateBuyerRemark(shopId: string, platform: string, buyerName: string, remark: string): void {
    try {
      if (!this.deps.config.enabled) return;
      if (!buyerName || buyerName.trim().length === 0) return;
      const trimmed = remark.trim().slice(0, 200);
      if (!trimmed) return;
      this.deps.db.buyerProfiles.updateProfile(shopId, platform, buyerName, { remarks: trimmed });
      this.cache.delete(`${shopId}|${platform}|${buyerName}`);
      this.deps.logger.info({ shopId, platform, buyerName, remark: trimmed }, '买家备注已更新（AI 自动）');
    } catch (err) {
      this.deps.logger.warn({ err, shopId, platform, buyerName }, 'BuyerProfileService.updateBuyerRemark 失败');
    }
  }

  /**
   * 主动追加买家标签（合并去重）。
   * 由 AI 回复中的 [BUYER_TAG:标签1,标签2] 标记触发。
   * 安全失败：异常时仅 warn 日志，绝不影响主流程。
   */
  addBuyerTags(shopId: string, platform: string, buyerName: string, tags: string[]): void {
    try {
      if (!this.deps.config.enabled) return;
      if (!buyerName || buyerName.trim().length === 0) return;
      // 清洗：trim、过滤空、截断单标签长度、限制总数
      const cleaned = tags
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .map((t) => t.slice(0, 20))
        .slice(0, 10);
      if (cleaned.length === 0) return;
      this.deps.db.buyerProfiles.addTags(shopId, platform, buyerName, cleaned);
      this.cache.delete(`${shopId}|${platform}|${buyerName}`);
      this.deps.logger.info({ shopId, platform, buyerName, tags: cleaned }, '买家标签已追加（AI 自动）');
    } catch (err) {
      this.deps.logger.warn({ err, shopId, platform, buyerName }, 'BuyerProfileService.addBuyerTags 失败');
    }
  }

  /**
   * 渲染画像为 prompt 字符串。
   * - 新客（messageCount < 2）返回空字符串（避免给 AI 注入无意义的"首次咨询"信息）
   * - 截断保护 maxContextChars
   *
   * 输出格式示例：
   *   【买家画像】
   *   - 买家昵称：王小姐
   *   - 累计咨询：3 次（首次 2026-07-15）
   *   - 会员等级：银卡会员
   *   - 历史投诉：1 次
   *   - 历史成交：2 单
   *   - 偏好品类：连衣裙、衬衫
   *   - 标签：高客单价、尺码敏感
   */
  private renderContext(profile: BuyerProfile): string {
    // 新客不注入（首次咨询无需画像）
    if (profile.messageCount < 2) return '';

    const lines: string[] = ['【买家画像】'];
    lines.push(`- 买家昵称：${profile.buyerName}`);
    lines.push(
      `- 累计咨询：${profile.consultationCount} 次（首次 ${this.fmtDate(profile.firstSeenAt)}，最近 ${this.fmtDate(profile.lastSeenAt)}）`,
    );

    if (profile.vipLevel > 0) {
      lines.push(`- 会员等级：${VIP_NAMES[profile.vipLevel]}`);
    }
    if (profile.complaintCount > 0) {
      lines.push(`- 历史投诉：${profile.complaintCount} 次`);
    }
    if (profile.conversionCount > 0) {
      lines.push(`- 历史成交：${profile.conversionCount} 单`);
    }
    if (profile.refundCount > 0) {
      lines.push(`- 历史退款：${profile.refundCount} 次`);
    }
    if (profile.preferredCategories.length > 0) {
      lines.push(`- 偏好品类：${profile.preferredCategories.join('、')}`);
    }
    const specKeys = Object.keys(profile.preferredSpecs);
    if (specKeys.length > 0) {
      const specText = specKeys.map((k) => `${k}=${profile.preferredSpecs[k]}`).join('、');
      lines.push(`- 偏好规格：${specText}`);
    }
    if (profile.priceSensitivity) {
      lines.push(`- 价格敏感度：${profile.priceSensitivity}`);
    }
    if (profile.tags.length > 0) {
      lines.push(`- 标签：${profile.tags.join('、')}`);
    }
    if (profile.remarks) {
      lines.push(`- 备注：${profile.remarks}`);
    }

    // 特殊指令：提示 AI 以本次对话实际内容为准（避免昵称重名误导）
    lines.push('- 请结合本次实际对话内容判断，画像仅供参考');

    const text = lines.join('\n');

    // 截断保护
    const maxChars = this.deps.config.maxContextChars;
    return text.length > maxChars ? text.slice(0, maxChars - 3) + '...' : text;
  }

  /** 检查并执行 VIP 自动升级（基于累计咨询次数） */
  private maybeUpgradeVip(shopId: string, platform: string, buyerName: string): void {
    const profile = this.deps.db.buyerProfiles.get(shopId, platform, buyerName);
    if (!profile) return;

    const t = this.deps.config.vipConsultationThresholds;
    let newLevel: VipLevel = profile.vipLevel;
    if (profile.consultationCount >= t.diamond) newLevel = Math.max(newLevel, 3) as VipLevel;
    else if (profile.consultationCount >= t.gold) newLevel = Math.max(newLevel, 2) as VipLevel;
    else if (profile.consultationCount >= t.silver) newLevel = Math.max(newLevel, 1) as VipLevel;

    if (newLevel !== profile.vipLevel) {
      this.deps.db.buyerProfiles.updateProfile(shopId, platform, buyerName, {
        vipLevel: newLevel,
      });
      this.deps.logger.info(
        { shopId, buyerName, old: profile.vipLevel, new: newLevel, consultations: profile.consultationCount },
        '买家 VIP 自动升级',
      );
    }
  }

  /** 清空全部缓存（用于配置变更等场景） */
  clearCache(): void {
    this.cache.clear();
  }

  private fmtDate(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}

/** recordInteraction 中可用到的统计键映射（仅用于类型推断） */
const STAT_KEYS = {
  consultationCount: 1,
  messageCount: 1,
  complaintCount: 1,
  conversionCount: 1,
  refundCount: 1,
  escalationCount: 1,
};
