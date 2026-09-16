/**
 * 模型 Provider 接口
 * 所有 Provider 实现此接口，ModelGateway 通过此接口调用
 */
import type { ChatResponse } from '../../deepseek/DeepSeekClient';
import type { ProviderCapability, ProviderChatRequest } from '../types';

export interface IModelProvider {
  readonly provider: import('../types').ProviderType;
  readonly tier: import('../../scheduler/types').ModelTier;
  readonly capability: ProviderCapability;

  chat(req: ProviderChatRequest): Promise<ChatResponse>;
  healthCheck(): Promise<boolean>;
  updateConfig(config: unknown): void;
}
