/**
 * 混合模型网关公共类型定义
 */
import type { ChatMessage, PlatformOverrides } from '../deepseek/DeepSeekClient';
import type { ModelTier } from '../scheduler/types';
import type { ToolCall, ToolDefinition } from '../tools/types';

export type ProviderType =
  | 'deepseek'
  | 'qwen'
  | 'openai'
  | 'claude'
  | 'kimi'
  | 'glm'
  | 'baichuan';

/** 所有支持的 LLM Provider 标识（用于 UI 渲染） */
export const ALL_PROVIDER_TYPES: ProviderType[] = [
  'deepseek',
  'qwen',
  'openai',
  'claude',
  'kimi',
  'glm',
  'baichuan',
];

/** Provider 显示信息（中文名 + 申请 API Key 链接） */
export const PROVIDER_META: Record<
  ProviderType,
  { label: string; apiKeysUrl: string; docsUrl: string; defaultTier: ModelTier; description: string }
> = {
  deepseek: {
    label: 'DeepSeek',
    apiKeysUrl: 'https://platform.deepseek.com/api_keys',
    docsUrl: 'https://api-docs.deepseek.com/',
    defaultTier: 'tier3',
    description: '国产高性价比模型，擅长推理与代码',
  },
  qwen: {
    label: '通义千问 Qwen',
    apiKeysUrl: 'https://dashscope.console.aliyun.com/apiKey',
    docsUrl: 'https://help.aliyun.com/zh/dashscope/',
    defaultTier: 'tier2',
    description: '阿里通义千问，OpenAI 兼容 API',
  },
  openai: {
    label: 'OpenAI GPT',
    apiKeysUrl: 'https://platform.openai.com/api-keys',
    docsUrl: 'https://platform.openai.com/docs',
    defaultTier: 'tier3',
    description: 'GPT-4o / GPT-4 Turbo，需海外网络',
  },
  claude: {
    label: 'Anthropic Claude',
    apiKeysUrl: 'https://console.anthropic.com/settings/keys',
    docsUrl: 'https://docs.anthropic.com/',
    defaultTier: 'tier3',
    description: 'Claude 3.5 Sonnet，长文本与推理强',
  },
  kimi: {
    label: 'Moonshot Kimi',
    apiKeysUrl: 'https://platform.moonshot.cn/console/api-keys',
    docsUrl: 'https://platform.moonshot.cn/docs',
    defaultTier: 'tier2',
    description: '月之暗面 Kimi，超长上下文',
  },
  glm: {
    label: '智谱 GLM',
    apiKeysUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    docsUrl: 'https://open.bigmodel.cn/dev/api',
    defaultTier: 'tier2',
    description: '智谱 ChatGLM-4，OpenAI 兼容 API',
  },
  baichuan: {
    label: '百川 Baichuan',
    apiKeysUrl: 'https://platform.baichuan-ai.com/console/apikey',
    docsUrl: 'https://platform.baichuan-ai.com/docs/api',
    defaultTier: 'tier2',
    description: '百川大模型，OpenAI 兼容 API',
  },
};

export interface GatewayRequest {
  shopId: string;
  sessionId: string;
  messages: ChatMessage[];
  productId?: string;
  scenario?: string;
  preferredTier?: ModelTier;
  /** 平台级别参数覆盖（优先于全局配置） */
  platformOverrides?: PlatformOverrides;
  /** Function calling 工具定义 */
  tools?: ToolDefinition[];
  /** 工具调用策略：'auto' 让模型自主决定，'none' 禁用工具调用 */
  tool_choice?: 'auto' | 'none';
  /** 最大输出 token 数（透传到 ProviderChatRequest.maxTokens，控制轻量调用的输出长度） */
  maxTokens?: number;
  /** 采样温度（透传到 ProviderChatRequest.temperature，控制输出随机性） */
  temperature?: number;
  /** 是否强制级联：true=按 cascade 配置走；false=即使配置开启也只调一次 directRoute（用于轻量调用避免放大延迟）；undefined=按配置走 */
  cascade?: boolean;
  /** 单次请求总时限（毫秒，含级联/重试），默认 60s；超时返回 fallback 而非无限等待 */
  timeoutMs?: number;
}

export interface CascadeStep {
  tier: ModelTier;
  model: string;
  content: string;
  confidence: number;
  costYuan: number;
  latencyMs: number;
  upgradeReason?: string;
  /** 该轮响应携带的工具调用（存在时说明是 Function Calling 轮次） */
  toolCalls?: ToolCall[];
}

export interface GatewayResponse {
  content: string;
  model: string;
  tokenInput: number;
  tokenOutput: number;
  latencyMs: number;
  cached: boolean;
  truncated: boolean;
  finishReason?: string;
  confidence: number;
  cascadeChain?: CascadeStep[];
  provider: ProviderType;
  costYuan: number;
  /** 模型请求调用的工具列表（finishReason='tool_calls' 时存在） */
  toolCalls?: ToolCall[];
}

export interface ProviderCapability {
  provider: ProviderType;
  tier: ModelTier;
  model: string;
  priceInputPer1k: number;
  priceOutputPer1k: number;
  avgLatencyMs: number;
  maxContextTokens: number;
  available: boolean;
}

export interface ProviderChatRequest {
  shopId: string;
  sessionId: string;
  messages: ChatMessage[];
  productId?: string;
  scenario?: string;
  temperature?: number;
  maxTokens?: number;
  /** 平台级别参数覆盖（优先于全局配置） */
  platformOverrides?: PlatformOverrides;
  /** Function calling 工具定义 */
  tools?: ToolDefinition[];
  /** 工具调用策略：'auto' 让模型自主决定，'none' 禁用工具调用 */
  tool_choice?: 'auto' | 'none';
}
