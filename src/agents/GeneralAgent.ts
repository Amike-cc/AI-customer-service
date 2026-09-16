/**
 * 通用 Agent（兜底）
 * 处理所有其他 Agent 未匹配的消息
 * preferredTier: tier2（标准对话能力即可）
 */
import { BaseAgent } from './BaseAgent';
import type { AgentContext, AgentCapability } from './types';
import type { ModelTier } from '../scheduler/types';
import type { ChatMessage } from '../deepseek/DeepSeekClient';

export class GeneralAgent extends BaseAgent {
  readonly agentId = 'general';
  readonly capabilities: AgentCapability = {
    agentId: 'general',
    scenarios: ['general'],
    keywords: [],
    priority: 50,
    expectedTokenRange: { min: 100, max: 600 },
  };

  canHandle(_ctx: AgentContext): boolean {
    return true;
  }

  protected preferredTier(): ModelTier {
    return 'tier2';
  }

  protected buildMessages(ctx: AgentContext): ChatMessage[] {
    const systemPrompt = this.promptBuilder.build({
      shopName: ctx.shopName ?? '店铺',
      platform: ctx.platform ?? '电商平台',
      emotion: ctx.emotion ?? 'neutral',
      conversationPhase: ctx.conversationPhase ?? 'gathering',
      contextSummary: ctx.contextSummary ?? '',
      productContext: ctx.productContext,
      knowledgeContext: ctx.knowledgeContext,
      buyerProfile: ctx.buyerContext,
      agentRole: 'general',
    });
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
    messages.push(...ctx.history);
    const userMsg: ChatMessage = { role: 'user', content: ctx.userMessage };
    if (ctx.images && ctx.images.length > 0) userMsg.images = ctx.images;
    messages.push(userMsg);
    return messages;
  }
}
