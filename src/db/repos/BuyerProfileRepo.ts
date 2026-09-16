/**
 * 买家画像 Repository
 *
 * 持久化跨会话买家记忆：累计咨询/投诉/转化次数、偏好品类/规格、VIP 等级、标签等。
 * 让 AI 像真人客服一样"认得"老顾客，回复时自然引用历史交互。
 *
 * 表结构（见 Database.migrate）：
 *   buyer_profiles(id, shop_id, platform, buyer_name,
 *     first_seen_at, last_seen_at, consultation_count, message_count,
 *     complaint_count, conversion_count, refund_count, escalation_count,
 *     preferred_categories, preferred_specs, price_sensitivity,
 *     vip_level, tags, remarks,
 *     last_session_id, last_product_id, profile_version,
 *     created_at, updated_at, UNIQUE(shop_id, platform, buyer_name))
 *
 * 买家标识约束：FeigeMessage 对象只有 sessionId（实际是 buyerName 昵称），
 * 故采用 (shop_id, platform, buyer_name) 复合键 + UNIQUE 约束。
 */
import type SqliteDatabase from 'better-sqlite3';

/** VIP 等级：0普通 / 1银卡 / 2金卡 / 3钻石 */
export type VipLevel = 0 | 1 | 2 | 3;

export interface BuyerProfile {
  id: number;
  shopId: string;
  platform: string;
  buyerName: string;
  // 实时增量字段
  firstSeenAt: number;
  lastSeenAt: number;
  consultationCount: number;
  messageCount: number;
  complaintCount: number;
  conversionCount: number;
  refundCount: number;
  escalationCount: number;
  // 画像字段（DB 存 JSON 字符串，TS 解析）
  preferredCategories: string[];
  preferredSpecs: Record<string, string>;
  priceSensitivity: string | null;
  // 分层字段
  vipLevel: VipLevel;
  tags: string[];
  remarks: string | null;
  // 元数据
  lastSessionId: string | null;
  lastProductId: string | null;
  profileVersion: number;
  createdAt: number;
  updatedAt: number;
}

interface BuyerProfileRow {
  id: number;
  shop_id: string;
  platform: string;
  buyer_name: string;
  first_seen_at: number;
  last_seen_at: number;
  consultation_count: number;
  message_count: number;
  complaint_count: number;
  conversion_count: number;
  refund_count: number;
  escalation_count: number;
  preferred_categories: string | null;
  preferred_specs: string | null;
  price_sensitivity: string | null;
  vip_level: number;
  tags: string | null;
  remarks: string | null;
  last_session_id: string | null;
  last_product_id: string | null;
  profile_version: number;
  created_at: number;
  updated_at: number;
}

/** 可增量统计的字段键 */
export type BuyerStatKey =
  | 'consultationCount'
  | 'messageCount'
  | 'complaintCount'
  | 'conversionCount'
  | 'refundCount'
  | 'escalationCount';

/** BuyerStatKey → 数据库列名 */
const STAT_COLUMN: Record<BuyerStatKey, string> = {
  consultationCount: 'consultation_count',
  messageCount: 'message_count',
  complaintCount: 'complaint_count',
  conversionCount: 'conversion_count',
  refundCount: 'refund_count',
  escalationCount: 'escalation_count',
};

export interface RecordInteractionParams {
  shopId: string;
  platform: string;
  buyerName: string;
  /** 稳定买家 ID（BUYER-ID-001）。有值时画像归属以此为准 */
  buyerId?: string;
  /** 身份置信度：high=有稳定 ID，low=仅昵称，同名买家不能合并 */
  identityConfidence?: 'high' | 'low';
  sessionId: string;
  productId?: string;
  isComplaint?: boolean;
  isConversion?: boolean;
  isRefund?: boolean;
  isEscalation?: boolean;
}

/** updateProfile 可更新字段 */
export interface BuyerProfileUpdateFields {
  preferredCategories?: string[];
  preferredSpecs?: Record<string, string>;
  priceSensitivity?: string | null;
  vipLevel?: VipLevel;
  remarks?: string | null;
}

export class BuyerProfileRepo {
  constructor(private db: SqliteDatabase.Database) {}

  /**
   * 获取或创建画像（ON CONFLICT DO NOTHING 二段式）
   * 即使并发调用也只创建一条记录，幂等。
   */
  getOrCreate(shopId: string, platform: string, buyerName: string): BuyerProfile {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO buyer_profiles
           (shop_id, platform, buyer_name, first_seen_at, last_seen_at,
            consultation_count, message_count, complaint_count, conversion_count,
            refund_count, escalation_count, preferred_categories, preferred_specs,
            price_sensitivity, vip_level, tags, remarks,
            last_session_id, last_product_id, profile_version,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, '[]', '{}', NULL, 0, '[]', NULL, NULL, NULL, 1, ?, ?)
         ON CONFLICT(shop_id, platform, buyer_name) DO NOTHING`,
      )
      .run(shopId, platform, buyerName, now, now, now, now);
    const profile = this.get(shopId, platform, buyerName);
    if (!profile) {
      // 理论上不会发生（INSERT OR IGNORE 后 SELECT 必有），保险起见抛错
      throw new Error(`BuyerProfileRepo.getOrCreate: 画像创建后查询失败 ${shopId}/${platform}/${buyerName}`);
    }
    return profile;
  }

  /** 按复合键查询画像 */
  get(shopId: string, platform: string, buyerName: string): BuyerProfile | null {
    const row = this.db
      .prepare(
        `SELECT * FROM buyer_profiles
         WHERE shop_id = ? AND platform = ? AND buyer_name = ?`,
      )
      .get(shopId, platform, buyerName) as BuyerProfileRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  /** 按 ID 查询画像 */
  getById(id: number): BuyerProfile | null {
    const row = this.db
      .prepare(`SELECT * FROM buyer_profiles WHERE id = ?`)
      .get(id) as BuyerProfileRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  /**
   * 增量统计 + 元数据更新（一次 UPDATE 完成）
   * @param stats 各统计字段增量值（通常为 1）
   * @param extra 可选的 sessionId / productId 更新（COALESCE 不覆盖 NULL）
   */
  incrementStats(
    shopId: string,
    platform: string,
    buyerName: string,
    stats: Partial<Record<BuyerStatKey, number>>,
    extra?: { sessionId?: string; productId?: string },
  ): void {
    const setClauses: string[] = [];
    const params: (string | number | null)[] = [];
    for (const key of Object.keys(stats) as BuyerStatKey[]) {
      const inc = stats[key] ?? 0;
      if (inc === 0) continue;
      setClauses.push(`${STAT_COLUMN[key]} = ${STAT_COLUMN[key]} + ?`);
      params.push(inc);
    }
    setClauses.push('last_session_id = COALESCE(?, last_session_id)');
    params.push(extra?.sessionId ?? null);
    setClauses.push('last_product_id = COALESCE(?, last_product_id)');
    params.push(extra?.productId ?? null);
    const now = Date.now();
    setClauses.push('last_seen_at = ?');
    params.push(now);
    setClauses.push('updated_at = ?');
    params.push(now);
    params.push(shopId, platform, buyerName);
    this.db
      .prepare(
        `UPDATE buyer_profiles SET ${setClauses.join(', ')}
         WHERE shop_id = ? AND platform = ? AND buyer_name = ?`,
      )
      .run(...params);
  }

  /**
   * 更新画像字段（COALESCE 保留未传字段原值）
   * 注意：vipLevel=0 是有效值，需显式判断 undefined 而非 ??
   */
  updateProfile(
    shopId: string,
    platform: string,
    buyerName: string,
    fields: BuyerProfileUpdateFields,
  ): void {
    const setClauses: string[] = [];
    const params: (string | number | null)[] = [];
    if (fields.preferredCategories !== undefined) {
      setClauses.push('preferred_categories = ?');
      params.push(JSON.stringify(fields.preferredCategories));
    }
    if (fields.preferredSpecs !== undefined) {
      setClauses.push('preferred_specs = ?');
      params.push(JSON.stringify(fields.preferredSpecs));
    }
    if (fields.priceSensitivity !== undefined) {
      setClauses.push('price_sensitivity = ?');
      params.push(fields.priceSensitivity);
    }
    if (fields.vipLevel !== undefined) {
      setClauses.push('vip_level = ?');
      params.push(fields.vipLevel);
    }
    if (fields.remarks !== undefined) {
      setClauses.push('remarks = ?');
      params.push(fields.remarks);
    }
    if (setClauses.length === 0) return;
    setClauses.push('updated_at = ?');
    params.push(Date.now());
    params.push(shopId, platform, buyerName);
    this.db
      .prepare(
        `UPDATE buyer_profiles SET ${setClauses.join(', ')}
         WHERE shop_id = ? AND platform = ? AND buyer_name = ?`,
      )
      .run(...params);
  }

  /**
   * 追加标签（合并去重）
   */
  addTags(shopId: string, platform: string, buyerName: string, tags: string[]): void {
    if (tags.length === 0) return;
    const profile = this.get(shopId, platform, buyerName);
    if (!profile) return;
    const merged = Array.from(new Set([...profile.tags, ...tags]));
    this.db
      .prepare(
        `UPDATE buyer_profiles SET tags = ?, updated_at = ?
         WHERE shop_id = ? AND platform = ? AND buyer_name = ?`,
      )
      .run(JSON.stringify(merged), Date.now(), shopId, platform, buyerName);
  }

  /** 按店铺+平台列出画像（按最近咨询时间倒序） */
  listByShop(shopId: string, platform: string, limit = 200): BuyerProfile[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM buyer_profiles
         WHERE shop_id = ? AND platform = ?
         ORDER BY last_seen_at DESC LIMIT ?`,
      )
      .all(shopId, platform, limit) as BuyerProfileRow[];
    return rows.map((r) => this.mapRow(r));
  }

  /** 按店铺+平台聚合统计 */
  getStats(shopId: string, platform: string): {
    total: number;
    byVip: Record<VipLevel, number>;
    totalConsultations: number;
    totalComplaints: number;
    totalConversions: number;
  } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(consultation_count), 0) AS total_consultations,
           COALESCE(SUM(complaint_count), 0) AS total_complaints,
           COALESCE(SUM(conversion_count), 0) AS total_conversions,
           COALESCE(SUM(CASE WHEN vip_level = 1 THEN 1 ELSE 0 END), 0) AS vip_silver,
           COALESCE(SUM(CASE WHEN vip_level = 2 THEN 1 ELSE 0 END), 0) AS vip_gold,
           COALESCE(SUM(CASE WHEN vip_level = 3 THEN 1 ELSE 0 END), 0) AS vip_diamond
         FROM buyer_profiles
         WHERE shop_id = ? AND platform = ?`,
      )
      .get(shopId, platform) as
      | {
          total: number;
          total_consultations: number;
          total_complaints: number;
          total_conversions: number;
          vip_silver: number;
          vip_gold: number;
          vip_diamond: number;
        }
      | undefined;
    const r = row ?? {
      total: 0,
      total_consultations: 0,
      total_complaints: 0,
      total_conversions: 0,
      vip_silver: 0,
      vip_gold: 0,
      vip_diamond: 0,
    };
    return {
      total: r.total,
      byVip: {
        0: r.total - r.vip_silver - r.vip_gold - r.vip_diamond,
        1: r.vip_silver,
        2: r.vip_gold,
        3: r.vip_diamond,
      },
      totalConsultations: r.total_consultations,
      totalComplaints: r.total_complaints,
      totalConversions: r.total_conversions,
    };
  }

  /** 删除指定店铺全部画像（用于店铺删除） */
  deleteAll(shopId: string): number {
    const result = this.db
      .prepare(`DELETE FROM buyer_profiles WHERE shop_id = ?`)
      .run(shopId);
    return result.changes;
  }

  /** snake_case → camelCase；JSON 字段安全解析（损坏数据回落默认值） */
  private mapRow(r: BuyerProfileRow): BuyerProfile {
    return {
      id: r.id,
      shopId: r.shop_id,
      platform: r.platform,
      buyerName: r.buyer_name,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      consultationCount: r.consultation_count,
      messageCount: r.message_count,
      complaintCount: r.complaint_count,
      conversionCount: r.conversion_count,
      refundCount: r.refund_count,
      escalationCount: r.escalation_count,
      preferredCategories: safeParseArray(r.preferred_categories),
      preferredSpecs: safeParseObject(r.preferred_specs),
      priceSensitivity: r.price_sensitivity,
      vipLevel: (r.vip_level as VipLevel) ?? 0,
      tags: safeParseArray(r.tags),
      remarks: r.remarks,
      lastSessionId: r.last_session_id,
      lastProductId: r.last_product_id,
      profileVersion: r.profile_version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

/** 安全解析 JSON 数组字段，损坏时返回空数组 */
function safeParseArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

/** 安全解析 JSON 对象字段，损坏时返回空对象 */
function safeParseObject(s: string | null | undefined): Record<string, string> {
  if (!s) return {};
  try {
    const obj = JSON.parse(s);
    return obj && typeof obj === 'object' && !Array.isArray(obj)
      ? obj as Record<string, string>
      : {};
  } catch {
    return {};
  }
}
