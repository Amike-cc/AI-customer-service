/**
 * Anthropic Claude Provider — 调用 Anthropic Messages API
 *
 * Claude 的 API 协议与 OpenAI 不兼容：
 * - 端点：POST https://api.anthropic.com/v1/messages
 * - 认证头：x-api-key: <key>（不是 Bearer Token）
 * - 必须头：anthropic-version: 2023-06-01
 * - 请求体：system 字段独立，messages 数组只含 user/assistant
 * - 响应格式：content 数组而非 choices
 *
 * API 文档：https://docs.anthropic.com/en/api/messages
 */
import axios, { type AxiosInstance } from 'axios';
import type { IModelProvider } from './IModelProvider';
import type { ChatResponse } from '../../deepseek/DeepSeekClient';
import type { ProviderCapability, ProviderChatRequest, ProviderType } from '../types';
import type { ModelTier } from '../../scheduler/types';
import type { Config } from '../../config/schema';

interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | ClaudeContentBlock[];
}

interface ClaudeContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
}

interface ClaudeResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: ClaudeContentBlock[];
  stop_reason: string | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export class ClaudeProvider implements IModelProvider {
  readonly provider: ProviderType = 'claude';
  private currentTier: ModelTier;
  private currentConfig: Config;
  private http: AxiosInstance;
  private readonly apiKey: string;

  constructor(apiKey: string, config: Config, tier: ModelTier = 'tier3') {
    this.apiKey = apiKey;
    this.currentConfig = config;
    this.currentTier = tier;
    this.http = this.createHttpClient();
  }

  get tier(): ModelTier {
    return this.currentTier;
  }

  private createHttpClient(): AxiosInstance {
    const cfg = this.currentConfig.gateway.providers.claude;
    return axios.create({
      baseURL: cfg.api_url,
      timeout: cfg.timeout_ms,
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': cfg.anthropic_version,
        'Content-Type': 'application/json',
      },
    });
  }

  get capability(): ProviderCapability {
    return {
      provider: 'claude',
      tier: this.tier,
      model: this.currentConfig.gateway.providers.claude.model,
      priceInputPer1k: 0.021, // Claude 3.5 Sonnet ≈ $3/1M input
      priceOutputPer1k: 0.075, // Claude 3.5 Sonnet ≈ $15/1M output
      avgLatencyMs: 2500,
      maxContextTokens: 200000,
      available: this.apiKey.trim().length > 0,
    };
  }

  async chat(req: ProviderChatRequest): Promise<ChatResponse> {
    const start = Date.now();
    const cfg = this.currentConfig.gateway.providers.claude;

    // Anthropic API：system 字段独立，messages 数组只含 user/assistant
    let systemPrompt = '';
    const claudeMessages: ClaudeMessage[] = [];
    for (const m of req.messages) {
      if (m.role === 'system') {
        systemPrompt += (systemPrompt ? '\n\n' : '') + m.content;
      } else if (m.role === 'user') {
        claudeMessages.push({ role: m.role, content: m.content });
      } else if (m.role === 'assistant') {
        // assistant 带 tool_calls 时转换为 tool_use 内容块
        if (m.tool_calls && m.tool_calls.length > 0) {
          const blocks: ClaudeContentBlock[] = [];
          if (m.content) {
            blocks.push({ type: 'text', text: m.content });
          }
          for (const tc of m.tool_calls) {
            let input: unknown = {};
            try {
              input = JSON.parse(tc.function.arguments);
            } catch {
              input = { raw: tc.function.arguments };
            }
            blocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input,
            });
          }
          claudeMessages.push({ role: 'assistant', content: blocks });
        } else {
          claudeMessages.push({ role: m.role, content: m.content });
        }
      }
      // tool 角色消息转换为 user 的 tool_result 内容块
      else if (m.role === 'tool') {
        claudeMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: m.tool_call_id ?? '',
              content: m.content,
            },
          ],
        });
      }
    }

    const body: Record<string, unknown> = {
      model: cfg.model,
      messages: claudeMessages,
      max_tokens: req.maxTokens ?? this.currentConfig.deepseek.max_tokens,
      stream: false,
    };
    if (req.temperature != null) {
      body.temperature = req.temperature;
    }
    if (systemPrompt) {
      body.system = systemPrompt;
    }
    // Function calling：转换为 Anthropic tools 格式（input_schema 为 JSON Schema）
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
      body.tool_choice = req.tool_choice === 'none' ? { type: 'none' } : { type: 'auto' };
    }

    const resp = await this.http.post<ClaudeResponse>('', body);
    const text = resp.data.content
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text)
      .join('');
    // 解析 tool_use 块为 OpenAI 兼容 ToolCall
    const toolCalls = resp.data.content
      .filter((b) => b.type === 'tool_use' && b.id && b.name)
      .map((b) => ({
        id: b.id!,
        type: 'function' as const,
        function: {
          name: b.name!,
          arguments: JSON.stringify(b.input ?? {}),
        },
      }));
    const finishReason = resp.data.stop_reason ?? 'stop';
    const usage = resp.data.usage;

    return {
      content: text,
      tokenInput: usage?.input_tokens ?? 0,
      tokenOutput: usage?.output_tokens ?? 0,
      latencyMs: Date.now() - start,
      model: resp.data.model,
      cached: false,
      finishReason,
      truncated: finishReason === 'max_tokens',
      ...(toolCalls.length > 0 ? { toolCalls: toolCalls as ChatResponse['toolCalls'] } : {}),
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const cfg = this.currentConfig.gateway.providers.claude;
      const resp = await this.http.post<ClaudeResponse>(
        '',
        {
          model: cfg.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        },
        { timeout: 5000 },
      );
      return !!resp.data.content;
    } catch {
      return false;
    }
  }

  updateConfig(config: Config): void {
    this.currentConfig = config;
    this.currentTier = config.gateway.providers.claude.tier;
    this.http = this.createHttpClient();
  }
}
