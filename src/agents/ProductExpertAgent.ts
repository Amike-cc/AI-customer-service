/**
 * 商品专家 Agent
 * 处理商品对比/推荐/尺码/规格等场景
 * preferredTier: tier3（需要商品知识推理）
 */
import { BaseAgent } from './BaseAgent';
import type { AgentContext, AgentCapability } from './types';
import type { ModelTier } from '../scheduler/types';
import type { ChatMessage } from '../deepseek/DeepSeekClient';

const PRODUCT_KEYWORDS = [
  '对比', '区别', '差异', '哪个好', '推荐', '哪款',
  '尺码', '尺寸', '多大', '多大码', '推荐码数', 'XL', 'L码', 'M码',
  '材质', '成分', '规格', '参数', '适合',
];

export class ProductExpertAgent extends BaseAgent {
  readonly agentId = 'product_expert';
  readonly capabilities: AgentCapability = {
    agentId: 'product_expert',
    scenarios: ['product_comparison', 'sizing'],
    keywords: PRODUCT_KEYWORDS,
    priority: 80,
    expectedTokenRange: { min: 200, max: 1000 },
  };

  canHandle(ctx: AgentContext): boolean {
    if (ctx.scenario && this.capabilities.scenarios.includes(ctx.scenario)) {
      return true;
    }
    const text = ctx.userMessage.toLowerCase();
    return PRODUCT_KEYWORDS.some((kw) => text.includes(kw));
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
      agentRole: 'product_expert',
    });
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
    messages.push(...ctx.history);
    const userMsg: ChatMessage = { role: 'user', content: ctx.userMessage };
    if (ctx.images && ctx.images.length > 0) userMsg.images = ctx.images;
    messages.push(userMsg);
    return messages;
  }
}
