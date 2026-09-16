/**
 * 售后专家 Agent
 * 处理退货/退款/换货/投诉/维修等售后场景
 * preferredTier: tier3（需要主力模型处理复杂售后逻辑）
 */
import { BaseAgent } from './BaseAgent';
import type { AgentContext, AgentCapability } from './types';
import type { ModelTier } from '../scheduler/types';
import type { ChatMessage } from '../deepseek/DeepSeekClient';

const AFTER_SALES_KEYWORDS = [
  '退货', '退款', '换货', '维修', '投诉', '坏了', '破了',
  '质量问题', '不满意', '售后', '破损', '瑕疵', '补发',
];

export class AfterSalesAgent extends BaseAgent {
  readonly agentId = 'after_sales';
  readonly capabilities: AgentCapability = {
    agentId: 'after_sales',
    scenarios: ['after_sales'],
    keywords: AFTER_SALES_KEYWORDS,
    priority: 90,
    expectedTokenRange: { min: 200, max: 800 },
  };

  canHandle(ctx: AgentContext): boolean {
    if (ctx.scenario && this.capabilities.scenarios.includes(ctx.scenario)) {
      return true;
    }
    const text = ctx.userMessage.toLowerCase();
    return AFTER_SALES_KEYWORDS.some((kw) => text.includes(kw));
  }

  protected preferredTier(): ModelTier {
    return 'tier3';
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
      agentRole: 'after_sales',
    });
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
    messages.push(...ctx.history);
    const userMsg: ChatMessage = { role: 'user', content: ctx.userMessage };
    if (ctx.images && ctx.images.length > 0) userMsg.images = ctx.images;
    messages.push(userMsg);
    return messages;
  }
}
