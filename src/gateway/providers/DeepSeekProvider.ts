/**
 * DeepSeek Provider — 适配现有 DeepSeekClient
 * 不修改 DeepSeekClient 本身，通过适配器模式包装
 */
import type { IModelProvider } from './IModelProvider';
import type { DeepSeekClient, ChatResponse } from '../../deepseek/DeepSeekClient';
import type { ProviderCapability, ProviderChatRequest, ProviderType } from '../types';
import type { ModelTier } from '../../scheduler/types';
import type { Config } from '../../config/schema';

export class DeepSeekProvider implements IModelProvider {
  readonly provider: ProviderType = 'deepseek';
  private currentTier: ModelTier;
  private currentConfig: Config;

  constructor(
    private client: DeepSeekClient,
    config: Config,
    tier: ModelTier = 'tier3',
  ) {
    this.currentConfig = config;
    this.currentTier = tier;
  }

  get tier(): ModelTier {
    return this.currentTier;
  }

  get capability(): ProviderCapability {
    // 动态读取熔断器状态：open 时标记为不可用，让 ModelRegistry.getAvailableByTier 跳过 DeepSeek
    // half-open 状态视为可用，让请求尝试恢复熔断器
    const circuit = this.client.getCircuitState();
    return {
      provider: 'deepseek',
      tier: this.tier,
      model: this.currentConfig.deepseek.model,
      priceInputPer1k: 0.00027,
      priceOutputPer1k: 0.0011,
      avgLatencyMs: 2000,
      maxContextTokens: 65536,
      available: this.client.currentApiKey.trim().length > 0 && circuit.state !== 'open',
    };
  }

  async chat(req: ProviderChatRequest): Promise<ChatResponse> {
    // 把 req.maxTokens/temperature 合并到 platformOverrides 末位（platformOverrides 优先级更高）
    // 让"轻量调用"（意图识别 max_tokens=200、情绪检测 max_tokens=10）能精确控制 DeepSeek 输出
    const mergedOverrides = {
      ...req.platformOverrides,
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };
    return this.client.chatWithContinuation({
      shopId: req.shopId,
      sessionId: req.sessionId,
      messages: req.messages,
      productId: req.productId,
      scenario: req.scenario,
      platformOverrides: mergedOverrides,
      tools: req.tools,
      tool_choice: req.tool_choice,
    });
  }

  async healthCheck(): Promise<boolean> {
    // 健康检查 = 熔断器未开启
    const circuit = this.client.getCircuitState();
    return this.client.currentApiKey.trim().length > 0 && circuit.state !== 'open';
  }

  updateConfig(config: Config): void {
    this.currentConfig = config;
    this.currentTier = config.gateway.providers.deepseek.tier;
    this.client.updateConfig(config);
  }
}
