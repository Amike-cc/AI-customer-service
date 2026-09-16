/**
 * 通义千问 Provider — 调用 DashScope OpenAI 兼容 API
 * 作为 tier2 中间层，在本地模型置信度不足时承接
 *
 * API 文档：https://help.aliyun.com/zh/dashscope/developer-reference/compatibility-of-openai-with-dashscope
 */
import axios, { type AxiosInstance } from 'axios';
import type { IModelProvider } from './IModelProvider';
import type { ChatResponse } from '../../deepseek/DeepSeekClient';
import type { ProviderCapability, ProviderChatRequest, ProviderType } from '../types';
import type { ModelTier } from '../../scheduler/types';
import type { Config } from '../../config/schema';

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

export class QwenProvider implements IModelProvider {
  readonly provider: ProviderType = 'qwen';
  private currentTier: ModelTier;
  private currentConfig: Config;
  private http: AxiosInstance;
  private readonly apiKey: string;

  constructor(apiKey: string, config: Config, tier: ModelTier = 'tier2') {
    this.apiKey = apiKey;
    this.currentConfig = config;
    this.currentTier = tier;
    this.http = axios.create({
      baseURL: config.gateway.providers.qwen.api_url,
      timeout: config.gateway.providers.qwen.timeout_ms,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

  get tier(): ModelTier {
    return this.currentTier;
  }

  get capability(): ProviderCapability {
    return {
      provider: 'qwen',
      tier: this.tier,
      model: this.currentConfig.gateway.providers.qwen.model,
      priceInputPer1k: 0.004,
      priceOutputPer1k: 0.012,
      avgLatencyMs: 1500,
      maxContextTokens: 32768,
      available: this.apiKey.trim().length > 0,
    };
  }

  async chat(req: ProviderChatRequest): Promise<ChatResponse> {
    const start = Date.now();
    const messages: OpenAiMessage[] = req.messages.map((m) => {
      const base: OpenAiMessage = { role: m.role, content: m.content };
      if (m.tool_calls) base.tool_calls = m.tool_calls;
      if (m.tool_call_id) base.tool_call_id = m.tool_call_id;
      if (m.name) base.name = m.name;
      return base;
    });

    const body: Record<string, unknown> = {
      model: this.currentConfig.gateway.providers.qwen.model,
      messages,
      temperature: req.temperature ?? this.currentConfig.deepseek.temperature,
      max_tokens: req.maxTokens ?? this.currentConfig.deepseek.max_tokens,
      stream: false,
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
      body.tool_choice = req.tool_choice ?? 'auto';
    }

    const resp = await this.http.post<OpenAiResponse>('', body);
    const choice = resp.data?.choices?.[0];
    if (!choice || !choice.message) {
      throw new Error(
        `通义千问接口返回异常：choices 为空 (httpStatus=${resp.status})`,
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
      model: resp.data.model ?? this.currentConfig.gateway.providers.qwen.model,
      cached: false,
      finishReason: choice.finish_reason,
      truncated: choice.finish_reason === 'length',
      ...(toolCalls ? { toolCalls: toolCalls as ChatResponse['toolCalls'] } : {}),
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await this.http.post<OpenAiResponse>('', {
        model: this.currentConfig.gateway.providers.qwen.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      });
      return !!resp.data?.choices;
    } catch {
      return false;
    }
  }

  updateConfig(config: Config): void {
    this.currentConfig = config;
    this.currentTier = config.gateway.providers.qwen.tier;
    this.http = axios.create({
      baseURL: config.gateway.providers.qwen.api_url,
      timeout: config.gateway.providers.qwen.timeout_ms,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }
}
