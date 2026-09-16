import type { ChatMessage } from '../deepseek/DeepSeekClient';

export type IntentCategory =
  | 'greeting'
  | 'product_inquiry'
  | 'purchase_intent'
  | 'after_sales'
  | 'logistics'
  | 'complaint'
  | 'human_request'
  | 'faq'
  | 'chitchat'
  | 'unknown';

export interface IntentEntity {
  type: string;
  value: string;
}

export interface IntentResult {
  category: IntentCategory;
  confidence: number;
  entities: IntentEntity[];
  subIntent?: string;
}

export type ComplexityLevel = 'simple' | 'moderate' | 'complex';

export interface ComplexityResult {
  level: ComplexityLevel;
  score: number;
  reasons: string[];
  shouldEscalate: boolean;
}

export type EscalationPriority = 'low' | 'medium' | 'high' | 'urgent';
export type EscalationStatus = 'pending' | 'assigned' | 'resolved' | 'expired';

export interface EscalationRecord {
  id: number;
  shopId: string;
  sessionId: string;
  auditId?: number;
  reason: string;
  priority: EscalationPriority;
  status: EscalationStatus;
  assignedAgentId?: string;
  requiredSkills: string[];
  createdAt: number;
  assignedAt?: number;
  resolvedAt?: number;
  resolution?: string;
}

export interface EscalationInput {
  shopId: string;
  sessionId: string;
  auditId?: number;
  reason: string;
  priority: EscalationPriority;
  requiredSkills?: string[];
}

/** 情绪等级 */
export type EmotionLevel = 'neutral' | 'slightly_upset' | 'angry' | 'anxious';

/** 对话阶段 */
export type ConversationPhase = 'gathering' | 'diagnosing' | 'proposing' | 'confirming' | 'closing';

/** LLM 增强意图识别结果 */
export interface EnhancedIntentResult {
  intent: IntentResult;
  entities: IntentEntity[];
  emotion: EmotionLevel;
}

export type { ChatMessage };
