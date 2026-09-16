/**
 * 店铺店铺配置 Repository
 *
 * 存储店铺级业务信息，供 AI 自动回复系统调用：
 * - 发货地址（买家问"哪里发货"时回复）
 * - 运费险开关（买家问"有运费险吗"时回复）
 * - 合作快递公司（买家问"发什么快递"时回复）
 * - 包邮政策（买家问"包邮吗"时回复）
 * - 主营类目（辅助 AI 理解店铺业务范围）
 * - 客服专员映射（智能路由到指定专员功能用）
 * - 店铺人设（语气、昵称、口头禅，让 AI 回复更像真人）
 */
import type SqliteDatabase from 'better-sqlite3';

/** 语气风格 */
export type PersonaTone = 'professional' | 'friendly' | 'lively' | 'cute';

/** 店铺人设配置（控制 AI 回复的语气和拟人化程度） */
export interface ShopPersona {
  /** 语气风格
   *  - professional: 专业礼貌，规范用语
   *  - friendly: 亲切友好，适度口语化
   *  - lively: 活泼开朗，多用语气词
   *  - cute: 可爱俏皮，多用叠词和颜文字
   */
  tone: PersonaTone;
  /** 客服人设昵称（如"小柚子"），买家问"你叫什么"时使用，空字符串表示不设置 */
  nickname: string;
  /** 口头禅列表，回复末尾偶尔添加（如"~哦", "哈", "呢"），最多 5 个 */
  catchphrases: string[];
  /** 是否使用表情符号（如 😊、💕） */
  useEmojis: boolean;
  /** 自定义人设描述（自由文本，注入到 prompt 中），最多 200 字 */
  description: string;
}

/** 默认人设（专业风格） */
export const DEFAULT_PERSONA: ShopPersona = {
  tone: 'professional',
  nickname: '',
  catchphrases: [],
  useEmojis: false,
  description: '',
};

export interface ShopBusinessConfig {
  shopId: string;
  /** 发货地址，如"浙江金华" */
  deliveryAddress: string;
  /** 发货时长，如"24小时内"、"48小时内"、"3天内" */
  deliveryTime: string;
  /** 是否提供运费险 */
  freightInsurance: boolean;
  /** 合作快递公司列表，如["中通", "圆通"] */
  expressCompanies: string[];
  /** 是否提供包邮服务 */
  freeShipping: boolean;
  /** 包邮条件说明，如"满59元包邮"或"全场包邮" */
  freeShippingCondition: string;
  /** 店铺主营类目，如"服装服饰" */
  mainCategory: string;
  /** 客服专员映射：专员角色 → 飞鸽客服账号名
   *  例：{ "after_sales": "客服晓晓", "logistics": "客服小芳", "pre_sales": "客服小李", "general": "客服小王" }
   *  智能路由到指定专员功能使用 */
  agentMappings: Record<string, string>;
  /** 店铺人设（控制 AI 回复的语气和拟人化程度） */
  persona: ShopPersona;
  createdAt: number;
  updatedAt: number;
}

/** 更新输入：所有字段可选，仅传需更新的字段 */
export type ShopBusinessConfigUpdate = Partial<Omit<ShopBusinessConfig, 'shopId' | 'createdAt' | 'updatedAt'>>;

interface ShopBusinessConfigRow {
  shop_id: string;
  delivery_address: string;
  delivery_time: string;
  freight_insurance: number;
  express_companies: string;
  free_shipping: number;
  free_shipping_condition: string;
  main_category: string;
  agent_mappings: string;
  persona: string;
  created_at: number;
  updated_at: number;
}

/** 验证 persona 配置字段，返回错误消息列表（空数组表示通过） */
function validatePersona(p: unknown): string[] {
  const errors: string[] = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    errors.push('店铺人设格式错误');
    return errors;
  }
  const persona = p as Partial<ShopPersona>;
  const validTones: PersonaTone[] = ['professional', 'friendly', 'lively', 'cute'];
  if (persona.tone !== undefined && !validTones.includes(persona.tone)) {
    errors.push(`语气风格无效：${persona.tone}（必须是 professional/friendly/lively/cute 之一）`);
  }
  if (persona.nickname !== undefined && typeof persona.nickname === 'string' && persona.nickname.length > 20) {
    errors.push('客服昵称不能超过 20 字');
  }
  if (persona.catchphrases !== undefined) {
    if (!Array.isArray(persona.catchphrases)) {
      errors.push('口头禅列表格式错误');
    } else if (persona.catchphrases.length > 5) {
      errors.push('口头禅最多 5 个');
    } else if (persona.catchphrases.some((c) => typeof c !== 'string' || c.length > 20)) {
      errors.push('口头禅格式错误（单个不超过 20 字）');
    }
  }
  if (persona.useEmojis !== undefined && typeof persona.useEmojis !== 'boolean') {
    errors.push('表情开关格式错误');
  }
  if (persona.description !== undefined && typeof persona.description === 'string' && persona.description.length > 200) {
    errors.push('自定义人设描述不能超过 200 字');
  }
  return errors;
}

/** 验证配置字段，返回错误消息列表（空数组表示通过） */
export function validateBusinessConfig(input: ShopBusinessConfigUpdate): string[] {
  const errors: string[] = [];
  if (input.deliveryAddress !== undefined && input.deliveryAddress.length > 200) {
    errors.push('发货地址不能超过 200 字');
  }
  if (input.deliveryTime !== undefined && input.deliveryTime.length > 50) {
    errors.push('发货时长不能超过 50 字');
  }
  if (input.expressCompanies !== undefined) {
    if (!Array.isArray(input.expressCompanies)) {
      errors.push('快递公司列表格式错误');
    } else if (input.expressCompanies.some((c) => typeof c !== 'string' || c.length > 20)) {
      errors.push('快递公司名称格式错误（单个不超过 20 字）');
    } else if (input.expressCompanies.length > 10) {
      errors.push('合作快递公司最多 10 个');
    }
  }
  if (input.freeShippingCondition !== undefined && input.freeShippingCondition.length > 100) {
    errors.push('包邮条件不能超过 100 字');
  }
  if (input.mainCategory !== undefined && input.mainCategory.length > 50) {
    errors.push('主营类目不能超过 50 字');
  }
  if (input.agentMappings !== undefined) {
    if (typeof input.agentMappings !== 'object' || input.agentMappings === null || Array.isArray(input.agentMappings)) {
      errors.push('客服专员映射格式错误');
    } else {
      const validRoles = ['after_sales', 'logistics', 'pre_sales', 'general'];
      const entries = Object.entries(input.agentMappings);
      if (entries.length > 4) {
        errors.push('客服专员映射最多 4 个角色');
      }
      for (const [role, name] of entries) {
        if (!validRoles.includes(role)) {
          errors.push(`客服专员角色无效：${role}（必须是 after_sales/logistics/pre_sales/general 之一）`);
        }
        if (typeof name !== 'string' || name.length > 50) {
          errors.push(`飞鸽客服账号名格式错误（单个不超过 50 字）：${role}`);
        }
      }
    }
  }
  if (input.persona !== undefined) {
    errors.push(...validatePersona(input.persona));
  }
  return errors;
}

export class ShopBusinessConfigRepo {
  constructor(private db: SqliteDatabase.Database) {}

  /** 获取店铺店铺配置，不存在则返回 null */
  get(shopId: string): ShopBusinessConfig | null {
    const row = this.db
      .prepare(`SELECT * FROM shop_business_config WHERE shop_id = ?`)
      .get(shopId) as ShopBusinessConfigRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  /** 获取店铺店铺配置，不存在则返回默认值 */
  getOrDefault(shopId: string): ShopBusinessConfig {
    const row = this.get(shopId);
    if (row) return row;
    const now = Date.now();
    return {
      shopId,
      deliveryAddress: '',
      deliveryTime: '',
      freightInsurance: false,
      expressCompanies: [],
      freeShipping: false,
      freeShippingCondition: '',
      mainCategory: '',
      agentMappings: {},
      persona: { ...DEFAULT_PERSONA },
      createdAt: now,
      updatedAt: now,
    };
  }

  /** 更新店铺店铺配置（upsert：存在则更新，不存在则插入） */
  upsert(shopId: string, input: ShopBusinessConfigUpdate): void {
    const errors = validateBusinessConfig(input);
    if (errors.length > 0) {
      throw new Error(errors.join('; '));
    }
    const existing = this.get(shopId);
    const now = Date.now();
    const merged: ShopBusinessConfig = {
      shopId,
      deliveryAddress: input.deliveryAddress ?? existing?.deliveryAddress ?? '',
      deliveryTime: input.deliveryTime ?? existing?.deliveryTime ?? '',
      freightInsurance: input.freightInsurance ?? existing?.freightInsurance ?? false,
      expressCompanies: input.expressCompanies ?? existing?.expressCompanies ?? [],
      freeShipping: input.freeShipping ?? existing?.freeShipping ?? false,
      freeShippingCondition: input.freeShippingCondition ?? existing?.freeShippingCondition ?? '',
      mainCategory: input.mainCategory ?? existing?.mainCategory ?? '',
      agentMappings: input.agentMappings ?? existing?.agentMappings ?? {},
      persona: input.persona ?? existing?.persona ?? { ...DEFAULT_PERSONA },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO shop_business_config
           (shop_id, delivery_address, delivery_time, freight_insurance, express_companies,
            free_shipping, free_shipping_condition, main_category, agent_mappings, persona, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(shop_id) DO UPDATE SET
           delivery_address = excluded.delivery_address,
           delivery_time = excluded.delivery_time,
           freight_insurance = excluded.freight_insurance,
           express_companies = excluded.express_companies,
           free_shipping = excluded.free_shipping,
           free_shipping_condition = excluded.free_shipping_condition,
           main_category = excluded.main_category,
           agent_mappings = excluded.agent_mappings,
           persona = excluded.persona,
           updated_at = excluded.updated_at`,
      )
      .run(
        merged.shopId,
        merged.deliveryAddress,
        merged.deliveryTime,
        merged.freightInsurance ? 1 : 0,
        JSON.stringify(merged.expressCompanies),
        merged.freeShipping ? 1 : 0,
        merged.freeShippingCondition,
        merged.mainCategory,
        JSON.stringify(merged.agentMappings),
        JSON.stringify(merged.persona),
        merged.createdAt,
        merged.updatedAt,
      );
  }

  /** 删除店铺店铺配置 */
  delete(shopId: string): void {
    this.db.prepare(`DELETE FROM shop_business_config WHERE shop_id = ?`).run(shopId);
  }

  private mapRow(r: ShopBusinessConfigRow): ShopBusinessConfig {
    let expressCompanies: string[] = [];
    try {
      const parsed = JSON.parse(r.express_companies || '[]');
      if (Array.isArray(parsed)) {
        expressCompanies = parsed.filter((c) => typeof c === 'string');
      }
    } catch {
      // 旧数据可能不是 JSON，按逗号分割
      if (r.express_companies) {
        expressCompanies = r.express_companies.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      }
    }

    // 解析 agentMappings JSON（容错：旧数据可能没有此字段）
    let agentMappings: Record<string, string> = {};
    try {
      const parsedMappings = JSON.parse(r.agent_mappings || '{}');
      if (parsedMappings && typeof parsedMappings === 'object' && !Array.isArray(parsedMappings)) {
        for (const [k, v] of Object.entries(parsedMappings)) {
          if (typeof v === 'string') agentMappings[k] = v;
        }
      }
    } catch {
      // 旧数据或格式错误，使用空对象
      agentMappings = {};
    }

    // 解析 persona JSON（容错：旧数据可能没有此字段，回退到默认人设）
    let persona: ShopPersona = { ...DEFAULT_PERSONA };
    try {
      const parsedPersona = JSON.parse(r.persona || '{}');
      if (parsedPersona && typeof parsedPersona === 'object' && !Array.isArray(parsedPersona)) {
        persona = {
          tone: (['professional', 'friendly', 'lively', 'cute'].includes(parsedPersona.tone)
            ? parsedPersona.tone
            : 'professional') as PersonaTone,
          nickname: typeof parsedPersona.nickname === 'string' ? parsedPersona.nickname : '',
          catchphrases: Array.isArray(parsedPersona.catchphrases)
            ? parsedPersona.catchphrases.filter((c: unknown) => typeof c === 'string').slice(0, 5)
            : [],
          useEmojis: typeof parsedPersona.useEmojis === 'boolean' ? parsedPersona.useEmojis : false,
          description: typeof parsedPersona.description === 'string' ? parsedPersona.description : '',
        };
      }
    } catch {
      // 旧数据或格式错误，使用默认人设
      persona = { ...DEFAULT_PERSONA };
    }

    return {
      shopId: r.shop_id,
      deliveryAddress: r.delivery_address ?? '',
      deliveryTime: r.delivery_time ?? '',
      freightInsurance: r.freight_insurance === 1,
      expressCompanies,
      freeShipping: r.free_shipping === 1,
      freeShippingCondition: r.free_shipping_condition ?? '',
      mainCategory: r.main_category ?? '',
      agentMappings,
      persona,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
