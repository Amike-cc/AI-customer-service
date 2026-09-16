/**
 * OpenAI 兼容 Provider — 通用类
 *
 * 支持 OpenAI / Kimi / GLM / Baichuan 等所有遵循 OpenAI Chat Completions API 协议的厂商
 * 通过 providerType 字段区分，从 config.gateway.providers.<type> 读取对应配置
 *
 * API 协议参考：https://platform.openai.com/docs/api-reference/chat
 */
import axios, { type AxiosInstance } from 'axios';
import type { IModelProvider } from './IModelProvider';
import type { ChatResponse } from '../../deepseek/DeepSeekClient';
import type { ProviderCapability, ProviderChatRequest, ProviderType } from '../types';
import type { ModelTier } from '../../scheduler/types';
import type { Config } from '../../config/schema';

/** 此通用类支持的 provider 类型 */
export type OpenAICompatibleProviderType = 'openai' | 'kimi' | 'glm' | 'baichuan';

interface OpenAiMessage {
  role: string;
  content: string;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
}

interface OpenAiChoice {
  message: { role: string; content: string; tool_calls?: unknown };
  finish_reason: string;
}

interface OpenAiResponse {
  choices: OpenAiChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  model: string;
}

/** 每个 provider 的定价/能力信息（人民币元/1K tokens） */
const PROVIDER_CAPABILITY_INFO: Record<
  OpenAICompatibleProviderType,
  {
    priceInputPer1k: number;
    priceOutputPer1k: number;
    avgLatencyMs: number;
    maxContextTokens: number;
  }
> = {
  openai: {
    priceInputPer1k: 0.0010, // gpt-4o-mini ≈ $0.15/1M input
    priceOutputPer1k: 0.0030, // gpt-4o-mini ≈ $0.60/1M output
    avgLatencyMs: 2000,
    maxContextTokens: 128000,
  },
  kimi: {
    priceInputPer1k: 0.012, // moonshot-v1-8k ¥12/1M input
    priceOutputPer1k: 0.012,
    avgLatencyMs: 1800,
    maxContextTokens: 8192,
  },
  glm: {
    priceInputPer1k: 0.0001, // glm-4-flash 免费层
    priceOutputPer1k: 0.0001,
    avgLatencyMs: 1500,
    maxContextTokens: 128000,
  },
  baichuan: {
    priceInputPer1k: 0.004, // Baichuan4-Turbo
    priceOutputPer1k: 0.012,
    avgLatencyMs: 2000,
    maxContextTokens: 32768,
  },
};

export class OpenAICompatibleProvider implements IModelProvider {
  readonly provider: ProviderType;
  private currentTier: ModelTier;
  private currentConfig: Config;
  private http: AxiosInstance;
  private readonly apiKey: string;
  private readonly providerType: OpenAICompatibleProviderType;

  constructor(
    providerType: OpenAICompatibleProviderType,
    apiKey: string,
    config: Config,
    tier: ModelTier,
  ) {
    this.providerType = providerType;
    this.provider = providerType as ProviderType;
    this.apiKey = apiKey;
    this.currentConfig = config;
    this.currentTier = tier;
    this.http = this.createHttpClient();
  }

  get tier(): ModelTier {
    return this.currentTier;
  }

  private createHttpClient(): AxiosInstance {
    const cfg = this.getProviderConfig();
    return axios.create({
      baseURL: cfg.api_url,
      timeout: cfg.timeout_ms,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

  private getProviderConfig() {
    return this.currentConfig.gateway.providers[this.providerType];
  }

  get capability(): ProviderCapability {
    const cfg = this.getProviderConfig();
    const info = PROVIDER_CAPABILITY_INFO[this.providerType];
    return {
      provider: this.provider,
      tier: this.tier,
      model: cfg.model,
      priceInputPer1k: info.priceInputPer1k,
      priceOutputPer1k: info.priceOutputPer1k,
      avgLatencyMs: info.avgLatencyMs,
      maxContextTokens: info.maxContextTokens,
      // 与 DeepSeekProvider 一致：未配置 API Key 时视为不可用，避免选入级联后白白增加失败延迟
      available: this.apiKey.trim().length > 0,
    };
  }

  async chat(req: ProviderChatRequest): Promise<ChatResponse> {
    const start = Date.now();
    const cfg = this.getProviderConfig();
    // 完整透传消息结构（tool_calls/tool_call_id/name），否则 Function Calling 工具循环
    // 在非 DeepSeek provider 上会因 assistant(无 tool_calls) + tool 消息序列 400 而失效
    const messages = req.messages.map((m) => {
      const base: OpenAiMessage = {
        role: m.role,
        content: m.content,
      };
      if (m.tool_calls) base.tool_calls = m.tool_calls;
      if (m.tool_call_id) base.tool_call_id = m.tool_call_id;
      if (m.name) base.name = m.name;
      return base;
    });

    const body: Record<string, unknown> = {
      model: cfg.model,
      messages,
      temperature: req.temperature ?? this.currentConfig.deepseek.temperature,
      max_tokens: req.maxTokens ?? this.currentConfig.deepseek.max_tokens,
      stream: false,
    };
    // Function calling：透传工具定义与调用策略
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
      body.tool_choice = req.tool_choice ?? 'auto';
    }

    const resp = await this.http.post<OpenAiResponse>('', body);
    const choice = resp.data?.choices?.[0];
    if (!choice || !choice.message) {
      throw new Error(
        `OpenAI 兼容接口返回异常：choices 为空 (httpStatus=${resp.status})`,
      );
    }
    const usage = resp.data.usage;
    const content = (choice.message.content as string | undefined) ?? '';
    const toolCalls = Array.isArray(choice.message.tool_calls)
      ? (choice.message.tool_calls as unknown)
      : undefined;

    return {
      content,
      tokenInput: usage?.prompt_tokens ?? 0,
      tokenOutput: usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - start,
      model: resp.data.model ?? cfg.model,
      cached: false,
      finishReason: choice.finish_reason,
      truncated: choice.finish_reason === 'length',
      ...(toolCalls ? { toolCalls: toolCalls as ChatResponse['toolCalls'] } : {}),
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const cfg = this.getProviderConfig();
      const resp = await this.http.post<OpenAiResponse>(
        '',
        {
          model: cfg.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        },
        { timeout: 5000 },
      );
      return !!resp.data.choices;
    } catch {
      return false;
    }
  }

  updateConfig(config: Config): void {
    this.currentConfig = config;
    this.currentTier = this.getProviderConfig().tier;
    this.http = this.createHttpClient();
  }
}
