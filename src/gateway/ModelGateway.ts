/**
 * 模型网关：将"选哪个模型"与"做什么"分离
 * 支持级联调用：Tier1 → Tier2 → Tier3，置信度不足时自动升级
 */
import type { GatewayRequest, GatewayResponse, CascadeStep, ProviderType } from './types';
import type { ModelTier } from '../scheduler/types';
import type { IModelProvider } from './providers/IModelProvider';
import type { ModelRegistry } from './ModelRegistry';
import type { ConfidenceEvaluator } from './ConfidenceEvaluator';
import type { ResourceScheduler } from '../scheduler/ResourceScheduler';
import type { Config } from '../config/schema';
import type { MetricsCollector } from '../monitor/MetricsCollector';
import type { AppLogger } from '../logging/logger';
import type { ChatMessage, ChatResponse } from '../deepseek/DeepSeekClient';

export interface ModelGatewayDeps {
  registry: ModelRegistry;
  confidenceEvaluator: ConfidenceEvaluator;
  scheduler: ResourceScheduler;
  metrics: MetricsCollector;
  logger: AppLogger;
  config: Config;
}

const TIER_ORDER: ModelTier[] = ['tier1', 'tier2', 'tier3'];

export class ModelGateway {
  constructor(private deps: ModelGatewayDeps) {}

  async route(req: GatewayRequest): Promise<GatewayResponse> {
    // 端到端总时限：工具循环 3 轮 × 级联 3 层 × 重试可能达分钟级，
    // 平台侧 5~30s 无回复即超时，必须兜底返回 fallback 而非无限阻塞
    const timeoutMs = req.timeoutMs ?? 60_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.routeInternal(req),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`LLM 请求总超时 ${timeoutMs}ms`)), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      if (timer) clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('总超时')) {
        this.deps.logger.warn({ shopId: req.shopId, sessionId: req.sessionId, timeoutMs }, 'LLM 请求总超时，返回 fallback');
        return this.makeFallback(req, 'request_timeout');
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async routeInternal(req: GatewayRequest): Promise<GatewayResponse> {
    const startTier = req.preferredTier ?? 'tier2';
    // cascade 字段优先级：req.cascade 显式指定 > config.gateway.cascade.enabled 默认配置
    // req.cascade=false 时即使配置开启也走 directRoute（用于意图识别/情绪检测等轻量调用避免放大延迟）
    const cascadeEnabled =
      this.deps.config.gateway.enabled &&
      this.deps.config.gateway.cascade.enabled &&
      req.cascade !== false;

    if (!cascadeEnabled) {
      return this.directRoute(req, startTier);
    }

    return this.cascade(req, startTier);
  }

  private async directRoute(req: GatewayRequest, tier: ModelTier): Promise<GatewayResponse> {
    const provider = this.deps.registry.getAvailableByTier(tier);
    if (!provider) {
      return this.makeFallback(req, 'no_provider_available', undefined);
    }
    // 预算强制：directRoute 也必须先 acquire（此前只 recordCost 不拦阻，
    // 意图识别/情绪检测等高频调用与 cascade 关闭时的所有主回复会绕过每日预算/令牌桶）
    const estimatedCost = this.estimateCost(req.messages, provider, req.maxTokens);
    const decision = await this.deps.scheduler.acquire({
      shopId: req.shopId,
      estimatedTokens: this.estimateTokens(req.messages),
      estimatedCostYuan: estimatedCost,
      estimatedCostByTier: this.estimateCostsByTier(req.messages, req.maxTokens),
      tier,
    });
    if (!decision.allowed) {
      return this.makeFallback(req, decision.rejectReason ?? 'budget_exceeded');
    }
    const actualProvider =
      decision.allocatedTier !== tier
        ? (this.deps.registry.getAvailableByTier(decision.allocatedTier) ?? provider)
        : provider;
    try {
      const response = await actualProvider.chat({
        shopId: req.shopId,
        sessionId: req.sessionId,
        messages: req.messages,
        productId: req.productId,
        scenario: req.scenario,
        platformOverrides: req.platformOverrides,
        tools: req.tools,
        tool_choice: req.tool_choice,
        // 透传轻量调用的参数控制（如意图识别 maxTokens=200、情绪检测 maxTokens=10）
        maxTokens: req.maxTokens,
        temperature: req.temperature,
      });
      const cost = this.calculateCost(response, actualProvider.capability.priceInputPer1k, actualProvider.capability.priceOutputPer1k);
      // 直连路径同样计入成本/预算，否则意图识别/情绪检测等高频轻量调用会绕过每日预算上限
      this.deps.scheduler.recordCost({
        shopId: req.shopId,
        costYuan: cost,
        tokens: response.tokenInput + response.tokenOutput,
        timestamp: Date.now(),
        tier: decision.allocatedTier,
        provider: actualProvider.provider,
      }, decision.reservationId);
      // 计算真实置信度（替代硬编码 0.8）：兜底/失败响应给出 0 分，
      // 避免监控与升级决策被虚高置信度误导。
      // 注意：provider 的 content 可能是数组（vision 多模态模型），须容错
      let confidence = 0;
      try {
        confidence = this.deps.confidenceEvaluator.evaluate({
          content: String(response.content ?? ''),
          finishReason: response.finishReason,
          truncated: response.truncated,
          model: response.model,
          tier: decision.allocatedTier,
          maxTokens: req.maxTokens ?? this.getMaxTokens(decision.allocatedTier),
        });
      } catch (e) {
        this.deps.logger.debug({ err: e, provider: actualProvider.provider }, '置信度评估失败，使用 0 分');
      }
      return this.toGatewayResponse(response, actualProvider.provider, cost, [], 0, confidence);
    } catch (err) {
      this.deps.scheduler.releaseReservation(decision.reservationId);
      this.deps.logger.warn(
        { shopId: req.shopId, provider: actualProvider.provider, err },
        'Model provider request failed',
      );
      return this.makeFallback(req, 'provider_request_failed', actualProvider.provider);
    }
  }

  private async cascade(req: GatewayRequest, startTier: ModelTier): Promise<GatewayResponse> {
    const cascadeChain: CascadeStep[] = [];
    const startIndex = TIER_ORDER.indexOf(startTier);
    const maxDepth = this.deps.config.gateway.cascade.max_depth;
    let totalCost = 0;
    let totalLatency = 0;
    let lastResponse: ChatResponse | null = null;
    let lastProvider: IModelProvider | null = null;

    for (let depth = 0; depth < maxDepth && startIndex + depth < TIER_ORDER.length; depth++) {
      const tier = TIER_ORDER[startIndex + depth];
      const provider = this.deps.registry.getAvailableByTier(tier);

      if (!provider || !provider.capability.available) {
        continue;
      }

      const estimatedCost = this.estimateCost(
        this.buildCascadeMessages(req, cascadeChain),
        provider,
        req.maxTokens,
      );
      const scheduleDecision = await this.deps.scheduler.acquire({
        shopId: req.shopId,
        estimatedTokens: this.estimateTokens(req.messages),
        estimatedCostYuan: estimatedCost,
        estimatedCostByTier: this.estimateCostsByTier(
          this.buildCascadeMessages(req, cascadeChain),
          req.maxTokens,
        ),
        tier,
      });

      if (!scheduleDecision.allowed) {
        if (depth === 0) {
          return this.makeFallback(req, scheduleDecision.rejectReason ?? 'budget_exceeded');
        }
        break;
      }

      const actualTier = scheduleDecision.allocatedTier;
      const actualProvider = actualTier !== tier
        ? this.deps.registry.getAvailableByTier(actualTier)
        : provider;
      if (!actualProvider) {
        this.deps.scheduler.releaseReservation(scheduleDecision.reservationId);
        continue;
      }

      const cascadeMessages = this.buildCascadeMessages(req, cascadeChain);
      let response: ChatResponse;
      const providerStartedAt = Date.now();
      try {
        response = await actualProvider.chat({
          shopId: req.shopId,
          sessionId: req.sessionId,
          messages: cascadeMessages,
          productId: req.productId,
          scenario: req.scenario,
          platformOverrides: req.platformOverrides,
          tools: req.tools,
          tool_choice: req.tool_choice,
          // 透传轻量调用的参数控制
          maxTokens: req.maxTokens,
          temperature: req.temperature,
        });
      } catch (err) {
        this.deps.scheduler.releaseReservation(scheduleDecision.reservationId);
        const latencyMs = Date.now() - providerStartedAt;
        totalLatency += latencyMs;
        cascadeChain.push({
          tier: actualTier,
          model: actualProvider.capability.model,
          content: '',
          confidence: 0,
          costYuan: 0,
          latencyMs,
          upgradeReason: `provider error: ${err instanceof Error ? err.message : String(err)}`,
        });
        this.deps.metrics.inc(
          'model_provider_failed_total',
          1,
          { provider: actualProvider.provider, tier: actualTier },
          req.shopId,
        );
        this.deps.logger.warn(
          { shopId: req.shopId, provider: actualProvider.provider, tier: actualTier, err },
          'Model provider failed, continuing cascade',
        );
        continue;
      }

      const actualCost = this.calculateCost(
        response,
        actualProvider.capability.priceInputPer1k,
        actualProvider.capability.priceOutputPer1k,
      );
      totalCost += actualCost;
      totalLatency += response.latencyMs;

      this.deps.scheduler.recordCost({
        shopId: req.shopId,
        costYuan: actualCost,
        tokens: response.tokenInput + response.tokenOutput,
        timestamp: Date.now(),
        tier: actualTier,
        provider: actualProvider.provider,
      }, scheduleDecision.reservationId);

      // 置信度评估：content 可能是数组（vision 模型）或评估器异常，均不能中断级联
      let confidence = 0;
      try {
        confidence = this.deps.confidenceEvaluator.evaluate({
          content: String(response.content ?? ''),
          finishReason: response.finishReason,
          truncated: response.truncated,
          // 传入真实响应 model（含 'fallback'/'circuit-open' 标记），
          // 让 ConfidenceEvaluator 能识别失败响应并给出 0 分，使级联继续降级
          model: response.model,
          tier: actualTier,
          maxTokens: req.maxTokens ?? this.getMaxTokens(actualTier),
        });
      } catch (e) {
        this.deps.logger.debug({ err: e, provider: actualProvider.provider }, '置信度评估失败，使用 0 分');
      }

      const step: CascadeStep = {
        tier: actualTier,
        model: actualProvider.capability.model,
        content: response.content,
        confidence,
        costYuan: actualCost,
        latencyMs: response.latencyMs,
        toolCalls: response.toolCalls,
      };

      const threshold = this.deps.config.gateway.cascade.confidence_thresholds[actualTier];
      // Function Calling 轮次（带 tool_calls）即使置信度低也不升级：
      // 注入 user 指令会破坏 tool 消息流语义，且上层 BaseAgent 会自行处理工具结果
      if (response.toolCalls && response.toolCalls.length > 0) {
        cascadeChain.push(step);
        lastResponse = response;
        lastProvider = actualProvider;
        break;
      }
      if (confidence >= threshold) {
        cascadeChain.push(step);
        lastResponse = response;
        lastProvider = actualProvider;
        break;
      }

      step.upgradeReason = `confidence ${confidence.toFixed(3)} < threshold ${threshold}`;
      cascadeChain.push(step);
      lastResponse = response;
      lastProvider = actualProvider;
    }

    if (!lastResponse || !lastProvider) {
      return this.makeFallback(req, 'no_provider_available');
    }

    return this.toGatewayResponse(
      lastResponse,
      lastProvider.provider,
      totalCost,
      cascadeChain,
      totalLatency,
    );
  }

  private buildCascadeMessages(req: GatewayRequest, chain: CascadeStep[]): ChatMessage[] {
    if (chain.length === 0) {
      return req.messages;
    }
    // 跳过 Function Calling 轮次（content 为空、仅 tool_calls）：
    // 在 assistant 消息流中间插入空 content 消息会让 OpenAI 兼容 provider 报 schema 错误
    const lastStep = [...chain].reverse().find((step) => step.content.length > 0);
    if (!lastStep) return req.messages;
    // 最后一步带 tool_calls（模型同时给出回复与工具调用）：不注入 user 指令，
    // 保留工具消息流语义（OpenAI 兼容 API 要求 tool_calls 后紧跟 tool 结果消息）
    if (lastStep.toolCalls && lastStep.toolCalls.length > 0) {
      return req.messages;
    }
    return [
      ...req.messages,
      { role: 'assistant', content: lastStep.content },
      { role: 'user', content: '请基于以上回复，给出更准确、完整的回答。' },
    ];
  }

  private calculateCost(response: ChatResponse, priceIn: number, priceOut: number): number {
    return (response.tokenInput * priceIn + response.tokenOutput * priceOut) / 1000;
  }

  private estimateCost(
    messages: ChatMessage[],
    provider: IModelProvider,
    requestedMaxTokens?: number,
  ): number {
    const maxOutput = requestedMaxTokens ?? this.deps.config.deepseek.max_tokens;
    const allowsContinuation = provider.provider === 'deepseek';
    // 字符数作为输入 token 上界；DeepSeek 自动续写时再预留一次输出及其上下文。
    const estimatedInput =
      messages.reduce((sum, m) => sum + m.content.length, 0) +
      (allowsContinuation ? maxOutput : 0);
    const estimatedOutput = maxOutput * (allowsContinuation ? 2 : 1);
    return (estimatedInput * provider.capability.priceInputPer1k + estimatedOutput * provider.capability.priceOutputPer1k) / 1000;
  }

  private estimateCostsByTier(
    messages: ChatMessage[],
    requestedMaxTokens?: number,
  ): Partial<Record<ModelTier, number>> {
    const costs: Partial<Record<ModelTier, number>> = {};
    for (const tier of TIER_ORDER) {
      const provider = this.deps.registry.getAvailableByTier(tier);
      if (provider) costs[tier] = this.estimateCost(messages, provider, requestedMaxTokens);
    }
    return costs;
  }

  private estimateTokens(messages: ChatMessage[]): number {
    return messages.reduce((sum, m) => sum + m.content.length, 0);
  }

  private getMaxTokens(tier: ModelTier): number {
    const defaults: Record<ModelTier, number> = { tier1: 256, tier2: 512, tier3: 1024 };
    return defaults[tier];
  }

  private toGatewayResponse(
    response: ChatResponse,
    provider: ProviderType,
    cost: number,
    chain: CascadeStep[],
    totalLatency: number,
    confidenceOverride?: number,
  ): GatewayResponse {
    const lastStep = chain.length > 0 ? chain[chain.length - 1] : null;
    return {
      content: response.content,
      model: response.model,
      tokenInput: response.tokenInput,
      tokenOutput: response.tokenOutput,
      latencyMs: totalLatency > 0 ? totalLatency : response.latencyMs,
      cached: response.cached,
      truncated: response.truncated,
      finishReason: response.finishReason,
      confidence: confidenceOverride ?? lastStep?.confidence ?? 0.8,
      provider,
      costYuan: cost,
      cascadeChain: chain.length > 1 ? chain : undefined,
      toolCalls: response.toolCalls,
    };
  }

  private makeFallback(
    req: GatewayRequest,
    reason: string,
    failedProvider?: ProviderType,
  ): GatewayResponse {
    this.deps.logger.warn(
      { shopId: req.shopId, reason, provider: failedProvider ?? null },
      'ModelGateway 返回 fallback',
    );
    return {
      content: req.platformOverrides?.fallback_response ?? this.deps.config.deepseek.fallback_response,
      model: 'fallback',
      tokenInput: 0,
      tokenOutput: 0,
      latencyMs: 0,
      cached: false,
      truncated: false,
      confidence: 0,
      // 记录实际失败来源 provider，避免统计失真（无来源时用 deepseek 兼容旧值）
      provider: failedProvider ?? 'deepseek',
      costYuan: 0,
    };
  }
}
