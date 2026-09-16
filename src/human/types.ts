export type AgentStatus = 'available' | 'busy' | 'offline';

export interface HumanAgent {
  id: string;
  shopId: string;
  name: string;
  status: AgentStatus;
  activeChats: number;
  maxChats: number;
  skills: string[];
  lastAssignedAt?: number;
  detectedAt: number;
  updatedAt: number;
}

export type QueuePriority = 'low' | 'medium' | 'high' | 'urgent';

export interface QueueEntry {
  escalationId: number;
  shopId: string;
  sessionId: string;
  priority: QueuePriority;
  reason: string;
  requiredSkills: string[];
  enqueuedAt: number;
  estimatedWaitMs: number;
}

export interface AgentRepoRecord {
  id: string;
  shopId: string;
  name: string;
  status: AgentStatus;
  activeChats: number;
  maxChats: number;
  skills: string[];
  lastAssignedAt?: number;
  detectedAt: number;
  updatedAt: number;
}
