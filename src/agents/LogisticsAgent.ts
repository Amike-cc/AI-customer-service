/**
 * 物流专家 Agent
 * 处理发货/快递/物流查询/运费等场景
 * preferredTier: tier2（轻量云端即可，物流信息相对固定）
 */
import { BaseAgent } from './BaseAgent';
import type { AgentContext, AgentCapability } from './types';
import type { ModelTier } from '../scheduler/types';
import type { ChatMessage } from '../deepseek/DeepSeekClient';

const LOGISTICS_KEYWORDS = [
  '发货', '物流', '快递', '什么时候到', '几天到',
  '运费', '包邮', '顺丰', '到了没', '查物流', '单号',
];

export class LogisticsAgent extends BaseAgent {
  readonly agentId = 'logistics';
  readonly capabilities: AgentCapability = {
    agentId: 'logistics',
    scenarios: ['logistics'],
    keywords: LOGISTICS_KEYWORDS,
    priority: 70,
    expectedTokenRange: { min: 100, max: 400 },
  };

  canHandle(ctx: AgentContext): boolean {
    if (ctx.scenario && this.capabilities.scenarios.includes(ctx.scenario)) {
      return true;
    }
    const text = ctx.userMessage.toLowerCase();
    return LOGISTICS_KEYWORDS.some((kw) => text.includes(kw));
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
      agentRole: 'logistics',
    });
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
    messages.push(...ctx.history);
    const userMsg: ChatMessage = { role: 'user', content: ctx.userMessage };
    if (ctx.images && ctx.images.length > 0) userMsg.images = ctx.images;
    messages.push(userMsg);
    return messages;
  }
}
