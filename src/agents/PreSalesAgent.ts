/**
 * 售前咨询 Agent
 * 专注商品咨询、购买意向识别、优惠券/活动引导，提升转化率
 *
 * preferredTier: tier3（需要商品知识与销售话术推理）
 * 触发场景：pre_sales / purchase_intent / coupon_inquiry / promotion
 */
import { BaseAgent } from './BaseAgent';
import type { AgentContext, AgentCapability } from './types';
import type { ModelTier } from '../scheduler/types';
import type { ChatMessage } from '../deepseek/DeepSeekClient';

/** 售前咨询关键词列表（与 capabilities.keywords 一致，便于 canHandle 快速匹配） */
const PRE_SALES_KEYWORDS = [
  // 注意：不含单字"买"（"买贵了""退货款怎么买"等场景会误命中），使用多字组合词
  '下单', '付款', '怎么买', '购买',
  '优惠', '折扣', '活动', '券', '满减',
  '便宜', '推荐', '新人', '首单', '领券',
  '现在买', '马上买', '拍下', '现货', '想买', '要买', '多少钱',
];

export class PreSalesAgent extends BaseAgent {
  readonly agentId = 'pre_sales';
  readonly capabilities: AgentCapability = {
    agentId: 'pre_sales',
    scenarios: ['pre_sales', 'purchase_intent', 'coupon_inquiry', 'promotion'],
    keywords: PRE_SALES_KEYWORDS,
    priority: 60,
    expectedTokenRange: { min: 200, max: 600 },
  };

  canHandle(ctx: AgentContext): boolean {
    // 场景精确匹配
    if (ctx.scenario && this.capabilities.scenarios.includes(ctx.scenario)) {
      return true;
    }
    // 关键词匹配
    const text = ctx.userMessage.toLowerCase();
    return PRE_SALES_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()));
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
      agentRole: 'pre_sales',
    });
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
    messages.push(...ctx.history);
    const userMsg: ChatMessage = { role: 'user', content: ctx.userMessage };
    if (ctx.images && ctx.images.length > 0) userMsg.images = ctx.images;
    messages.push(userMsg);
    return messages;
  }
}
