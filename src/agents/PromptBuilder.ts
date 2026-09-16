/**
 * 动态 System Prompt 构建器
 *
 * 根据 shopName、platform、emotion、conversationPhase、agentRole 等上下文
 * 动态拼接 6 个模块的 system prompt：
 *   1. 角色设定
 *   2. 知识边界
 *   3. 回复规范
 *   4. 当前上下文
 *   5. 商品知识（可选）
 *   6. 特殊指令
 */
import type { EmotionLevel, ConversationPhase } from '../intent/types';

export type AgentRole = 'general' | 'product_expert' | 'logistics' | 'after_sales' | 'pre_sales';

export interface PromptBuildContext {
  shopName: string;
  platform: string;
  emotion: EmotionLevel;
  conversationPhase: ConversationPhase;
  contextSummary: string;
  productContext?: string;
  knowledgeContext?: string;
  agentRole: AgentRole;
  /** 买家画像字符串（由 BuyerProfileService.buildBuyerContext 生成，含【买家画像】section 头） */
  buyerProfile?: string;
}

/** Agent 角色描述映射 */
const AGENT_ROLE_DESCRIPTION: Record<AgentRole, string> = {
  general: '通用客服，处理日常咨询。不确定时引导客户联系对应专员',
  product_expert: '商品专家，详细解答尺码/材质/规格/参数，主动推荐合适商品',
  logistics: '物流专员，查询物流状态，处理发货/到货/签收问题',
  after_sales: '售后专员，处理退换货/维修/质量问题，提供明确流程指引',
  pre_sales: '售前专员，识别购买意向，主动推荐优惠与活动，引导客户完成下单',
};

/** 情绪 -> 语气映射 */
const EMOTION_TONE: Record<EmotionLevel, string> = {
  neutral: '专业友好，简洁直接',
  slightly_upset: '增加安抚语，"抱歉让您遇到这个问题"',
  angry: '先共情承认问题，"非常抱歉给您带来不好的体验，我理解您的心情"',
  anxious: '优先回应紧迫感，"我理解您比较着急，这边马上为您确认"',
};

/** 对话阶段中文描述 */
const PHASE_LABEL: Record<ConversationPhase, string> = {
  gathering: '信息收集',
  diagnosing: '问题诊断',
  proposing: '方案提出',
  confirming: '方案确认',
  closing: '结束总结',
};

/**
 * 对拼入 system prompt 的动态字段做统一清洗，防止买家通过注入伪造指令劫持行为：
 *  - 截断到安全长度，避免超长输入撑爆上下文
 *  - 移除控制字符
 *  - 剥离 <system> 等保留标记
 *  - 折叠多余换行（防止买家用 \n\n 伪造新 section 逃逸指令）
 */
function sanitizeForPrompt(input: unknown, maxLen = 1000): string {
  if (typeof input !== 'string') return '';
  return input
    .slice(0, maxLen)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/<\s*system\s*>/gi, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * 构建角色设定模块
 */
function buildRoleSection(ctx: PromptBuildContext): string {
  const roleDesc = AGENT_ROLE_DESCRIPTION[ctx.agentRole] ?? AGENT_ROLE_DESCRIPTION.general;
  const shopName = sanitizeForPrompt(ctx.shopName, 60);
  const platform = sanitizeForPrompt(ctx.platform, 30);
  return [
    '【角色设定】',
    `你是${shopName}的官方客服代表，负责${platform}平台的客户咨询。`,
    `当前角色：${roleDesc}。`,
  ].join('\n');
}

/**
 * 构建知识边界模块
 */
function buildKnowledgeBoundarySection(): string {
  return [
    '【知识边界】',
    '- 你只可以回答与本店铺商品、订单、售后、物流相关的问题。',
    '- 对于不确定的信息，请如实告知客户并承诺核实后回复，禁止编造任何事实。',
    '- 禁止讨论政治、宗教、竞品对比等敏感话题；禁止承诺超出店铺政策的能力。',
  ].join('\n');
}

/**
 * 构建回复规范模块
 */
function buildReplySpecSection(ctx: PromptBuildContext): string {
  const tone = EMOTION_TONE[ctx.emotion] ?? EMOTION_TONE.neutral;
  return [
    '【回复规范】',
    '- 回复字数控制在 50-200 字之间。',
    '- 仅输出纯文本，禁止使用 Markdown、HTML 或表情符号。',
    `- 语气要求：${tone}。`,
    '- 称呼客户统一使用"亲"或"您"，避免使用生硬的第二人称。',
  ].join('\n');
}

/**
 * 构建当前上下文模块
 */
function buildContextSection(ctx: PromptBuildContext): string {
  const contextSummary = sanitizeForPrompt(ctx.contextSummary, 500);
  return [
    '【当前上下文】',
    `- 对话阶段：${PHASE_LABEL[ctx.conversationPhase] ?? ctx.conversationPhase}`,
    `- 买家情绪：${ctx.emotion}`,
    `- 历史摘要：${contextSummary || '暂无'}`,
  ].join('\n');
}

/**
 * 构建买家画像模块（仅有画像且非空时输出）
 * 注：buyerProfile 字符串已由 BuyerProfileService.renderContext 生成含【买家画像】头部，
 *     本函数仅做非空判断与 trim，不重复包装。
 * 位置：在「当前上下文」之后、「商品知识」之前（先认人再讲货）
 */
function buildBuyerProfileSection(ctx: PromptBuildContext): string | null {
  const buyerProfile = sanitizeForPrompt(ctx.buyerProfile, 1000);
  if (!buyerProfile) {
    return null;
  }
  return buyerProfile;
}

/**
 * 构建商品知识模块（仅在有商品/知识上下文时输出）
 */
function buildProductKnowledgeSection(ctx: PromptBuildContext): string | null {
  const parts: string[] = ['【商品知识】'];
  let hasContent = false;
  if (ctx.productContext && ctx.productContext.trim().length > 0) {
    parts.push(`- 商品信息：${sanitizeForPrompt(ctx.productContext, 1000)}`);
    hasContent = true;
  }
  if (ctx.knowledgeContext && ctx.knowledgeContext.trim().length > 0) {
    parts.push(`- 知识库：${sanitizeForPrompt(ctx.knowledgeContext, 1000)}`);
    hasContent = true;
  }
  return hasContent ? parts.join('\n') : null;
}

/**
 * 构建特殊指令模块（根据情绪与角色动态注入）
 */
function buildSpecialInstructionsSection(ctx: PromptBuildContext): string {
  const instructions: string[] = ['【特殊指令】'];

  // 买家标签/备注指令（让 AI 像真人客服一样记录买家特征）
  instructions.push(
    '- 识别到买家的明确特征时，在回复末尾附加标记（系统会自动剥离，买家看不到）：',
    '  · 偏好标签：[BUYER_TAG:标签1,标签2]（如 [BUYER_TAG:偏好XXL,偏好红色,价格敏感]）',
    '  · 备注说明：[BUYER_REMARK:自由文本]（如 [BUYER_REMARK:上周投诉过物流慢，已安抚]）',
    '- 何时附加：买家明确表达尺码/颜色/品类偏好、价格敏感、特殊需求、投诉历史等',
    '- 何时不附加：普通问候、闲聊、AI 不确定买家特征时（宁缺毋滥）',
    '- 标签要求：每个≤10字、简短具体（如"偏好XXL"而非"喜欢大码"），多个用英文逗号分隔',
    '- 备注要求：≤200字、客观事实描述，会覆盖之前的备注',
  );

  // 智能路由转接指导
  instructions.push(
    '- 转人工时优先指定专员角色（agent_role 参数），系统会自动在飞鸽页面执行转接到对应客服：',
    '  · after_sales 售后专员：退货退款、商品质量问题、损坏补发、投诉纠纷',
    '  · logistics 物流专员：快递查询、催发货、改地址、物流异常、签收问题',
    '  · pre_sales 售前专员：商品咨询、尺码推荐、活动优惠、库存查询',
    '  · general 通用客服：复杂问题、跨类目问题、AI 无法判断的混合问题',
    '- 选择原则：能明确分类的优先指定对应专员；模糊不清用 general',
    '- 调用 transfer_to_human 工具后，仍需生成回复告知买家已转接（如"已为您转接售后专员，请稍候"）',
  );

  // 情绪相关指令
  switch (ctx.emotion) {
    case 'angry':
      instructions.push('- 客户情绪激动，必须先共情承认问题，使用"非常抱歉"等表达，再处理具体问题。');
      break;
    case 'anxious':
      instructions.push('- 客户情绪焦急，优先回应紧迫感，使用"马上为您处理"等表达，加快响应节奏。');
      break;
    case 'slightly_upset':
      instructions.push('- 客户略有不满，需在回复中加入安抚语，例如"抱歉让您遇到这个问题"。');
      break;
    case 'neutral':
    default:
      instructions.push('- 客户情绪平稳，保持专业友好的态度直接解决问题。');
      break;
  }

  // 角色相关指令
  switch (ctx.agentRole) {
    case 'after_sales':
      instructions.push('- 涉及退款/投诉时，请给出明确流程指引（申请路径、时效、所需凭证）。');
      break;
    case 'product_expert':
      instructions.push('- 客户表达购买意向时，主动推荐合适规格/型号，促进转化。');
      break;
    case 'pre_sales':
      instructions.push(
        '- 你是售前咨询专员：',
        '  1. 主动识别购买意向，引导客户完成下单。',
        '  2. 熟悉当前活动、优惠券、新人权益，主动告知客户可享优惠。',
        '  3. 帮客户做商品对比，给出明确推荐理由（不要含糊"都很好"）。',
        '  4. 客户犹豫时，可使用限时优惠/库存紧张等促单话术，但不得虚构信息。',
        '  5. 不确定当前活动详情时，引导客户联系人工确认，禁止编造优惠信息。',
        '  6. 促单完成后，主动告知支付方式与发货时间。',
      );
      break;
    default:
      instructions.push('- 涉及退款/投诉时给出明确流程指引；客户有购买意向时主动促进转化。');
      break;
  }

  return instructions.join('\n');
}

/**
 * PromptBuilder 类（供 Agent 通过依赖注入使用）
 */
export class PromptBuilder {
  build(ctx: PromptBuildContext): string {
    return buildSystemPrompt(ctx);
  }
}

/**
 * 根据上下文构建完整 system prompt
 */
export function buildSystemPrompt(ctx: PromptBuildContext): string {
  const sections: string[] = [
    buildRoleSection(ctx),
    buildKnowledgeBoundarySection(),
    buildReplySpecSection(ctx),
    buildContextSection(ctx),
  ];

  // 买家画像（先认人再讲货）
  const buyerProfileSection = buildBuyerProfileSection(ctx);
  if (buyerProfileSection) {
    sections.push(buyerProfileSection);
  }

  const productKnowledge = buildProductKnowledgeSection(ctx);
  if (productKnowledge) {
    sections.push(productKnowledge);
  }

  sections.push(buildSpecialInstructionsSection(ctx));

  return sections.join('\n\n');
}
