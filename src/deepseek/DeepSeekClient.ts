/**
 * DeepSeek API 客户端
 * 详见 docs/开发文档-v2.md §10
 */
import { EventEmitter } from 'events';
import axios, { type AxiosInstance } from 'axios';
import type { Config } from '../config/schema';
import type { MetricsCollector } from '../monitor/MetricsCollector';
import type { ToolCall, ToolDefinition } from '../tools/types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant 消息携带的工具调用请求 */
  tool_calls?: ToolCall[];
  /** tool 角色消息对应的工具调用 ID */
  tool_call_id?: string;
  /** tool 角色消息对应的工具名 */
  name?: string;
  /** 图片 URL 列表（仅 user 消息，DeepSeek V4 Vision 多模态输入） */
  images?: string[];
}

export interface DeepseekErrorEvent {
  shopId: string;
  sessionId: string;
  errorType: 'auth_failed' | 'insufficient_balance' | 'timeout' | 'rate_limit' | 'error' | 'circuit_open';
  message: string;
  timestamp: number;
}

/** 平台级别参数覆盖（优先于全局配置） */
export interface PlatformOverrides {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  fallback_response?: string;
}

export interface ChatRequest {
  shopId: string;
  sessionId: string;
  messages: ChatMessage[];
  productId?: string;
  scenario?: string;
  /** 平台级别参数覆盖（优先于全局配置） */
  platformOverrides?: PlatformOverrides;
  /** Function calling 工具定义（OpenAI 兼容格式） */
  tools?: ToolDefinition[];
  /** 工具调用策略：'auto' 让模型自主决定，'none' 禁用工具调用 */
  tool_choice?: 'auto' | 'none';
}

export interface ChatResponse {
  content: string;
  tokenInput: number;
  tokenOutput: number;
  latencyMs: number;
  model: string;
  cached: boolean;
  finishReason?: string;
  truncated: boolean;
  /** 模型请求调用的工具列表（finishReason='tool_calls' 时存在） */
  toolCalls?: ToolCall[];
}

export class DeepSeekClient extends EventEmitter {
  private http: AxiosInstance;
  private consecutiveFailures = 0;
  private circuitState: 'closed' | 'open' | 'half-open' = 'closed';
  private circuitOpenedAt = 0;
  private readonly circuitThreshold = 5;
  private readonly circuitResetMs = 60000;
  private lastErrorNotify = new Map<string, number>();
  private static readonly ERROR_NOTIFY_DEDUP_MS = 30000;

  constructor(
    private config: Config,
    private apiKey: string,
    private metrics: MetricsCollector,
  ) {
    super();
    this.http = this.createHttpClient(apiKey);
  }

  /** 更新 API Key（运行时热更新，供 UI 调用） */
  updateApiKey(newApiKey: string): void {
    this.apiKey = newApiKey;
    this.http = this.createHttpClient(newApiKey);
  }

  /** 更新配置（运行时热重载） */
  updateConfig(newConfig: Config): void {
    this.config = newConfig;
    this.http = this.createHttpClient(this.apiKey);
  }

  get currentApiKey(): string {
    return this.apiKey;
  }

  /** 获取熔断器状态（供诊断面板使用） */
  getCircuitState(): { state: 'closed' | 'open' | 'half-open'; consecutiveFailures: number; openedAt: number } {
    return {
      state: this.circuitState,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.circuitOpenedAt,
    };
  }

  private createHttpClient(key: string): AxiosInstance {
    return axios.create({
      baseURL: this.config.deepseek.api_url,
      timeout: this.config.deepseek.timeout_ms,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
    });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const po = req.platformOverrides; // 平台覆盖（优先于全局配置）
    const fallbackResp = po?.fallback_response ?? this.config.deepseek.fallback_response;

    // 首次启动允许用户先进入设置界面配置 Key。未配置时不得发起无效网络请求，
    // 也不能让调用方误判为真实模型回复。
    if (!this.apiKey.trim()) {
      this.metrics.inc('api_call_total', 1, { status: 'auth_failed' }, req.shopId);
      this.emitChatError(req.shopId, req.sessionId, 'auth_failed');
      return {
        content: fallbackResp,
        tokenInput: 0,
        tokenOutput: 0,
        latencyMs: 0,
        model: 'fallback',
        cached: false,
        truncated: false,
      };
    }

    if (this.circuitState === 'open') {
      if (Date.now() - this.circuitOpenedAt > this.circuitResetMs) {
        this.circuitState = 'half-open';
      } else {
        this.emitChatError(req.shopId, req.sessionId, 'circuit_open');
        return {
          content: fallbackResp,
          tokenInput: 0,
          tokenOutput: 0,
          latencyMs: 0,
          model: 'circuit-open',
          cached: false,
          truncated: false,
        };
      }
    }

    const scenario = req.scenario ? this.config.deepseek.scenarios?.[req.scenario] : undefined;
    // 多模态：user 消息带图片时转为 OpenAI 兼容的 content 数组格式（DeepSeek V4 Vision）
    const apiMessages = req.messages.map((m) => {
      if (m.images && m.images.length > 0 && m.role === 'user') {
        const content = [
          { type: 'text' as const, text: m.content },
          ...m.images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
        ];
        return { ...m, content };
      }
      return m;
    });
    const params: Record<string, unknown> = {
      model: po?.model ?? this.config.deepseek.model,
      messages: apiMessages,
      // 参数优先级：平台级覆盖 > 场景级 > 全局（与 model/max_tokens 一致，避免 provider 透传被场景静默覆盖）
      temperature: po?.temperature ?? scenario?.temperature ?? this.config.deepseek.temperature,
      max_tokens: po?.max_tokens ?? scenario?.max_tokens ?? this.config.deepseek.max_tokens,
      top_p: po?.top_p ?? this.config.deepseek.top_p,
      stream: this.config.deepseek.stream,
    };
    // Function calling：有工具定义时附加 tools + tool_choice
    if (req.tools && req.tools.length > 0) {
      params.tools = req.tools;
      params.tool_choice = req.tool_choice ?? 'auto';
    }

    const start = Date.now();
    const maxRetries = this.config.deepseek.retry_count;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const resp = await this.http.post('', params);
        if (this.circuitState === 'half-open') {
          this.circuitState = 'closed';
        }
        const latencyMs = Date.now() - start;
        // 防御性检查：API 异常时 choices 可能为空数组或 undefined
        const choice = resp.data?.choices?.[0];
        if (!choice || !choice.message) {
          throw new Error(
            `DeepSeek API 返回异常：choices 为空 (httpStatus=${resp.status}, data=${JSON.stringify(resp.data).slice(0, 200)})`,
          );
        }
        const content = (choice.message.content as string) ?? '';
        const finishReason = choice.finish_reason as string | undefined;
        const truncated = finishReason === 'length';
        // Function calling：解析工具调用请求
        const toolCalls = Array.isArray(choice.message.tool_calls)
          ? (choice.message.tool_calls as ToolCall[])
          : undefined;
        const tokenInput = (resp.data?.usage?.prompt_tokens ?? 0) as number;
        const tokenOutput = (resp.data?.usage?.completion_tokens ?? 0) as number;

        this.consecutiveFailures = 0;

        if (truncated) {
          this.metrics.inc('reply_truncated_total', 1, undefined, req.shopId);
        }
        this.metrics.inc('token_consumed_total', tokenInput, { type: 'input' }, req.shopId);
        this.metrics.inc('token_consumed_total', tokenOutput, { type: 'output' }, req.shopId);
        this.metrics.inc('api_call_total', 1, { status: 'ok' }, req.shopId);
        this.metrics.observe('api_latency_ms', latencyMs, undefined, req.shopId);

        return {
          content,
          tokenInput,
          tokenOutput,
          latencyMs,
          // 优先使用 API 返回的实际模型名（别名/降级时保持真实）
          model: (resp.data?.model as string | undefined) ?? (params.model as string),
          cached: false,
          finishReason,
          truncated,
          toolCalls,
        };
      } catch (err: unknown) {
        this.consecutiveFailures += 1;
        const errorClass = this.classifyError(err);
        this.metrics.inc('api_call_total', 1, { status: errorClass }, req.shopId);

        if (this.consecutiveFailures >= this.circuitThreshold) {
          this.circuitState = 'open';
          this.circuitOpenedAt = Date.now();
        }

        // 401/402: 认证/余额错误，重试无意义
        // 400/404/413/422 等确定性错误（参数格式、模型名不存在、上下文超长）重试只会放大延迟与成本
        const isDeterministicError =
          axios.isAxiosError(err) &&
          err.response != null &&
          err.response.status >= 400 &&
          err.response.status < 500 &&
          err.response.status !== 429;
        if (
          errorClass === 'auth_failed' ||
          errorClass === 'insufficient_balance' ||
          isDeterministicError
        ) {
          this.emitChatError(req.shopId, req.sessionId, errorClass);
          return {
            content: fallbackResp,
            tokenInput: 0,
            tokenOutput: 0,
            latencyMs: Date.now() - start,
            model: 'fallback',
            cached: false,
            truncated: false,
          };
        }

        // 已是最后一次尝试，返回 fallback
        if (attempt >= maxRetries) {
          this.emitChatError(req.shopId, req.sessionId, errorClass);
          return {
            content: fallbackResp,
            tokenInput: 0,
            tokenOutput: 0,
            latencyMs: Date.now() - start,
            model: 'fallback',
            cached: false,
            truncated: false,
          };
        }

        // 指数退避 + 抖动：base * 2^attempt + random(0, 500)
        // 429 限流用 2x 基础延迟
        const baseDelay = this.config.deepseek.retry_interval_ms;
        const multiplier = errorClass === 'rate_limit' ? 2 : 1;
        const delay = baseDelay * multiplier * Math.pow(2, attempt) + Math.random() * 500;
        await new Promise((r) => {
          const t = setTimeout(r, delay);
          t.unref?.();
        });
      }
    }

    // 不会到达，但 TypeScript 需要
    return {
      content: fallbackResp,
      tokenInput: 0,
      tokenOutput: 0,
      latencyMs: Date.now() - start,
      model: 'fallback',
      cached: false,
      truncated: false,
    };
  }

  /**
   * 带续写的对话：检测到截断时自动调用 API 继续，最多续写 1 次
   */
  async chatWithContinuation(req: ChatRequest): Promise<ChatResponse> {
    const first = await this.chat(req);

    if (!first.truncated || first.cached) {
      return first;
    }

    this.metrics.inc('reply_continuation_total', 1, undefined, req.shopId);
    const continuationMessages = [
      ...req.messages,
      { role: 'assistant' as const, content: first.content },
      { role: 'user' as const, content: '请继续上次未完成的回复，直接接续内容，不要重复已生成的内容。' },
    ];

    const second = await this.chat({
      ...req,
      messages: continuationMessages,
    });

    // 续写调用失败时（model='fallback' 表示系统繁忙兜底文案），
    // 绝不能把兜底文案拼进真实截断回复——直接返回第一次的完整结果
    if (second.model === 'fallback') {
      console.warn(
        `[DeepSeekClient] 续写调用失败（shopId=${req.shopId}），返回截断前的原始回复`,
      );
      return first;
    }

    const combined = this.mergeContinuation(first.content, second.content);

    return {
      content: combined,
      tokenInput: first.tokenInput + second.tokenInput,
      tokenOutput: first.tokenOutput + second.tokenOutput,
      latencyMs: first.latencyMs + second.latencyMs,
      model: first.model,
      cached: false,
      finishReason: second.finishReason,
      truncated: second.truncated,
    };
  }

  /**
   * 合并续写内容：去除可能的重复前缀
   */
  private mergeContinuation(first: string, second: string): string {
    const overlap = this.findOverlap(first, second);
    if (overlap > 0) {
      return first + second.slice(overlap);
    }
    return first + second;
  }

  /**
   * 查找两段文本的重叠部分长度
   */
  private findOverlap(first: string, second: string): number {
    const maxOverlap = Math.min(first.length, second.length, 100);
    for (let len = maxOverlap; len > 0; len--) {
      if (first.endsWith(second.slice(0, len))) {
        return len;
      }
    }
    return 0;
  }

  private classifyError(err: unknown): DeepseekErrorEvent['errorType'] {
    if (!axios.isAxiosError(err)) return 'error';
    if (err.response?.status === 429) return 'rate_limit';
    if (err.response?.status === 402) return 'insufficient_balance';
    if (err.response?.status === 401) return 'auth_failed';
    if (err.code === 'ECONNABORTED') return 'timeout';
    return 'error';
  }

  private emitChatError(
    shopId: string,
    sessionId: string,
    errorType: DeepseekErrorEvent['errorType'],
  ): void {
    const key = `${shopId}:${errorType}`;
    const lastTime = this.lastErrorNotify.get(key);
    if (lastTime && Date.now() - lastTime < DeepSeekClient.ERROR_NOTIFY_DEDUP_MS) {
      return;
    }
    this.lastErrorNotify.set(key, Date.now());

    this.emit('chatError', {
      shopId,
      sessionId,
      errorType,
      message: this.getErrorMessage(errorType),
      timestamp: Date.now(),
    } satisfies DeepseekErrorEvent);
  }

  private getErrorMessage(errorType: string): string {
    switch (errorType) {
      case 'auth_failed':
        return 'DeepSeek API Key 认证失败，请检查 API Key 配置';
      case 'insufficient_balance':
        return 'DeepSeek API 余额不足，请及时充值';
      case 'timeout':
        return 'DeepSeek API 连接超时，请检查网络连接';
      case 'rate_limit':
        return 'DeepSeek API 请求频率过高，已被限流';
      case 'circuit_open':
        return 'DeepSeek API 熔断器已开启，连续失败过多，请稍后重试';
      default:
        return 'DeepSeek API 连接失败，请检查网络或配置';
    }
  }
}
