/**
 * 配置 Schema 定义（Zod）
 * 详见 docs/开发文档-综合版.md 的“配置规范”章节
 */
import { z } from 'zod';

const delaySchema = z
  .object({
    min_ms: z.number().int().min(0),
    max_ms: z.number().int().min(0),
  })
  .refine((d) => d.min_ms <= d.max_ms, { message: 'min_ms must be <= max_ms' });

export const ConfigSchema = z.object({
  app: z.object({
    name: z.string(),
    version: z.string(),
    log_level: z.enum(['trace', 'debug', 'info', 'warn', 'error']),
    max_shops: z.number().int().min(1).max(100),
    data_dir: z.string(),
    single_instance: z.boolean(),
    backup_retention_count: z.number().int().min(1).max(365).default(30),
  }),

  vision: z.object({
    enabled: z.boolean(),
    python_path: z.string(),
    script_path: z.string(),
    start_timeout_ms: z.number().int().positive(),
    request_timeout_ms: z.number().int().positive(),
    poll_interval_ms: z.number().int().positive(),
    max_restart_per_hour: z.number().int().positive(),
  }),

  ocr: z.object({
    lang: z.string(),
    use_angle_cls: z.boolean(),
    use_gpu: z.boolean(),
    max_text_length: z.number().int().positive(),
    text_clean_rules: z.array(z.string()),
  }),

  cdp: z.object({
    port_range: z.tuple([z.number().int(), z.number().int()]),
    startup_args: z.array(z.string()),
    startup_delay_ms: z.number().int().positive(),
    max_retries: z.number().int().positive(),
    retry_interval_ms: z.number().int().positive(),
    poll: z.object({
      min_ms: z.number().int().positive(),
      max_ms: z.number().int().positive(),
      idle_increase_ms: z.number().int().positive(),
      suppress_ms: z.number().int().positive(),
      background_ms: z.number().int().positive().optional(),
    }).optional(),
    heartbeat: z.object({
      interval_ms: z.number().int().positive(),
      timeout_ms: z.number().int().positive(),
      failures_threshold: z.number().int().positive(),
    }),
    recover_probe: z.object({
      interval_ms: z.number().int().positive(),
      cooldown_after_failure_ms: z.number().int().positive(),
      verify_count: z.number().int().positive(),
      verify_interval_ms: z.number().int().positive(),
      verify_timeout_ms: z.number().int().positive(),
    }),
    client_keepalive: z.object({
      interval_ms: z.number().int().positive(),
      restart_max_per_hour: z.number().int().positive(),
      stuck_detection: z.object({
        cpu_threshold_percent: z.number().min(0).max(100),
        duration_ms: z.number().int().positive(),
      }),
    }),
  }),

  deepseek: z.object({
    api_url: z.string().url(),
    model: z.string(),
    temperature: z.number().min(0).max(2),
    max_tokens: z.number().int().positive(),
    top_p: z.number().min(0).max(1),
    timeout_ms: z.number().int().positive(),
    stream: z.boolean(),
    retry_count: z.number().int().min(0),
    retry_interval_ms: z.number().int().positive(),
    context_rounds: z.number().int().positive(),
    context_idle_clear_ms: z.number().int().positive(),
    fallback_response: z.string(),
    scenarios: z
      .record(
        z.object({
          max_tokens: z.number().int().positive().optional(),
          temperature: z.number().min(0).max(2).optional(),
          keywords: z.array(z.string()).optional(),
        }),
      )
      .optional(),
    prompt_template: z.string(),
    sensitive_words_dict: z.string(),
    balance: z.object({
      warn_threshold_yuan: z.number().positive(),
      critical_threshold_yuan: z.number().positive(),
      check_interval_ms: z.number().int().positive(),
    }),
  }),

  ratelimit: z.object({
    enabled: z.boolean().optional(),
    per_shop_per_minute: z.number().int().min(1).max(60),
    night_factor: z.number().min(0).max(1),
    night_hours: z.tuple([z.number().min(0).max(23), z.number().min(0).max(23)]),
    burst_allowance: z.number().int().min(0),
    burst_window_ms: z.number().int().positive(),
  }),

  cache: z.object({
    ttl_ms: z.number().int().positive(),
    max_entries_per_shop: z.number().int().positive(),
    max_entries_global: z.number().int().positive(),
    invalidate_on_product_update: z.boolean(),
    semantic_enabled: z.boolean().optional().default(true),
    semantic_threshold: z.number().min(0).max(1).optional().default(0.7),
  }),

  human_simulator: z.object({
    reply_delay: z.object({
      default: delaySchema,
      peak_hours: z
        .object({
          hours: z.tuple([z.number(), z.number()]),
          min_ms: z.number().int().min(0),
          max_ms: z.number().int().min(0),
        })
        .optional(),
      night_hours: z
        .object({
          hours: z.tuple([z.number(), z.number()]),
          min_ms: z.number().int().min(0),
          max_ms: z.number().int().min(0),
        })
        .optional(),
    }),
    typing_speed_min_cpm: z.number().int().min(30).max(300),
    typing_speed_max_cpm: z.number().int().min(30).max(300),
    segment_pause: z.object({
      min_chars: z.number().int().positive(),
      max_chars: z.number().int().positive(),
      min_ms: z.number().int().min(0),
      max_ms: z.number().int().min(0),
    }),
    cursor_jitter: z.boolean(),
    typing_mistake_rate: z.number().min(0).max(1),
    ai_reply_delay_max_ms: z.number().int().min(0).optional().default(1500),
  }),

  silent_wait: z.object({
    duration_ms: z.number().int().positive(),
    max_consecutive: z.number().int().positive(),
  }),

  product: z.object({
    match_algorithm: z.enum(['exact', 'fuzzy', 'hybrid']),
    fuzzy_threshold: z.number().min(0).max(1),
    keywords_weight: z.number().min(0).max(1),
    fuzzy_match_weight: z.number().min(0).max(1),
  }),

  logging: z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error']),
    retention_days: z.number().int().positive(),
    rotation_max_bytes: z.number().int().positive(),
    audit_retention_days: z.number().int().positive(),
    sanitize: z.object({
      phone: z.boolean(),
      id_card: z.boolean(),
      email: z.boolean(),
      bank_card: z.boolean(),
      address: z.boolean(),
      address_dict: z.string(),
    }),
  }),

  monitor: z.object({
    metrics_flush_interval_ms: z.number().int().positive(),
    metrics_retention_days: z.number().int().positive(),
    alert: z.object({
      feishu_webhook: z.string(),
      feishu_secret: z.string(),
      dedup_window_ms: z.number().int().positive(),
      maintenance_windows: z.array(
        z.object({
          start: z.string(),
          end: z.string(),
          level: z.enum(['info', 'warn', 'critical']),
        }),
      ),
    }),
  }),

  security: z.object({
    api_key_store: z.enum(['dpapi', 'plain']),
    api_key_env_var: z.string(),
    audit_all_replies: z.boolean(),
    reply_output_check: z.boolean(),
    max_consecutive_sensitive: z.number().int().positive(),
  }),

  platforms: z.object({
    feige: z.object({ web_url: z.string().default('') }),
    pinduoduo: z.object({ web_url: z.string().default('https://mms.pinduoduo.com/chat-merchant/index.html#/') }),
    kuaishou: z.object({ web_url: z.string().default('https://im.kwaixiaodian.com/pc') }),
    weixin: z.object({ web_url: z.string().default('https://store.weixin.qq.com/shop/kf') }),
  }),

  /** 平台级别配置覆盖：允许为每个平台独立设置 AI 模型参数 */
  platform_overrides: z.record(
    z.object({
      /** 平台专属 AI 配置覆盖 */
      deepseek: z.object({
        model: z.string().optional(),
        temperature: z.number().min(0).max(2).optional(),
        max_tokens: z.number().int().positive().optional(),
        top_p: z.number().min(0).max(1).optional(),
        timeout_ms: z.number().int().positive().optional(),
        prompt_template: z.string().optional(),
        fallback_response: z.string().optional(),
      }).optional(),
    }),
  ).optional().default({}),

  agents: z.object({
    enabled: z.boolean().default(true),
    list: z.array(
      z.object({
        id: z.string(),
        scenario: z.string(),
        keywords: z.array(z.string()),
        preferred_tier: z.enum(['tier1', 'tier2', 'tier3']),
        system_prompt: z.string().optional(),
        priority: z.number().int().min(1).max(100).default(50),
      }),
    ),
  }),

  gateway: z.object({
    enabled: z.boolean().default(true),
    /** 默认主用 provider（用于非级联场景下的 LLM 调用入口） */
    default_provider: z
      .enum(['deepseek', 'qwen', 'openai', 'claude', 'kimi', 'glm', 'baichuan'])
      .default('deepseek'),
    cascade: z.object({
      enabled: z.boolean().default(true),
      confidence_thresholds: z.object({
        tier1: z.number().min(0).max(1).default(0.75),
        tier2: z.number().min(0).max(1).default(0.70),
        tier3: z.number().min(0).max(1).default(0.60),
      }),
      max_depth: z.number().int().min(1).max(3).default(3),
    }),
    providers: z.object({
      deepseek: z.object({
        enabled: z.boolean().default(true),
        tier: z.enum(['tier1', 'tier2', 'tier3']).default('tier3'),
      }),
      qwen: z.object({
        enabled: z.boolean().default(false),
        tier: z.enum(['tier1', 'tier2', 'tier3']).default('tier2'),
        api_url: z.string().url().default('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'),
        api_key_env_var: z.string().default('QWEN_API_KEY'),
        model: z.string().default('qwen-plus'),
        timeout_ms: z.number().int().positive().default(8000),
      }),
      openai: z.object({
        enabled: z.boolean().default(false),
        tier: z.enum(['tier1', 'tier2', 'tier3']).default('tier3'),
        api_url: z
          .string()
          .url()
          .default('https://api.openai.com/v1/chat/completions'),
        api_key_env_var: z.string().default('OPENAI_API_KEY'),
        model: z.string().default('gpt-4o-mini'),
        timeout_ms: z.number().int().positive().default(30000),
      }),
      claude: z.object({
        enabled: z.boolean().default(false),
        tier: z.enum(['tier1', 'tier2', 'tier3']).default('tier3'),
        api_url: z
          .string()
          .url()
          .default('https://api.anthropic.com/v1/messages'),
        api_key_env_var: z.string().default('ANTHROPIC_API_KEY'),
        model: z.string().default('claude-3-5-sonnet-20241022'),
        timeout_ms: z.number().int().positive().default(30000),
        /** Anthropic API 版本头（必须） */
        anthropic_version: z.string().default('2023-06-01'),
      }),
      kimi: z.object({
        enabled: z.boolean().default(false),
        tier: z.enum(['tier1', 'tier2', 'tier3']).default('tier2'),
        api_url: z
          .string()
          .url()
          .default('https://api.moonshot.cn/v1/chat/completions'),
        api_key_env_var: z.string().default('MOONSHOT_API_KEY'),
        model: z.string().default('moonshot-v1-8k'),
        timeout_ms: z.number().int().positive().default(30000),
      }),
      glm: z.object({
        enabled: z.boolean().default(false),
        tier: z.enum(['tier1', 'tier2', 'tier3']).default('tier2'),
        api_url: z
          .string()
          .url()
          .default('https://open.bigmodel.cn/api/paas/v4/chat/completions'),
        api_key_env_var: z.string().default('ZHIPU_API_KEY'),
        model: z.string().default('glm-4-flash'),
        timeout_ms: z.number().int().positive().default(30000),
      }),
      baichuan: z.object({
        enabled: z.boolean().default(false),
        tier: z.enum(['tier1', 'tier2', 'tier3']).default('tier2'),
        api_url: z
          .string()
          .url()
          .default('https://api.baichuan-ai.com/v1/chat/completions'),
        api_key_env_var: z.string().default('BAICHUAN_API_KEY'),
        model: z.string().default('Baichuan4-Turbo'),
        timeout_ms: z.number().int().positive().default(30000),
      }),
    }),
  }),

  scheduler: z.object({
    enabled: z.boolean().default(true),
    token_bucket: z.object({
      daily_budget_yuan: z.number().positive().default(50),
      reserve_ratio: z.number().min(0).max(1).default(0.2),
    }),
    budget: z.object({
      global_daily_yuan: z.number().positive().default(100),
      global_monthly_yuan: z.number().positive().default(2000),
      per_shop_daily_yuan: z.number().positive().default(5),
      warn_threshold: z.number().min(0).max(1).default(0.8),
      critical_threshold: z.number().min(0).max(1).default(1.0),
    }),
    default_priority: z.enum(['high', 'normal', 'low']).default('normal'),
  }),

  learning: z.object({
    enabled: z.boolean().default(true),
    run_interval_ms: z.number().int().positive().default(21600000),
    lookback_hours: z.number().int().positive().default(24),
    min_quality_threshold: z.number().min(0).max(1).default(0.75),
    min_samples_for_pattern: z.number().int().min(1).default(3),
    semantic_threshold: z.number().min(0).max(1).default(0.8),
    pattern_decay_days: z.number().int().positive().default(30),
    max_patterns_per_shop: z.number().int().positive().default(500),
    weights: z.object({
      confidence: z.number().min(0).max(1).default(0.30),
      latency: z.number().min(0).max(1).default(0.15),
      structure: z.number().min(0).max(1).default(0.15),
      safety: z.number().min(0).max(1).default(0.20),
      feedback: z.number().min(0).max(1).default(0.20),
    }),
  }),

  intent: z.object({
    enabled: z.boolean().default(true),
    complexity_threshold: z.number().min(0).max(1).default(0.6),
    confidence_threshold: z.number().min(0).max(1).default(0.5),
    history_weight: z.number().min(0).max(1).default(0.3),
  }),

  /** 客服回复中的商品推荐参数（保留历史配置键 conversion 以兼容现有配置文件） */
  conversion: z.object({
    enabled: z.boolean().default(true),
    max_recommendations: z.number().int().min(1).max(10).default(3),
    cross_sell_threshold: z.number().min(0).max(1).default(0.4),
    recommendation_cooldown_ms: z.number().int().positive().default(300000),
  }),

  human_collab: z.object({
    enabled: z.boolean().default(true),
    queue_poll_interval_ms: z.number().int().positive().default(10000),
    max_wait_ms: z.number().int().positive().default(300000),
    default_max_chats: z.number().int().positive().default(5),
    auto_transfer_on_escalation: z.boolean().default(true),
  }),

  /**
   * 非工作时间策略
   * 工作时间外自动回复预设话术并暂存消息，工作时间开始后批量续处理
   */
  work_time: z.object({
    enabled: z.boolean().default(false),
    timezone: z.string().default('Asia/Shanghai'),
    /** 工作日，1=周一 ... 7=周日 */
    workDays: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5]),
    workStart: z.string().default('09:00'),
    workEnd: z.string().default('18:00'),
    offHoursReply: z.string().default('亲，当前是非工作时间（{start}-{end}），我们会暂存您的消息，工作时间会第一时间为您处理~'),
    pendingProcessBatchSize: z.number().int().positive().default(10),
    pendingProcessIntervalMs: z.number().int().positive().default(30000),
  }).default({}),

  /**
   * 跨会话买家记忆
   * 让 AI 像真人客服一样认得老顾客：记住历史咨询/投诉/转化/偏好，回复时自然引用
   */
  buyer: z.object({
    enabled: z.boolean().default(true),
    /** 画像聚合缓存 TTL（毫秒），避免每条消息都重算偏好 */
    profileCacheTtlMs: z.number().int().positive().default(300000),
    /** 构造 buyerContext 时回看历史消息的最大条数 */
    historyLookbackLimit: z.number().int().positive().default(200),
    /** 注入 prompt 的最大字符长度（避免挤占 token 预算） */
    maxContextChars: z.number().int().positive().default(500),
    /** 触发 VIP 升级的累计咨询次数阈值 */
    vipConsultationThresholds: z.object({
      silver: z.number().int().positive().default(5),
      gold: z.number().int().positive().default(20),
      diamond: z.number().int().positive().default(50),
    }).default({}),
  }).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * 平台级 AI 配置（合并全局配置和平台覆盖后的生效配置）
 */
export interface PlatformDeepseekConfig {
  model: string;
  temperature: number;
  max_tokens: number;
  top_p: number;
  timeout_ms: number;
  prompt_template: string;
  fallback_response: string;
}

/**
 * 获取指定平台的生效 AI 配置（全局配置 + 平台覆盖）
 *
 * 平台覆盖优先于全局配置，允许为每个平台使用不同的 AI 模型、温度、超时等参数。
 */
export function getPlatformDeepseekConfig(config: Config, platformId: string): PlatformDeepseekConfig {
  const overrides = config.platform_overrides?.[platformId]?.deepseek;
  return {
    model: overrides?.model ?? config.deepseek.model,
    temperature: overrides?.temperature ?? config.deepseek.temperature,
    max_tokens: overrides?.max_tokens ?? config.deepseek.max_tokens,
    top_p: overrides?.top_p ?? config.deepseek.top_p,
    timeout_ms: overrides?.timeout_ms ?? config.deepseek.timeout_ms,
    prompt_template: overrides?.prompt_template ?? config.deepseek.prompt_template,
    fallback_response: overrides?.fallback_response ?? config.deepseek.fallback_response,
  };
}
