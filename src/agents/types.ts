/**
 * Agent 公共类型定义
 */
import type { ChatMessage, PlatformOverrides } from '../deepseek/DeepSeekClient';
import type { CascadeStep } from '../gateway/types';
import type { EmotionLevel, ConversationPhase } from '../intent/types';
import type { ToolRegistry } from '../tools/ToolRegistry';
import type { ToolContext } from '../tools/types';

export interface AgentContext {
  shopId: string;
  sessionId: string;
  productId?: string;
  scenario?: string;
  productContext?: string;
  history: ChatMessage[];
  userMessage: string;
  knowledgeContext?: string;
  emotion?: EmotionLevel;
  conversationPhase?: ConversationPhase;
  contextSummary?: string;
  shopName?: string;
  platform?: string;
  /** 平台级别参数覆盖（优先于全局配置） */
  platformOverrides?: PlatformOverrides;
  /** 买家画像字符串（由 BuyerProfileService.buildBuyerContext 生成，含【买家画像】section 头） */
  buyerContext?: string;
  /** Function calling 工具注册中心（存在时 Agent 可执行业务动作） */
  toolRegistry?: ToolRegistry;
  /** 工具执行上下文（shopId/sessionId/productMatcher/db/转人工回调） */
  toolContext?: ToolContext;
  /** 买家发送的图片 URL 列表（用于多模态 LLM 理解图片内容，DeepSeek V4 Vision） */
  images?: string[];
}

export interface AgentResult {
  content: string;
  agentId: string;
  model: string;
  tokenInput: number;
  tokenOutput: number;
  latencyMs: number;
  confidence: number;
  truncated: boolean;
  cached: boolean;
  cascadeChain?: CascadeStep[];
}

export interface AgentCapability {
  agentId: string;
  scenarios: string[];
  keywords: string[];
  priority: number;
  expectedTokenRange: { min: number; max: number };
}

export interface IAgent {
  readonly agentId: string;
  readonly capabilities: AgentCapability;
  canHandle(ctx: AgentContext): boolean;
  execute(ctx: AgentContext): Promise<AgentResult>;
}
